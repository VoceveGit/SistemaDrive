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

type AutoProcessedPayload = {
  companyId: string;
  companyName: string;
  fileName: string;
  spreadsheetId?: string;
  status: "sent" | "no_new_items" | "error";
  message?: string;
  autoSendDisabled?: boolean;
  insertedCount?: number;
};

export function useSocket() {
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const addNotification = useNotificationStore((s) => s.addNotification);

  useEffect(() => {
    if (!token) return;

    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });

    const refreshCompany = (companyId: string) => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["companies-all"] });
      queryClient.invalidateQueries({ queryKey: ["spreadsheets", companyId] });
    };

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
        refreshCompany(payload.companyId);
      },
    );

    socket.on("spreadsheet_auto_processed", (payload: AutoProcessedPayload) => {
      addNotification({
        companyId: payload.companyId,
        companyName: payload.companyName,
        fileName: payload.fileName,
        spreadsheetId: payload.spreadsheetId,
      });

      if (payload.status === "sent") {
        toast.success(`Envio automático — ${payload.companyName}`, {
          description: payload.message ?? payload.fileName,
        });
      } else if (payload.status === "no_new_items") {
        toast.warning(`Nenhum item novo — ${payload.companyName}`, {
          description: payload.fileName,
        });
      } else {
        toast.error(`Erro no envio automático — ${payload.companyName}`, {
          description: payload.autoSendDisabled
            ? `${payload.message ?? "Falha"}. Envio automático desligado.`
            : (payload.message ?? "Falha no envio"),
        });
      }

      refreshCompany(payload.companyId);
    });

    return () => {
      socket.disconnect();
    };
  }, [token, queryClient, addNotification]);
}
