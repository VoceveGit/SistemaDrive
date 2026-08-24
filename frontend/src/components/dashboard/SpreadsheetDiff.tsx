// frontend/src/components/dashboard/SpreadsheetDiff.tsx

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, RefreshCw, Send } from "lucide-react";
import { api, type DiffResult, type DiffRow, type SendReport } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";

type SpreadsheetDiffProps = {
  spreadsheetId: string;
  status: string;
  companyId: string;
};

const PAGE_SIZE = 300;

type PagePayload = DiffResult & { success: boolean };

function emptyMeta(partial?: Partial<DiffResult>): DiffResult {
  return {
    headers: [],
    rows: [],
    summary: {
      totalRows: 0,
      newRows: 0,
      previousRows: 0,
      alreadyInDb: 0,
      mustSend: 0,
      mustUpdate: 0,
    },
    dbWindowDays: 0,
    dateColumnUsed: null,
    compareColumnUsed: null,
    dbCompareLimit: null,
    dbCompareMode: "skipped",
    dbCheckSkipped: false,
    skippedColumns: [],
    dbRowsLoaded: 0,
    ...partial,
  };
}

export function SpreadsheetDiff({ spreadsheetId, status, companyId }: SpreadsheetDiffProps) {
  const queryClient = useQueryClient();
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [lastReport, setLastReport] = useState<SendReport | null>(null);

  const [meta, setMeta] = useState<DiffResult>(() => emptyMeta());
  const [rows, setRows] = useState<DiffRow[]>([]);
  const [jobTotal, setJobTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const cancelRef = useRef(false);

  const loadAllPages = useCallback(async () => {
    cancelRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setRows([]);
    setSelectedRows([]);
    setSelectMode(false);

    let offset = 0;
    let accumulated: DiffRow[] = [];
    let firstMeta: DiffResult | null = null;
    let total = 0;

    try {
      for (;;) {
        if (cancelRef.current) break;

        if (offset > 0) setLoadingMore(true);

        const page = await api<PagePayload>(
          `/spreadsheets/${spreadsheetId}/diff?offset=${offset}&limit=${PAGE_SIZE}`,
        );

        if (cancelRef.current) break;

        if (!firstMeta) {
          firstMeta = page;
          setMeta(page);
          total = page.pagination?.total ?? page.summary.jobTotalRows ?? page.summary.totalRows;
          setJobTotal(total);
        }

        // Snapshot de solução codada (clientes): só resumo
        if (page.codedSolution && page.snapshot) {
          setRows([]);
          setJobTotal(page.snapshot.insertedRowCount);
          break;
        }

        // Preview codado (pedidos/faturamento): pagina linhas tratadas
        if (page.codedSolution && page.codedSummary) {
          accumulated = [...accumulated, ...page.rows];
          setRows(accumulated);
          setJobTotal(page.pagination?.total ?? page.summary.jobTotalRows ?? accumulated.length);
          const hasMore = Boolean(page.pagination?.hasMore);
          const next = page.pagination?.nextOffset;
          if (!hasMore || next == null || page.rows.length === 0) break;
          offset = next;
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }

        accumulated = [...accumulated, ...page.rows];
        setRows(accumulated);
        setJobTotal(page.pagination?.total ?? total);

        const hasMore = Boolean(page.pagination?.hasMore);
        const next = page.pagination?.nextOffset;
        if (!hasMore || next == null || page.rows.length === 0) break;

        offset = next;
        // Pequena pausa para não saturar o Render Free
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch (e) {
      if (!cancelRef.current) {
        setError(e instanceof Error ? e.message : "Erro ao carregar comparativo");
      }
    } finally {
      if (!cancelRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [spreadsheetId]);

  useEffect(() => {
    cancelRef.current = false;
    void loadAllPages();
    return () => {
      cancelRef.current = true;
    };
  }, [loadAllPages, reloadKey]);

  const summary = useMemo(() => {
    const mustSend = rows.filter((r) => r.mustSend).length;
    const mustUpdate = rows.filter((r) => r.mustUpdate).length;
    const alreadyInDb = rows.filter((r) => !r.isNewInDb && !r.isUpdated).length;
    const newRows = rows.filter((r) => r.isNew).length;
    return {
      totalRows: rows.length,
      newRows,
      previousRows: meta.summary.previousRows,
      alreadyInDb,
      mustSend,
      mustUpdate,
      jobTotalRows: jobTotal || rows.length,
    };
  }, [rows, meta.summary.previousRows, jobTotal]);

  const invalidateAfterSend = () => {
    queryClient.invalidateQueries({ queryKey: ["spreadsheets", companyId] });
    queryClient.invalidateQueries({ queryKey: ["companies"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    setSelectedRows([]);
    setSelectMode(false);
    setReloadKey((k) => k + 1);
  };

  const approveMutation = useMutation({
    mutationFn: () => api(`/spreadsheets/${spreadsheetId}/approve`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Planilha aprovada");
      queryClient.invalidateQueries({ queryKey: ["spreadsheets", companyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSendSuccess = (res: {
    insertedCount?: number;
    completed?: boolean;
    report?: SendReport;
  }) => {
    if (res.report) setLastReport(res.report);
    const n = res.insertedCount ?? res.report?.insertedCount ?? 0;
    if (n <= 0 && !res.completed) {
      toast.error("Nada foi inserido no MySQL — confira o mapeamento/logs");
    } else if (res.completed) {
      toast.success(`Concluído: ${n} linha(s) no destino`);
    } else {
      toast.success(`${n} linha(s) inserida(s) no MySQL`);
    }
    invalidateAfterSend();
  };

  const sendAllMutation = useMutation({
    mutationFn: () =>
      api<{ insertedCount?: number; completed?: boolean; report?: SendReport }>(
        `/spreadsheets/${spreadsheetId}/send`,
        { method: "POST" },
      ),
    onSuccess: handleSendSuccess,
    onError: (e: Error) => toast.error(e.message),
  });

  const sendOneMutation = useMutation({
    mutationFn: () => {
      const first = rows.find((r) => r.mustSend);
      if (!first) {
        return Promise.reject(
          new Error(
            loadingMore
              ? "Aguarde o carregamento terminar para enviar"
              : "Nenhuma linha NOVA na tela para enviar",
          ),
        );
      }
      return api<{ insertedCount?: number; completed?: boolean; report?: SendReport }>(
        `/spreadsheets/${spreadsheetId}/send-test`,
        {
          method: "POST",
          body: JSON.stringify({ mode: "pick", selectedData: [first.data] }),
        },
      );
    },
    onSuccess: handleSendSuccess,
    onError: (e: Error) => toast.error(e.message),
  });

  const sendSelectedMutation = useMutation({
    mutationFn: () => {
      if (selectedRows.length === 0) {
        return Promise.reject(
          new Error("Marque os quadradinhos nas linhas NOVO antes de enviar"),
        );
      }
      const mustSendRows = rows.filter((r) => r.mustSend);
      const selectedData = selectedRows
        .filter((i) => i >= 0 && i < mustSendRows.length)
        .map((i) => mustSendRows[i].data)
        .filter((r) => Array.isArray(r) && r.length > 0);
      if (selectedData.length === 0) {
        return Promise.reject(new Error("Nenhuma linha NOVA marcada — use os checkboxes"));
      }
      return api<{ insertedCount?: number; completed?: boolean; report?: SendReport }>(
        `/spreadsheets/${spreadsheetId}/send-test`,
        {
          method: "POST",
          body: JSON.stringify({ mode: "pick", selectedData }),
        },
      );
    },
    onSuccess: handleSendSuccess,
    onError: (e: Error) => toast.error(e.message),
  });

  if (loading && rows.length === 0) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-text-secondary">
        <Loader2 size={16} className="animate-spin" />
        Carregando comparativo (lotes de {PAGE_SIZE})…
      </p>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div className="p-4 text-sm text-accent-red">
        {error}{" "}
        <button type="button" className="underline" onClick={() => setReloadKey((k) => k + 1)}>
          Tentar de novo
        </button>
      </div>
    );
  }

  const diff = meta;
  const snapshot = diff.snapshot;
  const codedSummary = diff.codedSummary;
  let mustSendCounter = -1;
  const canSend =
    (codedSummary
      ? (codedSummary.mode === "faturamento"
          ? (codedSummary.numerosNovos ?? 0)
          : (codedSummary.rowsToInsert ?? 0)) > 0
      : summary.mustSend > 0 || (summary.mustUpdate ?? 0) > 0) && status !== "sent";
  const sending =
    sendAllMutation.isPending || sendOneMutation.isPending || sendSelectedMutation.isPending;
  const progressPct =
    jobTotal > 0 ? Math.min(100, Math.round((rows.length / jobTotal) * 100)) : 100;

  function handleEnviarSelecionados() {
    if (!selectMode) {
      setSelectMode(true);
      toast.message("Marque as linhas na tabela e clique de novo em Enviar selecionados");
      return;
    }
    if (selectedRows.length === 0) {
      toast.error("Marque ao menos uma linha");
      return;
    }
    sendSelectedMutation.mutate();
  }

  if (diff.codedSolution && snapshot) {
    return (
      <div className="min-w-0 max-w-full border-t border-border bg-bg-surface p-4">
        <div className="rounded-xl border border-accent-green/30 bg-accent-green/10 p-6">
          <h3 className="text-base font-semibold text-text-primary">
            Snapshot — {snapshot.codedSolutionId}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{snapshot.note}</p>
          <ul className="mt-4 space-y-2 text-sm text-text-secondary">
            <li>
              Tabela:{" "}
              <strong className="font-mono text-text-primary">{snapshot.targetTable}</strong>
            </li>
            <li>
              Antes do envio:{" "}
              <strong className="text-text-primary">
                {formatNumber(snapshot.previousRowCount)}
              </strong>{" "}
              registros
            </li>
            <li>
              Gravados agora:{" "}
              <strong className="text-accent-green">
                {formatNumber(snapshot.insertedRowCount)}
              </strong>{" "}
              registros
            </li>
            <li>
              Depois do envio:{" "}
              <strong className="text-text-primary">
                {formatNumber(snapshot.finalRowCount)}
              </strong>{" "}
              registros
            </li>
          </ul>
          <p className="mt-4 text-xs text-text-muted">
            Modo snapshot: a tabela foi substituída por completo (espelho + transação). Não há
            lista linha a linha.
          </p>
        </div>
      </div>
    );
  }

  const codedSummaryPanel =
    codedSummary && diff.codedSolution ? (
      <div className="mb-4 rounded-xl border border-accent-blue/30 bg-accent-blue/10 p-4 text-sm">
        <h3 className="font-semibold text-text-primary">
          Preview tratado — {codedSummary.codedSolutionId}
        </h3>
        <p className="mt-1 text-text-secondary">{codedSummary.note}</p>
        <ul className="mt-3 grid gap-1 text-xs text-text-secondary sm:grid-cols-2">
          <li>
            Linhas lidas:{" "}
            <strong className="text-text-primary">{formatNumber(codedSummary.linesRead)}</strong>
          </li>
          <li>
            Válidas (preview):{" "}
            <strong className="text-text-primary">{formatNumber(codedSummary.validRows)}</strong>
          </li>
          <li>
            Ignoradas:{" "}
            <strong className="text-accent-amber">
              {formatNumber(codedSummary.ignoredRows)}
            </strong>
          </li>
          {codedSummary.mode === "pedidos" && (
            <>
              <li>
                Pedidos no arquivo:{" "}
                <strong>{formatNumber(codedSummary.pedidosInFile ?? 0)}</strong>
              </li>
              <li>
                Linhas a inserir:{" "}
                <strong className="text-accent-green">
                  {formatNumber(codedSummary.rowsToInsert ?? 0)}
                </strong>
              </li>
              {(codedSummary.monthFrom || codedSummary.monthToExclusive) && (
                <li className="sm:col-span-2">
                  Janela (apaga e reinsere):{" "}
                  <strong className="font-mono text-text-primary">
                    {codedSummary.monthFrom} ≤ Dt.Entrega &lt;{" "}
                    {codedSummary.monthToExclusive}
                  </strong>
                </li>
              )}
            </>
          )}
          {codedSummary.mode === "faturamento" && (
            <>
              <li>
                Números novos:{" "}
                <strong className="text-accent-green">
                  {formatNumber(codedSummary.numerosNovos ?? 0)}
                </strong>
              </li>
              <li>
                Já no banco:{" "}
                <strong>{formatNumber(codedSummary.numerosExistentes ?? 0)}</strong>
              </li>
              <li>
                Ignoradas (resumo):{" "}
                <strong>{formatNumber(codedSummary.ignoredResumo ?? 0)}</strong>
              </li>
              <li>
                Ignoradas (sem numero):{" "}
                <strong>{formatNumber(codedSummary.ignoredNoNumero ?? 0)}</strong>
              </li>
            </>
          )}
        </ul>
        {diff.truncated && (
          <p className="mt-2 text-xs text-text-muted">
            Tabela abaixo: amostra das primeiras linhas tratadas (como vão pro MySQL).
          </p>
        )}
      </div>
    ) : null;

  return (
    <div className="min-w-0 max-w-full border-t border-border bg-bg-surface p-4">
      {codedSummaryPanel}
      {(loadingMore || (loading && rows.length > 0)) && (
        <div className="mb-4 rounded-lg border border-accent-blue/30 bg-accent-blue/10 px-4 py-3 text-sm text-text-primary">
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin text-accent-blue" />
            <span>
              Carregando automaticamente…{" "}
              <strong className="font-mono">
                {formatNumber(rows.length)} / {formatNumber(jobTotal || rows.length)}
              </strong>{" "}
              ({progressPct}%)
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-card">
            <div
              className="h-full rounded-full bg-accent-blue transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {!loading && !loadingMore && jobTotal > 0 && (
        <p className="mb-3 text-xs text-text-secondary">
          Comparativo completo: {formatNumber(rows.length)} de {formatNumber(jobTotal)} linhas
          (carregadas em lotes de {PAGE_SIZE}).
        </p>
      )}

      {diff.dbCheckSkipped && !diff.codedSolution ? (
        <div className="mb-4 rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
          Não foi possível comparar com o banco — verifique a conexão e a tabela da empresa.
        </div>
      ) : diff.dbCompareMode === "last_records" ? (
        <div className="mb-4 rounded-lg border border-border bg-bg-card px-4 py-2 text-xs text-text-secondary">
          Comparando com janela de últimos registros do banco (modo last_records).
        </div>
      ) : null}

      {diff.skippedColumns.length > 0 && (
        <div className="mb-4 rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-4 py-2 text-xs text-accent-amber">
          Colunas da planilha sem correspondência na tabela:{" "}
          <span className="font-mono">{diff.skippedColumns.join(", ")}</span>
        </div>
      )}

      {lastReport && (
        <div className="mb-4 rounded-lg border border-border bg-bg-card p-4 text-sm">
          <p className="mb-2 font-medium text-text-primary">Resumo do envio</p>
          <ul className="space-y-1 text-xs text-text-secondary">
            <li>
              Linhas na planilha:{" "}
              <strong className="text-text-primary">{lastReport.spreadsheetRows}</strong>
            </li>
            <li>
              Inseridas agora:{" "}
              <strong className="text-accent-green">{lastReport.insertedCount}</strong>
            </li>
            {(lastReport.updatedCount ?? 0) > 0 && (
              <li>
                Atualizadas:{" "}
                <strong className="text-orange-400">{lastReport.updatedCount}</strong>
              </li>
            )}
            <li>
              Já no banco:{" "}
              <strong className="text-accent-amber">{lastReport.alreadyInDb}</strong>
            </li>
            <li>
              Ainda pendentes:{" "}
              <strong className="text-text-primary">{lastReport.mustSendRemaining}</strong>
            </li>
            <li>
              Total na tabela destino:{" "}
              <strong className="text-text-primary">{lastReport.dbTableRowCount ?? "—"}</strong>
            </li>
            {lastReport.completed && (
              <li className="text-accent-green">Planilha concluída — espelho sincronizado</li>
            )}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {codedSummary ? (
          codedSummary.mode === "pedidos" ? (
            <>
              <Chip
                color="green"
                label={`${formatNumber(codedSummary.rowsToInsert ?? 0)} na janela (reinserir)`}
              />
              <Chip
                color="amber"
                label={`${formatNumber(codedSummary.ignoredRows)} ignoradas`}
              />
            </>
          ) : (
            <>
              <Chip
                color="green"
                label={`${formatNumber(codedSummary.numerosNovos ?? 0)} números novos`}
              />
              <Chip
                color="amber"
                label={`${formatNumber(codedSummary.numerosExistentes ?? 0)} já no banco`}
              />
            </>
          )
        ) : (
          <>
            <Chip color="green" label={`${formatNumber(summary.mustSend)} para enviar`} />
            <Chip color="amber" label={`${formatNumber(summary.mustUpdate ?? 0)} atualizar`} />
            <Chip color="amber" label={`${formatNumber(summary.alreadyInDb)} já no banco`} />
            <Chip
              color="neutral"
              label={`${formatNumber(summary.totalRows - summary.newRows)} sem alteração`}
            />
          </>
        )}

        <button
          type="button"
          onClick={() => {
            setReloadKey((k) => k + 1);
            toast.message("Recarregando comparativo em lotes…");
          }}
          disabled={loading || loadingMore}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-bg-card disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading || loadingMore ? "animate-spin" : ""} />
          Analisar dados
        </button>

        {status === "pending" && (
          <button
            type="button"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending || loadingMore}
            className="ml-auto flex items-center gap-2 rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Check size={16} /> Aprovar
          </button>
        )}
      </div>

      {(diff.staging || diff.truncated) && (
        <div className="mb-4 rounded-lg border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-text-primary">
          <p className="font-medium text-accent-amber">
            {diff.staging
              ? "Tabela job — nada foi enviado ao destino ainda"
              : "Preview — validação na tela"}
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            Os dados completos estão no staging; a tela carrega em lotes de {PAGE_SIZE} para não
            derrubar o servidor. O botão Enviar todos usa o arquivo/job inteiro.
          </p>
        </div>
      )}

      {canSend ? (
        <div className="mb-4 rounded-lg border border-border bg-bg-card p-4">
          <p className="mb-3 text-xs text-text-secondary">
            {codedSummary ? (
              codedSummary.mode === "pedidos" ? (
                <>
                  <strong>Enviar todos</strong> apaga a janela de meses no MySQL e reinsere as
                  linhas tratadas da planilha (igual ao sistema antigo Avinor).
                </>
              ) : (
                <>
                  <strong>Enviar todos</strong> insere só os <strong>números</strong> que ainda não
                  existem no banco.
                </>
              )
            ) : (
              <>
                <strong>Enviar somente 1</strong> manda a linha marcada como PRÓXIMO.{" "}
                <strong>Enviar selecionados</strong>: 1º clique ativa os checkboxes, marque as NOVO,
                2º clique envia. <strong>Enviar todos</strong> manda o job completo do staging.
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => sendOneMutation.mutate()}
              disabled={sending || loadingMore}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-bg-surface disabled:opacity-50"
            >
              Enviar somente 1
            </button>
            <button
              type="button"
              onClick={handleEnviarSelecionados}
              disabled={sending || loadingMore}
              className={cn(
                "rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50",
                selectMode
                  ? "border-accent-blue bg-accent-blue/15 text-accent-blue"
                  : "border-border hover:bg-bg-surface",
              )}
            >
              Enviar selecionados ({selectedRows.length})
            </button>
            <button
              type="button"
              onClick={() => sendAllMutation.mutate()}
              disabled={sending}
              className="flex items-center gap-2 rounded-lg bg-accent-green px-4 py-2 text-sm font-medium text-bg-base hover:opacity-90 disabled:opacity-50"
            >
              <Send size={16} /> Enviar todos
            </button>
            {selectMode && (
              <button
                type="button"
                onClick={() => {
                  setSelectMode(false);
                  setSelectedRows([]);
                }}
                className="rounded-lg px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancelar seleção
              </button>
            )}
          </div>
          {selectMode && (
            <p className="mt-2 text-xs text-accent-blue">
              Marque os quadradinhos nas linhas NOVO e clique de novo em &quot;Enviar
              selecionados&quot;.
            </p>
          )}
        </div>
      ) : status === "sent" ? (
        <div className="mb-4 rounded-lg border border-accent-green/30 bg-accent-green/10 px-4 py-3 text-sm text-accent-green">
          Planilha enviada com sucesso — nada pendente para enviar.
        </div>
      ) : null}

      <p className="mb-2 text-xs text-text-secondary">
        Arraste horizontalmente (ou use a barra embaixo) para ver todas as colunas.
      </p>
      <div
        className="min-w-0 max-w-full overflow-x-scroll overflow-y-auto rounded-lg border border-border"
        style={{ maxHeight: "32rem" }}
      >
        <table
          className="border-collapse text-left text-sm"
          style={{ width: "max-content", minWidth: "100%" }}
        >
          <thead className="sticky top-0 z-10 bg-bg-card shadow-sm">
            <tr>
              {selectMode && (
                <th className="whitespace-nowrap px-3 py-2 text-text-secondary">Sel.</th>
              )}
              <th className="whitespace-nowrap px-3 py-2 text-text-secondary">#</th>
              <th className="whitespace-nowrap px-3 py-2 text-text-secondary">Status</th>
              {diff.headers.map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium text-text-secondary">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const msIndex = row.mustSend ? ++mustSendCounter : -1;
              const isFirstInQueue = row.mustSend && msIndex === 0;
              const isUpdated = Boolean(row.mustUpdate || row.isUpdated);
              return (
                <Fragment key={rowIndex}>
                  <tr
                    className={cn(
                      "border-t border-border/50",
                      row.mustSend && "border-l-[3px] border-l-accent-green bg-accent-green/10",
                      isFirstInQueue && "ring-1 ring-inset ring-accent-blue/40",
                      isUpdated && "border-l-[3px] border-l-orange-400 bg-orange-400/10",
                      row.isNew &&
                        !row.isNewInDb &&
                        !row.mustSend &&
                        !isUpdated &&
                        "border-l-[3px] border-l-accent-amber bg-accent-amber/10",
                      selectMode &&
                        row.mustSend &&
                        selectedRows.includes(msIndex) &&
                        "bg-accent-blue/10",
                    )}
                  >
                    {selectMode && (
                      <td className="whitespace-nowrap px-3 py-2">
                        <input
                          type="checkbox"
                          disabled={!row.mustSend}
                          checked={row.mustSend && selectedRows.includes(msIndex)}
                          onChange={(e) => {
                            if (!row.mustSend) return;
                            setSelectedRows((prev) =>
                              e.target.checked
                                ? [...prev, msIndex]
                                : prev.filter((i) => i !== msIndex),
                            );
                          }}
                        />
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-text-secondary">
                      {rowIndex + 1}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {row.mustSend && (
                        <span className="rounded bg-accent-green/20 px-2 py-0.5 text-xs text-accent-green">
                          {codedSummary ? "OK" : isFirstInQueue ? "PRÓXIMO" : "NOVO"}
                        </span>
                      )}
                      {isUpdated && (
                        <details className="inline-block">
                          <summary className="cursor-pointer list-none rounded bg-orange-400/20 px-2 py-0.5 text-xs text-orange-300">
                            ATUALIZADO ▾
                          </summary>
                          <div className="absolute z-20 mt-1 max-w-sm rounded-lg border border-border bg-bg-card p-3 text-xs shadow-xl">
                            {(row.changes ?? []).map((ch) => (
                              <p key={ch.column} className="mb-1">
                                <span className="font-medium text-text-primary">{ch.column}:</span>{" "}
                                <span className="text-accent-amber">{ch.from || "—"}</span>
                                {" → "}
                                <span className="text-accent-green">{ch.to || "—"}</span>
                              </p>
                            ))}
                            {(row.changes ?? []).length === 0 && (
                              <p className="text-text-muted">Sem detalhe de campos</p>
                            )}
                          </div>
                        </details>
                      )}
                      {row.isNew && !row.isNewInDb && !row.mustSend && !isUpdated && (
                        <span className="rounded bg-accent-amber/20 px-2 py-0.5 text-xs text-accent-amber">
                          JÁ NO BANCO
                        </span>
                      )}
                    </td>
                    {row.data.map((cell, ci) => (
                      <td key={ci} className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                        {cell || "—"}
                      </td>
                    ))}
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Chip({ color, label }: { color: "green" | "amber" | "neutral"; label: string }) {
  const colors = {
    green: "bg-accent-green/10 text-accent-green",
    amber: "bg-accent-amber/10 text-accent-amber",
    neutral: "bg-bg-card text-text-secondary",
  };
  return (
    <span className={cn("rounded-full px-3 py-1 text-xs font-medium", colors[color])}>
      {label}
    </span>
  );
}
