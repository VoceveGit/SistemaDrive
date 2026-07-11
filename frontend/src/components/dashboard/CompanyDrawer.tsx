// frontend/src/components/dashboard/CompanyDrawer.tsx

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Settings, ChevronDown, ChevronUp } from "lucide-react";
import { api, type Company, type Spreadsheet } from "../../lib/api";
import { cn, formatDateTime, formatNumber } from "../../lib/utils";
import { SpreadsheetDiff } from "./SpreadsheetDiff";
import { CompanySettingsModal } from "../companies/CompanySettingsModal";

type CompanyDrawerProps = {
  company: Company;
  onClose: () => void;
};

const statusLabels: Record<string, { label: string; className: string }> = {
  pending: { label: "Aguardando", className: "bg-accent-amber/20 text-accent-amber" },
  approved: { label: "Aprovado", className: "bg-accent-blue/20 text-accent-blue" },
  sent: { label: "Enviado", className: "bg-accent-green/20 text-accent-green" },
  error: { label: "Erro", className: "bg-accent-red/20 text-accent-red" },
};

export function CompanyDrawer({ company, onClose }: CompanyDrawerProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["spreadsheets", company.id],
    queryFn: () =>
      api<{ spreadsheets: Spreadsheet[] }>(`/companies/${company.id}/spreadsheets`),
  });

  const spreadsheets = data?.spreadsheets ?? [];

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[min(96vw,1100px)] flex-col border-l border-border bg-bg-surface shadow-2xl">
        <div
          className="flex items-center justify-between border-b border-border px-6 py-4"
          style={{ borderTopWidth: 4, borderTopColor: company.color }}
        >
          <div>
            <h2 className="text-xl font-bold text-text-primary">{company.name}</h2>
            <p className="text-sm text-text-secondary">Histórico de planilhas recebidas</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-bg-card"
            >
              <Settings size={16} /> Configurar
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 hover:bg-bg-card"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-auto p-6">
          {isLoading ? (
            <p className="text-text-secondary">Carregando planilhas...</p>
          ) : spreadsheets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-12 text-center">
              <p className="text-text-secondary">Nenhuma planilha recebida ainda</p>
              <p className="mt-2 text-xs text-text-muted">
                Compartilhe a pasta do Drive com o cliente e aguarde o envio
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg-card">
                  <tr>
                    <th className="px-4 py-3 text-text-secondary">Arquivo</th>
                    <th className="px-4 py-3 text-text-secondary">Data/Hora</th>
                    <th className="px-4 py-3 text-text-secondary">Linhas</th>
                    <th className="px-4 py-3 text-text-secondary">Novas</th>
                    <th className="px-4 py-3 text-text-secondary">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {spreadsheets.map((sheet) => {
                    const isExpanded = expandedId === sheet.id;
                    const st = statusLabels[sheet.status] ?? statusLabels.pending;
                    return (
                      <SpreadsheetRow
                        key={sheet.id}
                        sheet={sheet}
                        isExpanded={isExpanded}
                        status={st}
                        companyId={company.id}
                        onToggle={() =>
                          setExpandedId(isExpanded ? null : sheet.id)
                        }
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showSettings && (
        <CompanySettingsModal
          company={company}
          onClose={() => setShowSettings(false)}
        />
      )}
    </>
  );
}

function SpreadsheetRow({
  sheet,
  isExpanded,
  status,
  companyId,
  onToggle,
}: {
  sheet: Spreadsheet;
  isExpanded: boolean;
  status: { label: string; className: string };
  companyId: string;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-t border-border hover:bg-bg-card/50"
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-medium">{sheet.fileName}</td>
        <td className="px-4 py-3 text-text-secondary">{formatDateTime(sheet.detectedAt)}</td>
        <td className="px-4 py-3 font-mono">{formatNumber(sheet.totalRows)}</td>
        <td className="px-4 py-3 font-mono text-accent-green">
          {formatNumber(sheet.newRows)}
        </td>
        <td className="px-4 py-3">
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", status.className)}>
            {status.label}
          </span>
        </td>
        <td className="px-4 py-3 text-text-secondary">
          {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={6} className="max-w-0 p-0">
            <div className="min-w-0 w-full">
              <SpreadsheetDiff
                spreadsheetId={sheet.id}
                status={sheet.status}
                companyId={companyId}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
