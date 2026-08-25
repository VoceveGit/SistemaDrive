// frontend/src/components/layout/Header.tsx

import { useEffect, useRef, useState } from "react";
import { Bell, Database, Download, Loader2, LogOut } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuthStore } from "../../stores/authStore";
import { useNotificationStore } from "../../stores/notificationStore";
import { cn, formatDateTime, formatNumber } from "../../lib/utils";

type HeaderProps = {
  sidebarWidth: string;
};

type QueueItem = {
  spreadsheetId: string;
  companyId: string;
  companyName: string;
  fileName: string;
  status: string;
  processMessage: string | null;
  phase: "queued" | "reading" | "sending";
  progressPct: number;
  totalRows: number;
  processedRows: number;
};

type ImportQueueResponse = {
  success: boolean;
  active: QueueItem | null;
  queue: QueueItem[];
  statusLabel: "Baixando" | "Enviando" | null;
  recent: Array<{
    spreadsheetId: string;
    companyId: string;
    companyName: string;
    fileName: string;
    at: string;
    durationMs: number | null;
    ok: boolean;
    message: string;
  }>;
};

export function Header({ sidebarWidth }: HeaderProps) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const panelRef = useRef<HTMLDivElement>(null);
  const dlRef = useRef<HTMLDivElement>(null);

  const items = useNotificationStore((s) => s.items);
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const setPanelOpen = useNotificationStore((s) => s.setPanelOpen);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const requestOpenCompany = useNotificationStore((s) => s.requestOpenCompany);
  const pruneOldDays = useNotificationStore((s) => s.pruneOldDays);
  const addNotification = useNotificationStore((s) => s.addNotification);
  const seenCompletionIds = useNotificationStore((s) => s.seenCompletionIds);
  const markCompletionSeen = useNotificationStore((s) => s.markCompletionSeen);

  const unread = items.filter((n) => !n.read).length;

  const { data: connection } = useQuery({
    queryKey: ["connection-status"],
    queryFn: () => api<{ connected: boolean; message: string }>("/dashboard/connection"),
    refetchInterval: 60_000,
  });

  const { data: queueData } = useQuery({
    queryKey: ["import-queue"],
    queryFn: () => api<ImportQueueResponse>("/import-queue"),
    refetchInterval: (query) => {
      const d = query.state.data;
      const busy = Boolean(d?.active || (d?.queue?.length ?? 0) > 0);
      // Sem fila: poll raro. Com fila: 8s (evita 429 no Render Free).
      return busy ? 8_000 : 20_000;
    },
    retry: (failureCount, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429") || msg.includes("503")) return failureCount < 2;
      return failureCount < 1;
    },
    retryDelay: (n) => Math.min(30_000, 3_000 * 2 ** n),
  });

  const [dlOpen, setDlOpen] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    pruneOldDays();
  }, [pruneOldDays]);

  useEffect(() => {
    const recent = queueData?.recent ?? [];
    for (const c of recent) {
      if (seenCompletionIds.includes(c.spreadsheetId)) continue;
      markCompletionSeen(c.spreadsheetId);
      addNotification({
        companyId: c.companyId,
        companyName: c.companyName,
        fileName: c.fileName,
        spreadsheetId: c.spreadsheetId,
        kind: c.ok ? "success" : "error",
        message: c.message,
      });
      void queryClient.invalidateQueries({ queryKey: ["spreadsheets"] });
      void queryClient.invalidateQueries({ queryKey: ["companies"] });
    }
  }, [
    queueData?.recent,
    seenCompletionIds,
    markCompletionSeen,
    addNotification,
    queryClient,
  ]);

  useEffect(() => {
    if (!panelOpen && !dlOpen) return;
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (panelOpen && panelRef.current && !panelRef.current.contains(t)) {
        setPanelOpen(false);
      }
      if (dlOpen && dlRef.current && !dlRef.current.contains(t)) {
        setDlOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [panelOpen, dlOpen, setPanelOpen]);

  function handleNotificationClick(n: (typeof items)[number]) {
    markRead(n.id);
    requestOpenCompany(n.companyId);
    navigate("/dashboard");
  }

  const active = queueData?.active ?? null;
  const waiting = queueData?.queue ?? [];
  const statusLabel = queueData?.statusLabel ?? null;
  const hasQueue = Boolean(active || waiting.length);

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

        {/* Fila / downloads (leve, estilo sino) */}
        <div className="relative flex items-center gap-1.5" ref={dlRef}>
          <button
            type="button"
            onClick={() => {
              setDlOpen(!dlOpen);
              setPanelOpen(false);
            }}
            className="relative rounded-lg p-2 text-text-secondary hover:bg-bg-card hover:text-text-primary"
            aria-label="Fila de envios"
          >
            {hasQueue ? (
              <Loader2 size={20} className="animate-spin text-accent-blue" />
            ) : (
              <Download size={20} />
            )}
            {hasQueue && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-blue px-1 text-[10px] font-bold text-white">
                {(active ? 1 : 0) + waiting.length}
              </span>
            )}
          </button>
          {statusLabel && (
            <span className="hidden text-xs text-text-secondary sm:inline">{statusLabel}…</span>
          )}

          {dlOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-bg-surface shadow-xl">
              <div className="border-b border-border px-4 py-3">
                <p className="text-sm font-medium text-text-primary">Envios em andamento</p>
                <p className="text-[11px] text-text-muted">1 processo por vez · fila global</p>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {!hasQueue ? (
                  <p className="px-4 py-8 text-center text-sm text-text-secondary">
                    Nada na fila agora
                  </p>
                ) : (
                  <>
                    {active && <QueueRow item={active} highlight />}
                    {waiting.map((q) => (
                      <QueueRow key={q.spreadsheetId} item={q} />
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="relative" ref={panelRef}>
          <button
            type="button"
            onClick={() => {
              setPanelOpen(!panelOpen);
              setDlOpen(false);
            }}
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
                    Nenhuma notificação hoje
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
                        {n.message ?? n.fileName}
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

function QueueRow({ item, highlight }: { item: QueueItem; highlight?: boolean }) {
  const phaseLabel =
    item.phase === "sending"
      ? "Enviando"
      : item.phase === "reading"
        ? "Lendo / baixando"
        : "Na fila";

  return (
    <div
      className={cn(
        "border-b border-border/60 px-4 py-3",
        highlight && "bg-accent-blue/5",
      )}
    >
      <p className="truncate text-sm font-medium text-text-primary">{item.fileName}</p>
      <p className="text-xs text-text-secondary">{item.companyName}</p>
      <p className="mt-1 text-[11px] text-text-muted">
        {phaseLabel}
        {item.processMessage ? ` · ${item.processMessage}` : ""}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-card">
        <div
          className="h-full rounded-full bg-accent-blue transition-all"
          style={{ width: `${Math.max(4, item.progressPct)}%` }}
        />
      </div>
    </div>
  );
}
