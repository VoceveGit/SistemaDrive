// frontend/src/components/companies/CompanyImportFields.tsx — Config Avinor / leitura / sync

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ColumnInfo } from "../../lib/api";

export type IgnoreRulesState = {
  enabled: boolean;
  column: string;
  valuesText: string;
};

export type MappingPair = { sheet: string; db: string };

type Props = {
  companyId: string;
  targetTable: string;
  headerRow: number;
  dataRow: string;
  sheetName: string;
  autofillEmpty: boolean;
  skipEmptyRows: boolean;
  ignoreRules: IgnoreRulesState;
  fileMode: string;
  exactFileName: string;
  syncMode: string;
  useDateFilter: boolean;
  useStagingTable: boolean;
  dateColumn: string;
  compareColumn: string;
  columnMapping: MappingPair[];
  onChange: (patch: Record<string, unknown>) => void;
};

export function CompanyImportFields({
  companyId,
  targetTable,
  headerRow,
  dataRow,
  sheetName,
  autofillEmpty,
  skipEmptyRows,
  ignoreRules,
  fileMode,
  exactFileName,
  syncMode,
  useDateFilter,
  useStagingTable,
  dateColumn,
  compareColumn,
  columnMapping,
  onChange,
}: Props) {
  const [loadColumns, setLoadColumns] = useState(false);
  const { data: columnsData } = useQuery({
    queryKey: ["columns", companyId, targetTable],
    queryFn: () =>
      api<{ columns: ColumnInfo[] }>(
        `/companies/${companyId}/columns?table=${encodeURIComponent(targetTable)}`,
      ),
    enabled: Boolean(targetTable) && loadColumns,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const columns = columnsData?.columns ?? [];

  return (
    <div className="space-y-6">
      {targetTable && (
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={() => setLoadColumns(true)}
        >
          Carregar colunas do banco (opcional)
        </button>
      )}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Leitura da planilha</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumField
            label="Linha do título"
            value={headerRow}
            onChange={(v) => onChange({ headerRow: v })}
          />
          <label className="block">
            <span className="mb-1.5 block text-sm text-text-secondary">Linha dos dados</span>
            <input
              type="number"
              min={1}
              className="input"
              value={dataRow}
              placeholder="vazio = título+1"
              onChange={(e) => onChange({ dataRow: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm text-text-secondary">Nome da aba</span>
            <input
              className="input"
              value={sheetName}
              placeholder="vazio = primeira aba"
              onChange={(e) => onChange({ sheetName: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Pré-processamento</h3>
        <Check
          checked={autofillEmpty}
          onChange={(v) => onChange({ autofillEmpty: v })}
          label="Autopreencher células vazias (herdar de cima)"
        />
        <Check
          checked={skipEmptyRows}
          onChange={(v) => onChange({ skipEmptyRows: v })}
          label="Pular linhas totalmente vazias"
        />
        <Check
          checked={ignoreRules.enabled}
          onChange={(v) =>
            onChange({ ignoreRules: { ...ignoreRules, enabled: v } })
          }
          label="Ignorar linhas por valor"
        />
        {ignoreRules.enabled && (
          <div className="grid gap-3 sm:grid-cols-2 pl-1">
            <label className="block">
              <span className="mb-1.5 block text-sm text-text-secondary">Coluna</span>
              <input
                className="input"
                value={ignoreRules.column}
                placeholder="ex: Descrição"
                onChange={(e) =>
                  onChange({
                    ignoreRules: { ...ignoreRules, column: e.target.value },
                  })
                }
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm text-text-secondary">
                Valores (separados por vírgula)
              </span>
              <input
                className="input"
                value={ignoreRules.valuesText}
                placeholder="TOTAL DO DIA, TOTAL GERAL"
                onChange={(e) =>
                  onChange({
                    ignoreRules: { ...ignoreRules, valuesText: e.target.value },
                  })
                }
              />
            </label>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Arquivo no Drive</h3>
        <label className="block">
          <span className="mb-1.5 block text-sm text-text-secondary">Modo</span>
          <select
            className="input"
            value={fileMode}
            onChange={(e) => onChange({ fileMode: e.target.value })}
          >
            <option value="latest_only">Só o arquivo mais recente da pasta</option>
            <option value="new_files">Todos os arquivos novos da pasta</option>
            <option value="exact_name">Nome exato</option>
          </select>
          <p className="text-xs text-text-muted">
            No Render Free, use &quot;mais recente&quot; — processa só a última planilha e evita sobrecarga.
          </p>
        </label>
        {fileMode === "exact_name" && (
          <label className="block">
            <span className="mb-1.5 block text-sm text-text-secondary">Nome do arquivo</span>
            <input
              className="input"
              value={exactFileName}
              onChange={(e) => onChange({ exactFileName: e.target.value })}
            />
          </label>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Planilha grande</h3>
        <Check
          checked={useStagingTable}
          onChange={(v) => onChange({ useStagingTable: v })}
          label="Usar tabela job (planilha grande)"
        />
        <p className="text-xs text-text-muted">
          Grava as linhas em <code className="text-text-secondary">zz_import_staging</code> no
          EXTRACTOR (uma tabela só; cada planilha é um job). Você valida o preview e só então
          envia para a tabela destino. Os dados do job são apagados após o envio.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Modo de inserção</h3>
        <select
          className="input"
          value={syncMode}
          onChange={(e) => onChange({ syncMode: e.target.value })}
        >
          <option value="incremental">Incremental (só INSERT do novo)</option>
          <option value="incremental_update">Incremental + UPDATE</option>
          <option value="principal_only">Por coluna principal (só INSERT se não existe)</option>
          <option value="snapshot">Snapshot (limpar tabela + inserir tudo)</option>
        </select>

        {(syncMode === "incremental" || syncMode === "incremental_update") && (
          <>
            <Check
              checked={useDateFilter}
              onChange={(v) => onChange({ useDateFilter: v })}
              label="Filtrar banco pelo mês da 1ª linha de dados (coluna de data)"
            />
            <label className="block">
              <span className="mb-1.5 block text-sm text-text-secondary">Coluna de data</span>
              <select
                className="input"
                value={dateColumn}
                onChange={(e) => onChange({ dateColumn: e.target.value })}
              >
                <option value="">Nenhuma</option>
                {columns.map((c) => (
                  <option key={c.column_name} value={c.column_name}>
                    {c.column_name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {(syncMode === "incremental_update" || syncMode === "principal_only") && (
          <label className="block">
            <span className="mb-1.5 block text-sm text-text-secondary">Coluna principal</span>
            <select
              className="input"
              value={compareColumn}
              onChange={(e) => onChange({ compareColumn: e.target.value })}
            >
              <option value="">Selecione</option>
              {columns.map((c) => (
                <option key={c.column_name} value={c.column_name}>
                  {c.column_name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-muted">
              Ex.: Pedido (UPDATE em cascata) ou numero (faturamento).
            </p>
          </label>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">
          Mapeamento de colunas <span className="font-normal text-text-muted">(opcional)</span>
        </h3>
        <p className="text-xs text-text-muted">
          Só para exceções (ex.: Quant. Pedida → Quant._x000D_Pedida).
        </p>
        {columnMapping.map((pair, idx) => (
          <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <input
              className="input"
              placeholder="Planilha"
              value={pair.sheet}
              onChange={(e) => {
                const next = [...columnMapping];
                next[idx] = { ...pair, sheet: e.target.value };
                onChange({ columnMapping: next });
              }}
            />
            <select
              className="input"
              value={pair.db}
              onChange={(e) => {
                const next = [...columnMapping];
                next[idx] = { ...pair, db: e.target.value };
                onChange({ columnMapping: next });
              }}
            >
              <option value="">Coluna no banco</option>
              {columns.map((c) => (
                <option key={c.column_name} value={c.column_name}>
                  {c.column_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary px-2"
              onClick={() =>
                onChange({
                  columnMapping: columnMapping.filter((_, i) => i !== idx),
                })
              }
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={() =>
            onChange({ columnMapping: [...columnMapping, { sheet: "", db: "" }] })
          }
        >
          + Mapear coluna
        </button>
      </section>
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-start gap-3 text-sm text-text-secondary">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-text-secondary">{label}</span>
      <input
        type="number"
        min={1}
        className="input"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 1)}
      />
    </label>
  );
}
