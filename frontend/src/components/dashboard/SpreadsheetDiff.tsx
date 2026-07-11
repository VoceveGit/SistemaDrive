// frontend/src/components/dashboard/SpreadsheetDiff.tsx

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, RefreshCw, Send } from "lucide-react";
import { api, type DiffResult, type SendReport } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";

type SpreadsheetDiffProps = {
  spreadsheetId: string;
  status: string;
  companyId: string;
};

export function SpreadsheetDiff({ spreadsheetId, status, companyId }: SpreadsheetDiffProps) {
  const queryClient = useQueryClient();
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [lastReport, setLastReport] = useState<SendReport | null>(null);

  const { data: diff, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["diff", spreadsheetId],
    queryFn: () => api<DiffResult & { success: boolean }>(`/spreadsheets/${spreadsheetId}/diff`),
  });

  const invalidateAfterSend = () => {
    queryClient.invalidateQueries({ queryKey: ["diff", spreadsheetId] });
    queryClient.invalidateQueries({ queryKey: ["spreadsheets", companyId] });
    queryClient.invalidateQueries({ queryKey: ["companies"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    setSelectedRows([]);
    setSelectMode(false);
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
    if (res.completed) {
      toast.success("Planilha concluída e marcada como enviada");
    } else {
      toast.success(`${res.insertedCount ?? 0} linha(s) enviada(s)`);
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
    mutationFn: () =>
      api<{ insertedCount?: number; completed?: boolean; report?: SendReport }>(
        `/spreadsheets/${spreadsheetId}/send-test`,
        {
          method: "POST",
          body: JSON.stringify({ mode: "single" }),
        },
      ),
    onSuccess: handleSendSuccess,
    onError: (e: Error) => toast.error(e.message),
  });

  const sendSelectedMutation = useMutation({
    mutationFn: () => {
      if (selectedRows.length === 0) {
        return Promise.reject(new Error("Marque as linhas que deseja enviar"));
      }
      return api<{ insertedCount?: number; completed?: boolean; report?: SendReport }>(
        `/spreadsheets/${spreadsheetId}/send-test`,
        {
          method: "POST",
          body: JSON.stringify({ mode: "pick", selectedRows }),
        },
      );
    },
    onSuccess: handleSendSuccess,
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return <p className="p-4 text-sm text-text-secondary">Calculando comparativo...</p>;
  }

  if (!diff) return null;

  let mustSendCounter = -1;
  const canSend = diff.summary.mustSend > 0;
  const sending =
    sendAllMutation.isPending || sendOneMutation.isPending || sendSelectedMutation.isPending;

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

  return (
    <div className="min-w-0 max-w-full border-t border-border bg-bg-surface p-4">
      {diff.dbCheckSkipped ? (
        <div className="mb-4 rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
          Não foi possível comparar com o banco — verifique a conexão e a tabela da empresa.
        </div>
      ) : diff.dbCompareMode === "last_records" ? (
        <div className="mb-4 rounded-lg border border-border bg-bg-card px-4 py-2 text-xs text-text-secondary">
          Comparando {diff.dbRowsLoaded} registros do banco com {diff.summary.totalRows} linhas da
          planilha (janela: {diff.summary.totalRows} da planilha + {diff.dbCompareLimit != null ? Math.max(0, (diff.dbCompareLimit ?? 0) - diff.summary.totalRows) : 100} do banco).
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
        <Chip color="green" label={`${formatNumber(diff.summary.mustSend)} para enviar`} />
        <Chip color="amber" label={`${formatNumber(diff.summary.alreadyInDb)} já no banco`} />
        <Chip
          color="neutral"
          label={`${formatNumber(diff.summary.totalRows - diff.summary.newRows)} sem alteração`}
        />

        <button
          type="button"
          onClick={async () => {
            setSelectedRows([]);
            setSelectMode(false);
            const res = await refetch();
            const d = res.data;
            if (d) {
              toast.success(
                `Análise: ${d.summary.mustSend} para enviar · ${d.summary.alreadyInDb} já no banco · ${d.dbRowsLoaded} lidos do MySQL`,
              );
            }
          }}
          disabled={isFetching}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-bg-card disabled:opacity-50"
        >
          <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
          Analisar dados
        </button>

        {status === "pending" && (
          <button
            type="button"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending}
            className="ml-auto flex items-center gap-2 rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Check size={16} /> Aprovar
          </button>
        )}
      </div>

      {canSend ? (
        <div className="mb-4 rounded-lg border border-border bg-bg-card p-4">
          <p className="mb-3 text-xs text-text-secondary">
            Escolha como enviar. A tabela e os contadores atualizam na hora.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => sendOneMutation.mutate()}
              disabled={sending}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-bg-surface disabled:opacity-50"
            >
              Enviar somente 1
            </button>
            <button
              type="button"
              onClick={handleEnviarSelecionados}
              disabled={sending}
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
              Marque os quadradinhos nas linhas NOVO e clique de novo em &quot;Enviar selecionados&quot;.
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
            {diff.rows.map((row, rowIndex) => {
              const msIndex = row.mustSend ? ++mustSendCounter : -1;
              const isFirstInQueue = row.mustSend && msIndex === 0;
              return (
                <tr
                  key={rowIndex}
                  className={cn(
                    "border-t border-border/50",
                    row.mustSend && "border-l-[3px] border-l-accent-green bg-accent-green/10",
                    isFirstInQueue && "ring-1 ring-inset ring-accent-blue/40",
                    row.isNew &&
                      !row.isNewInDb &&
                      !row.mustSend &&
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
                        {isFirstInQueue ? "PRÓXIMO" : "NOVO"}
                      </span>
                    )}
                    {row.isNew && !row.isNewInDb && !row.mustSend && (
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
