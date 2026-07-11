// frontend/src/components/layout/Sidebar.tsx

import { NavLink } from "react-router-dom";
import { LayoutDashboard, Building2, Settings, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { useState } from "react";

const items = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/companies", label: "Empresas", icon: Building2 },
  { to: "/settings", label: "Configurações", icon: Settings },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-border bg-bg-surface transition-all duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="flex h-16 items-center justify-between border-b border-border px-4">
        {!collapsed && (
          <div>
            <p className="text-sm font-bold text-text-primary">Despacho</p>
            <p className="text-xs text-text-secondary">Voceve</p>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="rounded-lg p-1.5 text-text-secondary hover:bg-bg-card hover:text-text-primary"
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "border-l-[3px] border-accent-blue bg-bg-card text-text-primary"
                  : "border-l-[3px] border-transparent text-text-secondary hover:bg-bg-card hover:text-text-primary",
              )
            }
          >
            <Icon size={20} />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
