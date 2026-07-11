// frontend/src/pages/DashboardPage.tsx

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, Clock, Plus, RefreshCw, Rows3 } from "lucide-react";
import { api, type Company, type DashboardStats } from "../lib/api";
import { StatCard } from "../components/dashboard/StatCard";
import { CompanyCard } from "../components/dashboard/CompanyCard";
import { CompanyDrawer } from "../components/dashboard/CompanyDrawer";
import { CompanyFormModal } from "../components/companies/CompanyFormModal";
import { useNotificationStore } from "../stores/notificationStore";

export function DashboardPage() {
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [showNewCompany, setShowNewCompany] = useState(false);
  const pendingOpenCompanyId = useNotificationStore((s) => s.pendingOpenCompanyId);
  const clearPendingOpenCompany = useNotificationStore((s) => s.clearPendingOpenCompany);

  const { data: stats } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => api<DashboardStats & { success: boolean }>("/dashboard/stats"),
    refetchInterval: 15000,
  });

  const { data: companiesData, isLoading } = useQuery({
    queryKey: ["companies"],
    queryFn: () => api<{ companies: Company[] }>("/companies"),
    refetchInterval: 15000,
  });

  const companies = companiesData?.companies ?? [];

  useEffect(() => {
    if (!pendingOpenCompanyId || companies.length === 0) return;
    const company = companies.find((c) => c.id === pendingOpenCompanyId);
    if (company) {
      setSelectedCompany(company);
      clearPendingOpenCompany();
    }
  }, [pendingOpenCompanyId, companies, clearPendingOpenCompany]);

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Planilhas Pendentes"
          value={stats?.pendingTotal ?? 0}
          icon={Clock}
          colorClass="bg-accent-amber/20 text-accent-amber"
        />
        <StatCard
          title="Enviadas Hoje"
          value={stats?.sentToday ?? 0}
          icon={CheckCircle}
          colorClass="bg-accent-green/20 text-accent-green"
        />
        <StatCard
          title="Atualizações Hoje"
          value={stats?.updatesToday ?? 0}
          icon={RefreshCw}
          colorClass="bg-accent-blue/20 text-accent-blue"
        />
        <StatCard
          title="Linhas Novas Hoje"
          value={stats?.newRowsToday ?? 0}
          icon={Rows3}
          colorClass="bg-accent-purple/20 text-accent-purple"
        />
      </div>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Empresas Monitoradas</h2>
            <p className="text-sm text-text-secondary">
              Clique em um card para ver o histórico e comparativo
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNewCompany(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus size={18} /> Nova Empresa
          </button>
        </div>

        {isLoading ? (
          <p className="text-text-secondary">Carregando empresas...</p>
        ) : companies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <p className="text-text-secondary">Nenhuma empresa cadastrada</p>
            <button
              type="button"
              onClick={() => setShowNewCompany(true)}
              className="btn-primary mt-4"
            >
              Cadastrar primeira empresa
            </button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {companies.map((company) => (
              <CompanyCard
                key={company.id}
                company={company}
                onClick={() => setSelectedCompany(company)}
              />
            ))}
          </div>
        )}
      </section>

      {selectedCompany && (
        <CompanyDrawer
          company={selectedCompany}
          onClose={() => setSelectedCompany(null)}
        />
      )}

      {showNewCompany && <CompanyFormModal onClose={() => setShowNewCompany(false)} />}
    </div>
  );
}
