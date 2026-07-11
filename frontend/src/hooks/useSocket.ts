// frontend/src/hooks/useSocket.ts — WebSocket para notificações

import { useEffect } from "react";
import { io } from "socket.io-client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import { useNotificationStore } from "../stores/notificationStore";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ??
  (import.meta.env.PROD ? window.location.origin : "http://localhost:3001");

export function useSocket() {
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const addNotification = useNotificationStore((s) => s.addNotification);

  useEffect(() => {
    if (!token) return;

    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });

    socket.on(
      "new_spreadsheet",
      (payload: {
        companyId: string;
        companyName: string;
        fileName: string;
        spreadsheetId?: string;
      }) => {
        addNotification(payload);
        toast.success(`Nova planilha — ${payload.companyName}`, {
          description: payload.fileName,
        });
        queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
        queryClient.invalidateQueries({ queryKey: ["companies"] });
        queryClient.invalidateQueries({ queryKey: ["spreadsheets", payload.companyId] });
      },
    );

    return () => {
      socket.disconnect();
    };
  }, [token, queryClient, addNotification]);
}
