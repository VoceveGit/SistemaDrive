// frontend/src/components/companies/CompanySettingsModal.tsx

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api, type Company } from "../../lib/api";
import { CompanyDbFields, confirmSaveWithoutDate } from "./CompanyDbFields";
import {
  CompanyImportFields,
  type IgnoreRulesState,
  type MappingPair,
} from "./CompanyImportFields";

type CompanySettingsModalProps = {
  company: Company;
  onClose: () => void;
};

function mappingToPairs(mapping: Record<string, string> | null | undefined): MappingPair[] {
  if (!mapping) return [];
  return Object.entries(mapping).map(([sheet, db]) => ({ sheet, db }));
}

function pairsToMapping(pairs: MappingPair[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    if (p.sheet.trim() && p.db.trim()) out[p.sheet.trim()] = p.db.trim();
  }
  return Object.keys(out).length ? out : null;
}

export function CompanySettingsModal({ company, onClose }: CompanySettingsModalProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"geral" | "banco" | "importacao">("geral");
  const [name, setName] = useState(company.name);
  const [color, setColor] = useState(company.color);
  const [googleFolderId, setGoogleFolderId] = useState(company.googleFolderId);
  const [autoSend, setAutoSend] = useState(company.autoSend ?? false);
  const [targetTable, setTargetTable] = useState(company.targetTable ?? "");
  const [dateColumn, setDateColumn] = useState(company.dateColumn ?? "");
  const [compareColumn, setCompareColumn] = useState(company.compareColumn ?? "");
  const [primaryKeyColumn, setPrimaryKeyColumn] = useState(company.primaryKeyColumn ?? "");

  const [headerRow, setHeaderRow] = useState(company.headerRow ?? 1);
  const [dataRow, setDataRow] = useState(
    company.dataRow != null ? String(company.dataRow) : "",
  );
  const [sheetName, setSheetName] = useState(company.sheetName ?? "");
  const [autofillEmpty, setAutofillEmpty] = useState(company.autofillEmpty ?? false);
  const [skipEmptyRows, setSkipEmptyRows] = useState(company.skipEmptyRows !== false);
  const [ignoreRules, setIgnoreRules] = useState<IgnoreRulesState>(() => {
    const r = company.ignoreRules;
    return {
      enabled: Boolean(r?.column),
      column: r?.column ?? "",
      valuesText: r?.values?.join(", ") ?? "",
    };
  });
  const [fileMode, setFileMode] = useState(company.fileMode ?? "latest_only");
  const [exactFileName, setExactFileName] = useState(company.exactFileName ?? "");
  const [syncMode, setSyncMode] = useState(company.syncMode ?? "incremental");
  const [useDateFilter, setUseDateFilter] = useState(company.useDateFilter ?? false);
  const [useStagingTable, setUseStagingTable] = useState(company.useStagingTable ?? false);
  const [useCodedSolution, setUseCodedSolution] = useState(company.useCodedSolution ?? false);
  const [codedSolutionId, setCodedSolutionId] = useState(company.codedSolutionId ?? "");
  const [columnMapping, setColumnMapping] = useState<MappingPair[]>(() =>
    mappingToPairs(company.columnMapping),
  );

  const { data: codedSolutionsData } = useQuery({
    queryKey: ["coded-solutions"],
    queryFn: () =>
      api<{
        solutions: Array<{
          id: string;
          label: string;
          description: string;
          defaultTargetTable: string;
        }>;
      }>("/coded-solutions"),
    staleTime: 5 * 60_000,
  });
  const codedSolutions = codedSolutionsData?.solutions ?? [];
  const selectedCoded = codedSolutions.find((s) => s.id === codedSolutionId);

  const mutation = useMutation({
    mutationFn: () =>
      api(`/companies/${company.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          color,
          googleFolderId,
          autoSend,
          targetTable: targetTable || null,
          dateColumn: dateColumn || null,
          compareColumn: compareColumn || null,
          primaryKeyColumn: primaryKeyColumn || null,
          headerRow,
          dataRow: dataRow.trim() ? Number(dataRow) : null,
          sheetName: sheetName.trim() || null,
          autofillEmpty,
          skipEmptyRows,
          ignoreRules: ignoreRules.enabled
            ? {
                column: ignoreRules.column.trim(),
                values: ignoreRules.valuesText
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              }
            : null,
          fileMode,
          exactFileName: exactFileName.trim() || null,
          syncMode,
          useDateFilter,
          useStagingTable,
          useCodedSolution,
          codedSolutionId: useCodedSolution && codedSolutionId ? codedSolutionId : null,
          columnMapping: pairsToMapping(columnMapping),
        }),
      }),
    onSuccess: () => {
      toast.success(
        useCodedSolution
          ? "Solução codada salva. Selecione o arquivo no Drive e clique em Carregar."
          : "Configurações salvas. Clique em Reprocessar na planilha para aplicar (linhas/ignore/etc.).",
      );
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["companies-all"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  useEffect(() => {
    if (!targetTable && company.targetTable) setTargetTable(company.targetTable);
  }, [company.targetTable, targetTable]);

  const handleSave = () => {
    if (useCodedSolution && !codedSolutionId) {
      toast.error("Selecione a solução codada (ex.: Clientes Avinor)");
      return;
    }
    if (!useCodedSolution && !confirmSaveWithoutDate(dateColumn)) return;
    mutation.mutate();
  };

  const applyImportPatch = (patch: Record<string, unknown>) => {
    if ("headerRow" in patch) setHeaderRow(Number(patch.headerRow) || 1);
    if ("dataRow" in patch) setDataRow(String(patch.dataRow ?? ""));
    if ("sheetName" in patch) setSheetName(String(patch.sheetName ?? ""));
    if ("autofillEmpty" in patch) setAutofillEmpty(Boolean(patch.autofillEmpty));
    if ("skipEmptyRows" in patch) setSkipEmptyRows(Boolean(patch.skipEmptyRows));
    if ("ignoreRules" in patch) setIgnoreRules(patch.ignoreRules as IgnoreRulesState);
    if ("fileMode" in patch) setFileMode(String(patch.fileMode));
    if ("exactFileName" in patch) setExactFileName(String(patch.exactFileName ?? ""));
    if ("syncMode" in patch) setSyncMode(String(patch.syncMode));
    if ("useDateFilter" in patch) setUseDateFilter(Boolean(patch.useDateFilter));
    if ("useStagingTable" in patch) setUseStagingTable(Boolean(patch.useStagingTable));
    if ("dateColumn" in patch) setDateColumn(String(patch.dateColumn ?? ""));
    if ("compareColumn" in patch) setCompareColumn(String(patch.compareColumn ?? ""));
    if ("columnMapping" in patch) setColumnMapping(patch.columnMapping as MappingPair[]);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">Configurar — {company.name}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-bg-card">
            <X size={20} />
          </button>
        </div>

        <div className="flex border-b border-border">
          {(
            [
              ["geral", "Geral"],
              ["banco", "Banco"],
              ["importacao", "Importação"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex-1 px-4 py-3 text-sm font-medium ${
                tab === id
                  ? "border-b-2 border-accent-blue text-accent-blue"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="max-h-[55vh] space-y-4 overflow-auto p-6">
          {tab === "geral" && (
            <>
              <Input label="Nome" value={name} onChange={setName} />
              <label className="block">
                <span className="mb-1.5 block text-sm text-text-secondary">Cor</span>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-10 w-full cursor-pointer rounded-lg border border-border"
                />
              </label>
              <Input
                label="Pasta do Google Drive (link ou ID)"
                value={googleFolderId}
                onChange={setGoogleFolderId}
              />
              <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-card p-4">
                <input
                  type="checkbox"
                  checked={autoSend}
                  onChange={(e) => setAutoSend(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium text-text-primary">Envio automático</span>
                  <span className="mt-1 block text-sm text-text-secondary">
                    {useCodedSolution
                      ? "Com solução codada, use também “Automatizar solução” na aba Importação (mesmo interruptor)."
                      : "Ao detectar planilha, compara e envia. Em erro, desliga o automático."}
                  </span>
                </span>
              </label>
            </>
          )}

          {tab === "banco" && (
            <CompanyDbFields
              companyId={company.id}
              targetTable={targetTable}
              dateColumn={dateColumn}
              compareColumn={compareColumn}
              primaryKeyColumn={primaryKeyColumn}
              onTargetTableChange={setTargetTable}
              onDateColumnChange={setDateColumn}
              onCompareColumnChange={setCompareColumn}
              onPrimaryKeyColumnChange={setPrimaryKeyColumn}
              enabled={tab === "banco"}
            />
          )}

          {tab === "importacao" && (
            <div className="space-y-6">
              <section className="space-y-3 rounded-lg border border-accent-blue/30 bg-accent-blue/5 p-4">
                <h3 className="text-sm font-semibold text-text-primary">
                  Solução codada (personalizada)
                </h3>
                <p className="text-xs text-text-secondary">
                  Quando ativa, o mapeamento genérico abaixo é ignorado. O motor fixo no código
                  faz o snapshot (espelho + troca) ao carregar o arquivo.
                </p>
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={useCodedSolution}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setUseCodedSolution(on);
                      if (on && !codedSolutionId && codedSolutions[0]) {
                        setCodedSolutionId(codedSolutions[0].id);
                        if (!targetTable) {
                          setTargetTable(codedSolutions[0].defaultTargetTable);
                        }
                      }
                    }}
                    className="mt-1"
                  />
                  <span className="text-sm text-text-primary">
                    Usar solução codada
                  </span>
                </label>
                {useCodedSolution && (
                  <>
                    <label className="block">
                      <span className="mb-1.5 block text-sm text-text-secondary">
                        Qual solução
                      </span>
                      <select
                        className="input"
                        value={codedSolutionId}
                        onChange={(e) => {
                          const id = e.target.value;
                          setCodedSolutionId(id);
                          const sol = codedSolutions.find((s) => s.id === id);
                          if (sol && (!targetTable || targetTable === "base_clientes_avinor")) {
                            setTargetTable(sol.defaultTargetTable);
                          }
                        }}
                      >
                        <option value="">Selecione…</option>
                        {codedSolutions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      {selectedCoded && (
                        <p className="mt-2 text-xs text-text-secondary">
                          {selectedCoded.description}
                        </p>
                      )}
                    </label>
                    <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-card/50 p-3">
                      <input
                        type="checkbox"
                        checked={autoSend}
                        onChange={(e) => setAutoSend(e.target.checked)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-sm font-medium text-text-primary">
                          Automatizar solução
                        </span>
                        <span className="mt-1 block text-xs text-text-secondary">
                          Ao salvar, enfileira a planilha mais nova ainda não enviada. Novos
                          arquivos entram na fila (1 por vez: ler → enviar). Manual continua
                          disponível.
                        </span>
                      </span>
                    </label>
                  </>
                )}
              </section>

              {!useCodedSolution && (
                <CompanyImportFields
                  companyId={company.id}
                  targetTable={targetTable}
                  headerRow={headerRow}
                  dataRow={dataRow}
                  sheetName={sheetName}
                  autofillEmpty={autofillEmpty}
                  skipEmptyRows={skipEmptyRows}
                  ignoreRules={ignoreRules}
                  fileMode={fileMode}
                  exactFileName={exactFileName}
                  syncMode={syncMode}
                  useDateFilter={useDateFilter}
                  useStagingTable={useStagingTable}
                  dateColumn={dateColumn}
                  compareColumn={compareColumn}
                  columnMapping={columnMapping}
                  onChange={applyImportPatch}
                />
              )}
              {useCodedSolution && (
                <p className="text-xs text-text-muted">
                  Configurações genéricas (linha do título, mapeamento, etc.) ficam ocultas
                  enquanto a solução codada estiver ativa.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={mutation.isPending}
            className="btn-primary"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-text-secondary">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="input" />
    </label>
  );
}
