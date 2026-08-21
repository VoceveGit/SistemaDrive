// frontend/src/components/dashboard/CompanyDrawer.tsx

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  X,
  Settings,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  RefreshCw,
  FileSpreadsheet,
} from "lucide-react";
import { api, type Company, type Spreadsheet } from "../../lib/api";
import { cn, formatDateTime, formatNumber } from "../../lib/utils";
import { SpreadsheetDiff } from "./SpreadsheetDiff";
import { CompanySettingsModal } from "../companies/CompanySettingsModal";

type CompanyDrawerProps = {
  company: Company;
  onClose: () => void;
};

type DriveFileRow = {
  id: string;
  name: string;
  modifiedTime: string | null;
  size: string | null;
  spreadsheetId: string | null;
  spreadsheetStatus: string | null;
};

const statusLabels: Record<string, { label: string; className: string }> = {
  queued: {
    label: "Na fila",
    className: "bg-accent-blue/20 text-accent-blue",
  },
  processing: {
    label: "Processando...",
    className: "bg-text-muted/20 text-text-muted",
  },
  pending: { label: "Aguardando", className: "bg-accent-amber/20 text-accent-amber" },
  approved: { label: "Aprovado", className: "bg-accent-blue/20 text-accent-blue" },
  sent: { label: "Enviado", className: "bg-accent-green/20 text-accent-green" },
  error: { label: "Erro", className: "bg-accent-red/20 text-accent-red" },
  no_new_items: {
    label: "Nenhum item novo",
    className: "bg-accent-amber/20 text-accent-amber",
  },
};

function formatBytes(size: string | null): string {
  if (!size) return "—";
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function CompanyDrawer({ company, onClose }: CompanyDrawerProps) {
  const [tab, setTab] = useState<"drive" | "historico">("drive");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const queryClient = useQueryClient();

  const {
    data: driveData,
    isLoading: driveLoading,
    isFetching: driveFetching,
    refetch: refetchDrive,
  } = useQuery({
    queryKey: ["drive-files", company.id],
    queryFn: () =>
      api<{ files: DriveFileRow[] }>(`/companies/${company.id}/drive-files`),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["spreadsheets", company.id],
    queryFn: () =>
      api<{ spreadsheets: Spreadsheet[] }>(`/companies/${company.id}/spreadsheets`),
    refetchInterval: (query) => {
      const list = query.state.data?.spreadsheets ?? [];
      return list.some((s) => s.status === "processing") ? 3000 : false;
    },
  });

  const selectMutation = useMutation({
    mutationFn: (googleFileId: string) =>
      api<{ spreadsheetId: string }>(`/companies/${company.id}/drive-files/select`, {
        method: "POST",
        body: JSON.stringify({ googleFileId }),
      }),
    onSuccess: (res) => {
      toast.success("Arquivo selecionado — carregando dados…");
      queryClient.invalidateQueries({ queryKey: ["spreadsheets", company.id] });
      queryClient.invalidateQueries({ queryKey: ["drive-files", company.id] });
      queryClient.invalidateQueries({ queryKey: ["diff"] });
      setTab("historico");
      if (res.spreadsheetId) setExpandedId(res.spreadsheetId);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const processMutation = useMutation({
    mutationFn: (spreadsheetId: string) =>
      api(`/spreadsheets/${spreadsheetId}/process`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Reprocessando com a configuração atual…");
      queryClient.invalidateQueries({ queryKey: ["spreadsheets", company.id] });
      queryClient.invalidateQueries({ queryKey: ["diff"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const spreadsheets = data?.spreadsheets ?? [];
  const driveFiles = driveData?.files ?? [];

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[min(96vw,1100px)] flex-col border-l border-border bg-bg-surface shadow-2xl">
        <div
          className="flex items-center justify-between border-b border-border px-6 py-4"
          style={{ borderTopWidth: 4, borderTopColor: company.color }}
        >
          <div>
            <h2 className="text-xl font-bold text-text-primary">{company.name}</h2>
            <p className="text-sm text-text-secondary">
              Escolha o arquivo no Drive — os dados só carregam ao selecionar
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-bg-card"
            >
              <Settings size={16} /> Configurar
            </button>
            <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-bg-card">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex gap-1 border-b border-border px-6 pt-3">
          <TabBtn active={tab === "drive"} onClick={() => setTab("drive")}>
            Arquivos no Drive
          </TabBtn>
          <TabBtn active={tab === "historico"} onClick={() => setTab("historico")}>
            Histórico ({spreadsheets.length})
          </TabBtn>
        </div>

        <div className="min-w-0 flex-1 overflow-auto p-6">
          {tab === "drive" ? (
            <DriveFilesPanel
              files={driveFiles}
              loading={driveLoading}
              refreshing={driveFetching}
              selectingId={selectMutation.isPending ? "busy" : null}
              onRefresh={() => refetchDrive()}
              onSelect={(id) => selectMutation.mutate(id)}
              onOpenHistory={(spreadsheetId) => {
                setExpandedId(spreadsheetId);
                setTab("historico");
              }}
            />
          ) : isLoading ? (
            <p className="text-text-secondary">Carregando histórico...</p>
          ) : spreadsheets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-12 text-center">
              <p className="text-text-secondary">Nenhuma planilha processada ainda</p>
              <p className="mt-2 text-xs text-text-muted">
                Vá em &quot;Arquivos no Drive&quot; e selecione um arquivo para carregar
              </p>
              <button
                type="button"
                className="btn-primary mt-4"
                onClick={() => setTab("drive")}
              >
                Ver arquivos no Drive
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg-card">
                  <tr>
                    <th className="px-4 py-3 text-text-secondary">Arquivo</th>
                    <th className="px-4 py-3 text-text-secondary">Data/Hora</th>
                    <th className="px-4 py-3 text-text-secondary">Linhas</th>
                    <th className="px-4 py-3 text-text-secondary">Novas</th>
                    <th className="px-4 py-3 text-text-secondary">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {spreadsheets.map((sheet) => {
                    const isProcessing = sheet.status === "processing";
                    const isExpanded =
                      expandedId === sheet.id &&
                      !isProcessing &&
                      sheet.status !== "queued";
                    const st = statusLabels[sheet.status] ?? statusLabels.pending;
                    return (
                      <SpreadsheetRow
                        key={sheet.id}
                        sheet={sheet}
                        isExpanded={isExpanded}
                        status={st}
                        companyId={company.id}
                        processingBusy={processMutation.isPending}
                        onProcess={() => processMutation.mutate(sheet.id)}
                        onToggle={() => {
                          if (isProcessing) return;
                          setExpandedId(isExpanded ? null : sheet.id);
                        }}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showSettings && (
        <CompanySettingsModal company={company} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-t-lg px-4 py-2 text-sm font-medium",
        active
          ? "border border-b-0 border-border bg-bg-surface text-text-primary"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

function DriveFilesPanel({
  files,
  loading,
  refreshing,
  selectingId,
  onRefresh,
  onSelect,
  onOpenHistory,
}: {
  files: DriveFileRow[];
  loading: boolean;
  refreshing: boolean;
  selectingId: string | null;
  onRefresh: () => void;
  onSelect: (googleFileId: string) => void;
  onOpenHistory: (spreadsheetId: string) => void;
}) {
  if (loading) {
    return <p className="text-text-secondary">Listando arquivos do Drive…</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          Só nomes e datas — nada é baixado até você clicar em <strong>Carregar</strong>.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg-card disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          Atualizar lista
        </button>
      </div>

      {files.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <p className="text-text-secondary">Nenhuma planilha na pasta do Drive</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg-card">
              <tr>
                <th className="px-4 py-3 text-text-secondary">Nome</th>
                <th className="px-4 py-3 text-text-secondary">Modificado</th>
                <th className="px-4 py-3 text-text-secondary">Tamanho</th>
                <th className="px-4 py-3 text-text-secondary">No sistema</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const st = f.spreadsheetStatus
                  ? statusLabels[f.spreadsheetStatus]
                  : null;
                const busy = selectingId === "busy";
                return (
                  <tr key={f.id} className="border-t border-border hover:bg-bg-card/40">
                    <td className="px-4 py-3 font-medium">
                      <span className="inline-flex items-center gap-2">
                        <FileSpreadsheet size={16} className="text-accent-green shrink-0" />
                        {f.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {f.modifiedTime ? formatDateTime(f.modifiedTime) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-text-secondary">
                      {formatBytes(f.size)}
                    </td>
                    <td className="px-4 py-3">
                      {st ? (
                        <button
                          type="button"
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs font-medium",
                            st.className,
                          )}
                          onClick={() =>
                            f.spreadsheetId && onOpenHistory(f.spreadsheetId)
                          }
                        >
                          {st.label}
                        </button>
                      ) : (
                        <span className="text-xs text-text-muted">Não carregado</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onSelect(f.id)}
                        className="inline-flex items-center gap-1 rounded-lg bg-accent-blue px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Play size={12} />
                        )}
                        Carregar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SpreadsheetRow({
  sheet,
  isExpanded,
  status,
  companyId,
  processingBusy,
  onProcess,
  onToggle,
}: {
  sheet: Spreadsheet;
  isExpanded: boolean;
  status: { label: string; className: string };
  companyId: string;
  processingBusy: boolean;
  onProcess: () => void;
  onToggle: () => void;
}) {
  const isProcessing = sheet.status === "processing";
  const canReprocess =
    sheet.status === "queued" ||
    sheet.status === "error" ||
    sheet.status === "processing" ||
    sheet.status === "pending" ||
    sheet.status === "approved" ||
    sheet.status === "no_new_items";
  const progress =
    sheet.totalRows > 0
      ? `${formatNumber(sheet.processedRows ?? 0)} / ${formatNumber(sheet.totalRows)}`
      : null;

  return (
    <>
      <tr
        className={cn(
          "border-t border-border",
          isProcessing
            ? "cursor-default opacity-60"
            : sheet.status === "queued"
              ? "cursor-default"
              : "cursor-pointer hover:bg-bg-card/50",
        )}
        onClick={onToggle}
      >
        <td
          className={cn(
            "px-4 py-3 font-medium",
            isProcessing && "text-text-muted",
          )}
        >
          <span className="inline-flex items-center gap-2">
            {isProcessing && <Loader2 size={14} className="animate-spin text-text-muted" />}
            {sheet.fileName}
          </span>
          {(sheet.processMessage || progress) && (
            <p className="mt-0.5 text-xs font-normal text-text-muted">
              {sheet.processMessage ?? progress}
            </p>
          )}
        </td>
        <td className="px-4 py-3 text-text-secondary">{formatDateTime(sheet.detectedAt)}</td>
        <td className="px-4 py-3 font-mono">{formatNumber(sheet.totalRows)}</td>
        <td className="px-4 py-3 font-mono text-accent-green">
          {formatNumber(sheet.newRows)}
        </td>
        <td className="px-4 py-3">
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", status.className)}>
            {status.label}
          </span>
        </td>
        <td className="px-4 py-3 text-text-secondary" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            {canReprocess && (
              <button
                type="button"
                disabled={processingBusy}
                onClick={onProcess}
                title="Relê o arquivo do Drive com a config atual"
                className="inline-flex items-center gap-1 rounded-lg bg-accent-blue px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                <Play size={12} />{" "}
                {sheet.status === "pending" || sheet.status === "approved"
                  ? "Reprocessar"
                  : "Processar"}
              </button>
            )}
            {!isProcessing && sheet.status !== "queued" && (
              isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />
            )}
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={6} className="max-w-0 p-0">
            <div className="min-w-0 w-full">
              <SpreadsheetDiff
                spreadsheetId={sheet.id}
                status={sheet.status}
                companyId={companyId}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
