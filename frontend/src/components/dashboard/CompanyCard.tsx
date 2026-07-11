// frontend/src/components/dashboard/CompanyCard.tsx

import type { Company } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";
import { Calendar, Clock, FileSpreadsheet, Rows3 } from "lucide-react";

type CompanyCardProps = {
  company: Company;
  onClick: () => void;
};

export function CompanyCard({ company, onClick }: CompanyCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full rounded-xl border border-border bg-bg-card text-left transition hover:bg-bg-card-hover hover:shadow-lg hover:shadow-black/20"
      style={{ borderTopWidth: 4, borderTopColor: company.color }}
    >
      <div className="p-5">
        <h3 className="text-lg font-semibold text-text-primary group-hover:text-accent-blue">
          {company.name}
        </h3>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Badge icon={FileSpreadsheet} label="Total" value={company.totalSpreadsheets} />
          <Badge icon={Calendar} label="Hoje" value={company.todaySpreadsheets} />
          <Badge icon={Rows3} label="Linhas novas" value={company.todayNewRows} />
          <Badge
            icon={Clock}
            label="Pendentes"
            value={company.pendingSpreadsheets}
            highlight={company.pendingSpreadsheets > 0}
          />
        </div>
      </div>
    </button>
  );
}

function Badge({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: typeof FileSpreadsheet;
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-2",
        highlight && "ring-1 ring-accent-amber/40",
      )}
    >
      <Icon size={14} className={highlight ? "text-accent-amber" : "text-text-secondary"} />
      <div>
        <p className="text-[10px] uppercase tracking-wide text-text-muted">{label}</p>
        <p className={cn("font-mono text-sm font-semibold", highlight && "text-accent-amber")}>
          {formatNumber(value)}
        </p>
      </div>
    </div>
  );
}
