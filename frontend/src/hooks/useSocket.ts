// frontend/src/hooks/useSocket.ts — WebSocket para notificações (sem loop de reconnect)

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
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

/** Em produção Free: sem reconnect automático (evita tempestade de 429). */
export function useSocket() {
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const addNotification = useNotificationStore((s) => s.addNotification);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    // Aguarda um pouco após o load pra não competir com as queries iniciais
    const startTimer = setTimeout(() => {
      if (socketRef.current) return;

      const socket = io(SOCKET_URL, {
        transports: ["polling"],
        upgrade: false,
        reconnection: false,
        autoConnect: true,
        timeout: 20000,
      });
      socketRef.current = socket;

      const scheduleRefresh = (companyId: string) => {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
          queryClient.invalidateQueries({ queryKey: ["companies"] });
          queryClient.invalidateQueries({ queryKey: ["spreadsheets", companyId] });
        }, 2000);
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
          scheduleRefresh(payload.companyId);
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

        scheduleRefresh(payload.companyId);
      });

      socket.on("connect_error", () => {
        socket.disconnect();
      });
    }, 5000);

    return () => {
      clearTimeout(startTimer);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [token, queryClient, addNotification]);
}
