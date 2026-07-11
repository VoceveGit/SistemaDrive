// frontend/src/components/dashboard/StatCard.tsx

import type { LucideIcon } from "lucide-react";
import { cn, formatNumber } from "../../lib/utils";

type StatCardProps = {
  title: string;
  value: number;
  icon: LucideIcon;
  colorClass: string;
};

export function StatCard({ title, value, icon: Icon, colorClass }: StatCardProps) {
  return (
    <div className="rounded-xl border border-border bg-bg-card p-5 transition hover:bg-bg-card-hover">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-text-secondary">{title}</p>
          <p className="mt-2 font-mono text-3xl font-bold text-text-primary">
            {formatNumber(value)}
          </p>
        </div>
        <div className={cn("rounded-lg p-2.5", colorClass)}>
          <Icon size={22} />
        </div>
      </div>
    </div>
  );
}
