// frontend/src/stores/notificationStore.ts — Notificações do sininho (só do dia)

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppNotification = {
  id: string;
  companyId: string;
  companyName: string;
  fileName: string;
  spreadsheetId?: string;
  receivedAt: string;
  read: boolean;
  kind?: "new" | "success" | "error";
  message?: string;
};

function startOfTodayLocal(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isToday(iso: string): boolean {
  const t = new Date(iso).getTime();
  return t >= startOfTodayLocal().getTime();
}

type NotificationState = {
  items: AppNotification[];
  panelOpen: boolean;
  pendingOpenCompanyId: string | null;
  /** IDs de completion já convertidos em notificação */
  seenCompletionIds: string[];
  addNotification: (payload: {
    companyId: string;
    companyName: string;
    fileName: string;
    spreadsheetId?: string;
    kind?: AppNotification["kind"];
    message?: string;
  }) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  setPanelOpen: (open: boolean) => void;
  requestOpenCompany: (companyId: string) => void;
  clearPendingOpenCompany: () => void;
  pruneOldDays: () => void;
  markCompletionSeen: (spreadsheetId: string) => void;
};

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      items: [],
      panelOpen: false,
      pendingOpenCompanyId: null,
      seenCompletionIds: [],
      addNotification: (payload) =>
        set((state) => {
          const todayItems = state.items.filter((n) => isToday(n.receivedAt));
          return {
            items: [
              {
                id: `${payload.companyId}-${payload.spreadsheetId ?? Date.now()}-${payload.kind ?? "new"}`,
                companyId: payload.companyId,
                companyName: payload.companyName,
                fileName: payload.fileName,
                spreadsheetId: payload.spreadsheetId,
                receivedAt: new Date().toISOString(),
                read: false,
                kind: payload.kind ?? "new",
                message: payload.message,
              },
              ...todayItems,
            ].slice(0, 40),
          };
        }),
      markRead: (id) =>
        set((state) => ({
          items: state.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
        })),
      markAllRead: () =>
        set((state) => ({
          items: state.items.map((n) => ({ ...n, read: true })),
        })),
      setPanelOpen: (open) => set({ panelOpen: open }),
      requestOpenCompany: (companyId) =>
        set({ pendingOpenCompanyId: companyId, panelOpen: false }),
      clearPendingOpenCompany: () => set({ pendingOpenCompanyId: null }),
      pruneOldDays: () =>
        set((state) => ({
          items: state.items.filter((n) => isToday(n.receivedAt)),
          seenCompletionIds: state.seenCompletionIds.slice(0, 50),
        })),
      markCompletionSeen: (spreadsheetId) => {
        const seen = get().seenCompletionIds;
        if (seen.includes(spreadsheetId)) return;
        set({ seenCompletionIds: [spreadsheetId, ...seen].slice(0, 80) });
      },
    }),
    {
      name: "despacho-notifications",
      partialize: (state) => ({
        items: state.items,
        seenCompletionIds: state.seenCompletionIds,
      }),
    },
  ),
);
