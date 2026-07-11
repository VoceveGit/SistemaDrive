// frontend/src/stores/notificationStore.ts — Notificações do sininho

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
};

type NotificationState = {
  items: AppNotification[];
  panelOpen: boolean;
  pendingOpenCompanyId: string | null;
  addNotification: (payload: {
    companyId: string;
    companyName: string;
    fileName: string;
    spreadsheetId?: string;
  }) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  setPanelOpen: (open: boolean) => void;
  requestOpenCompany: (companyId: string) => void;
  clearPendingOpenCompany: () => void;
};

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      items: [],
      panelOpen: false,
      pendingOpenCompanyId: null,
      addNotification: (payload) =>
        set((state) => ({
          items: [
            {
              id: `${payload.companyId}-${payload.spreadsheetId ?? Date.now()}`,
              companyId: payload.companyId,
              companyName: payload.companyName,
              fileName: payload.fileName,
              spreadsheetId: payload.spreadsheetId,
              receivedAt: new Date().toISOString(),
              read: false,
            },
            ...state.items,
          ].slice(0, 30),
        })),
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
    }),
    {
      name: "despacho-notifications",
      partialize: (state) => ({ items: state.items }),
    },
  ),
);
