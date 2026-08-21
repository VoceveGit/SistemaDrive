// frontend/src/components/companies/CompanyDbFields.tsx

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ColumnInfo } from "../../lib/api";

export const DB_COMPARE_LIMIT = 100;

type CompanyDbFieldsProps = {
  companyId?: string;
  targetTable: string;
  dateColumn: string;
  compareColumn: string;
  primaryKeyColumn: string;
  onTargetTableChange: (v: string) => void;
  onDateColumnChange: (v: string) => void;
  onCompareColumnChange: (v: string) => void;
  onPrimaryKeyColumnChange: (v: string) => void;
  enabled?: boolean;
};

export function CompanyDbFields({
  companyId,
  targetTable,
  dateColumn,
  compareColumn,
  primaryKeyColumn,
  onTargetTableChange,
  onDateColumnChange,
  onCompareColumnChange,
  onPrimaryKeyColumnChange,
  enabled = true,
}: CompanyDbFieldsProps) {
  const [loadTables, setLoadTables] = useState(false);
  const tablesQueryKey = companyId ? ["tables", companyId] : ["tables", "new"];

  const { data: tablesData, isLoading: loadingTables, isError: tablesError, error: tablesErrorObj, refetch } =
    useQuery({
      queryKey: tablesQueryKey,
      queryFn: () =>
        api<{ tables: string[] }>(
          companyId ? `/companies/${companyId}/tables` : "/companies/tables-preview",
        ),
      enabled: enabled && loadTables,
      retry: false,
      staleTime: 5 * 60_000,
    });

  const { data: columnsData, isLoading: loadingColumns } = useQuery({
    queryKey: ["columns", companyId ?? "new", targetTable],
    queryFn: () =>
      api<{ columns: ColumnInfo[] }>(
        companyId
          ? `/companies/${companyId}/columns?table=${encodeURIComponent(targetTable)}`
          : `/companies/columns-preview?table=${encodeURIComponent(targetTable)}`,
      ),
    enabled: enabled && loadTables && Boolean(targetTable),
    retry: false,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-bg-card px-3 py-2 text-xs text-text-secondary">
        No Render Free, só carregue as tabelas quando o site estiver estável (sem 502/429).
        Você também pode digitar o nome da tabela manualmente.
      </div>

      <button
        type="button"
        className="btn-secondary text-sm"
        disabled={!enabled || loadingTables}
        onClick={() => {
          setLoadTables(true);
          void refetch();
        }}
      >
        {loadingTables ? "Carregando tabelas..." : "Carregar tabelas do banco"}
      </button>

      {tablesError && (
        <div className="rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
          <p className="font-medium">Não foi possível listar as tabelas</p>
          <p className="mt-1 text-text-secondary">{(tablesErrorObj as Error).message}</p>
          <p className="mt-2 text-xs text-text-muted">
            Espere o serviço ficar Live e tente de novo — ou digite o nome da tabela abaixo.
          </p>
        </div>
      )}

      <label className="block">
        <span className="mb-1.5 block text-sm text-text-secondary">Tabela destino</span>
        {tablesData?.tables?.length ? (
          <select
            value={targetTable}
            onChange={(e) => {
              onTargetTableChange(e.target.value);
              onDateColumnChange("");
              onCompareColumnChange("");
              onPrimaryKeyColumnChange("");
            }}
            className="input"
            disabled={loadingTables}
          >
            <option value="">Selecione uma tabela</option>
            {tablesData.tables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            value={targetTable}
            placeholder="ex: base_clientes_avinor"
            onChange={(e) => onTargetTableChange(e.target.value)}
          />
        )}
      </label>

      {targetTable && (
        <>
          <label className="block">
            <span className="mb-1.5 block text-sm text-text-secondary">
              Coluna de data <span className="text-text-muted">(opcional)</span>
            </span>
            {columnsData?.columns?.length ? (
              <select
                value={dateColumn}
                onChange={(e) => onDateColumnChange(e.target.value)}
                className="input"
                disabled={loadingColumns}
              >
                <option value="">Nenhuma — usar últimos {DB_COMPARE_LIMIT} registros</option>
                {columnsData.columns
                  .filter((c) => c.isDateType)
                  .map((c) => (
                    <option key={c.column_name} value={c.column_name}>
                      {c.column_name} ({c.data_type})
                    </option>
                  ))}
              </select>
            ) : (
              <input
                className="input"
                value={dateColumn}
                placeholder="nome da coluna de data (opcional)"
                onChange={(e) => onDateColumnChange(e.target.value)}
              />
            )}
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm text-text-secondary">
              Coluna principal <span className="text-text-muted">(opcional)</span>
            </span>
            {columnsData?.columns?.length ? (
              <select
                value={compareColumn}
                onChange={(e) => onCompareColumnChange(e.target.value)}
                className="input"
                disabled={loadingColumns}
              >
                <option value="">Nenhuma</option>
                {columnsData.columns.map((c) => (
                  <option key={c.column_name} value={c.column_name}>
                    {c.column_name} ({c.data_type})
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={compareColumn}
                placeholder="ex: Cliente ou Pedido"
                onChange={(e) => onCompareColumnChange(e.target.value)}
              />
            )}
            <p className="mt-1 text-xs text-text-muted">
              Usada nos modos UPDATE em cascata e “por coluna principal” (aba Importação).
            </p>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm text-text-secondary">
              Coluna chave <span className="text-text-muted">(upsert opcional)</span>
            </span>
            {columnsData?.columns?.length ? (
              <select
                value={primaryKeyColumn}
                onChange={(e) => onPrimaryKeyColumnChange(e.target.value)}
                className="input"
                disabled={loadingColumns}
              >
                <option value="">Apenas INSERT</option>
                {columnsData.columns.map((c) => (
                  <option key={c.column_name} value={c.column_name}>
                    {c.column_name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={primaryKeyColumn}
                placeholder="opcional"
                onChange={(e) => onPrimaryKeyColumnChange(e.target.value)}
              />
            )}
          </label>

          {!dateColumn && (
            <p className="rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
              Dados de data não configurados — a pesquisa no banco será feita com base nos
              últimos {DB_COMPARE_LIMIT} registros.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function confirmSaveWithoutDate(dateColumn: string): boolean {
  if (dateColumn) return true;
  return window.confirm(
    `Dados de data não configurados. A pesquisa no banco será feita com base nos últimos ${DB_COMPARE_LIMIT} registros.\n\nDeseja salvar mesmo assim?`,
  );
}
