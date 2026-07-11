// frontend/src/pages/CompaniesPage.tsx

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, Pencil, Power } from "lucide-react";
import { toast } from "sonner";
import { api, type Company } from "../lib/api";
import { formatDateTime, formatNumber } from "../lib/utils";
import { CompanyFormModal } from "../components/companies/CompanyFormModal";
import { CompanySettingsModal } from "../components/companies/CompanySettingsModal";
import { CompanyDrawer } from "../components/dashboard/CompanyDrawer";

export function CompaniesPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [editCompany, setEditCompany] = useState<Company | null>(null);
  const [viewCompany, setViewCompany] = useState<Company | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["companies-all"],
    queryFn: () => api<{ companies: Company[] }>("/companies/all"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api(`/companies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Empresa desativada");
      queryClient.invalidateQueries({ queryKey: ["companies-all"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const companies = data?.companies ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Empresas</h2>
          <p className="text-sm text-text-secondary">Gerencie clientes e pastas do Drive</p>
        </div>
        <button type="button" onClick={() => setShowNew(true)} className="btn-primary flex items-center gap-2">
          <Plus size={18} /> Nova Empresa
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-bg-card">
            <tr>
              <th className="px-4 py-3 text-text-secondary">Empresa</th>
              <th className="px-4 py-3 text-text-secondary">Pasta Drive</th>
              <th className="px-4 py-3 text-text-secondary">Tabela</th>
              <th className="px-4 py-3 text-text-secondary">Planilhas</th>
              <th className="px-4 py-3 text-text-secondary">Enviadas</th>
              <th className="px-4 py-3 text-text-secondary">Última atividade</th>
              <th className="px-4 py-3 text-text-secondary">Status</th>
              <th className="px-4 py-3 text-text-secondary">Ações</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-text-secondary">
                  Carregando...
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center">
                  <p className="text-accent-red">{(error as Error).message}</p>
                  <button type="button" onClick={() => refetch()} className="btn-secondary mt-3 text-sm">
                    Tentar novamente
                  </button>
                </td>
              </tr>
            ) : companies.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <p className="text-text-secondary">Nenhuma empresa cadastrada</p>
                  <button type="button" onClick={() => setShowNew(true)} className="btn-primary mt-4 text-sm">
                    + Nova Empresa
                  </button>
                </td>
              </tr>
            ) : (
              companies.map((c) => {
                const sentCount = c.totalSpreadsheets - c.pendingSpreadsheets;
                return (
                  <tr
                    key={c.id}
                    className="cursor-pointer border-t border-border hover:bg-bg-card/30"
                    onClick={() => setViewCompany(c)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: c.color }}
                        />
                        <span className="font-medium">{c.name}</span>
                      </div>
                    </td>
                    <td className="max-w-[140px] truncate px-4 py-3 font-mono text-xs text-text-secondary">
                      {c.googleFolderId}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{c.targetTable ?? "—"}</td>
                    <td className="px-4 py-3 font-mono">{formatNumber(c.totalSpreadsheets)}</td>
                    <td className="px-4 py-3 font-mono text-accent-green">
                      {formatNumber(sentCount)}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {c.lastActivity ? formatDateTime(c.lastActivity) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${
                          c.active
                            ? "bg-accent-green/20 text-accent-green"
                            : "bg-accent-red/20 text-accent-red"
                        }`}
                      >
                        {c.active ? "Ativa" : "Inativa"}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          title="Ver planilhas e dados"
                          onClick={() => setViewCompany(c)}
                          className="rounded p-1.5 hover:bg-bg-card"
                        >
                          <Eye size={16} />
                        </button>
                        <button
                          type="button"
                          title="Editar"
                          onClick={() => setEditCompany(c)}
                          className="rounded p-1.5 hover:bg-bg-card"
                        >
                          <Pencil size={16} />
                        </button>
                        {c.active && (
                          <button
                            type="button"
                            title="Desativar"
                            onClick={() => deactivateMutation.mutate(c.id)}
                            className="rounded p-1.5 hover:bg-bg-card hover:text-accent-red"
                          >
                            <Power size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showNew && <CompanyFormModal onClose={() => setShowNew(false)} />}
      {editCompany && (
        <CompanySettingsModal company={editCompany} onClose={() => setEditCompany(null)} />
      )}
      {viewCompany && (
        <CompanyDrawer company={viewCompany} onClose={() => setViewCompany(null)} />
      )}
    </div>
  );
}
