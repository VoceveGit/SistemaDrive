// frontend/src/components/layout/Header.tsx

import { useEffect, useRef } from "react";
import { Bell, Database, LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuthStore } from "../../stores/authStore";
import { useNotificationStore } from "../../stores/notificationStore";
import { cn, formatDateTime, formatNumber } from "../../lib/utils";

type HeaderProps = {
  sidebarWidth: string;
};

export function Header({ sidebarWidth }: HeaderProps) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const panelRef = useRef<HTMLDivElement>(null);

  const items = useNotificationStore((s) => s.items);
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const setPanelOpen = useNotificationStore((s) => s.setPanelOpen);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const requestOpenCompany = useNotificationStore((s) => s.requestOpenCompany);

  const unread = items.filter((n) => !n.read).length;

  const { data: connection } = useQuery({
    queryKey: ["connection-status"],
    queryFn: () => api<{ connected: boolean; message: string }>("/dashboard/connection"),
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (!panelOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [panelOpen, setPanelOpen]);

  function handleNotificationClick(n: (typeof items)[number]) {
    markRead(n.id);
    requestOpenCompany(n.companyId);
    navigate("/dashboard");
  }

  return (
    <header
      className="fixed top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-bg-surface/95 px-6 backdrop-blur"
      style={{ left: sidebarWidth, right: 0 }}
    >
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Painel de Controle</h1>
        <p className="text-xs text-text-secondary">Monitoramento de planilhas dos clientes</p>
      </div>

      <div className="flex items-center gap-4">
        <div
          className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium",
            connection?.connected
              ? "bg-accent-green/10 text-accent-green"
              : "bg-accent-red/10 text-accent-red",
          )}
        >
          <Database size={14} />
          {connection?.connected ? "Banco conectado" : "Banco offline"}
        </div>

        <div className="relative" ref={panelRef}>
          <button
            type="button"
            onClick={() => setPanelOpen(!panelOpen)}
            className="relative rounded-lg p-2 text-text-secondary hover:bg-bg-card hover:text-text-primary"
            aria-label="Notificações"
          >
            <Bell size={20} />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-amber px-1 text-[10px] font-bold text-bg-base">
                {formatNumber(unread)}
              </span>
            )}
          </button>

          {panelOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-bg-surface shadow-xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <p className="text-sm font-medium text-text-primary">Notificações</p>
                {unread > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    className="text-xs text-text-secondary hover:text-text-primary"
                  >
                    Marcar todas como lidas
                  </button>
                )}
              </div>

              <div className="max-h-80 overflow-y-auto">
                {items.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-text-secondary">
                    Nenhuma notificação ainda
                  </p>
                ) : (
                  items.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => handleNotificationClick(n)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 border-b border-border/60 px-4 py-3 text-left transition hover:bg-bg-card",
                        !n.read && "bg-accent-blue/5",
                      )}
                    >
                      <span className="truncate text-sm font-medium text-text-primary">
                        {n.fileName}
                      </span>
                      <span className="text-xs text-text-secondary">{n.companyName}</span>
                      <span className="text-[11px] text-text-muted">
                        {formatDateTime(n.receivedAt)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-l border-border pl-4">
          <div className="text-right">
            <p className="text-sm font-medium text-text-primary">{user?.name}</p>
            <p className="text-xs text-text-secondary">{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            className="rounded-lg p-2 text-text-secondary hover:bg-bg-card hover:text-accent-red"
            title="Sair"
          >
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}
