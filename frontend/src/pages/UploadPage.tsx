// frontend/src/pages/UploadPage.tsx

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { useAuthStore } from "../stores/authStore";

type UploadSolution = {
  id: string;
  label: string;
  description: string;
  defaultTargetTable: string;
};

type FileJob = {
  id: string;
  file: File;
  status: "waiting" | "uploading" | "done" | "error";
  message?: string;
};

export function UploadPage() {
  const token = useAuthStore((s) => s.token);
  const [targetTable, setTargetTable] = useState("pedidos_emissao_avinor");
  const [codedSolutionId, setCodedSolutionId] = useState("avinor_pedidos");
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [running, setRunning] = useState(false);

  const { data: options } = useQuery({
    queryKey: ["upload-options"],
    queryFn: () =>
      api<{
        success: boolean;
        tables: string[];
        solutions: UploadSolution[];
      }>("/upload/options"),
  });

  const tables = options?.tables ?? ["pedidos_emissao_avinor"];
  const solutions = options?.solutions ?? [];

  const onPickFiles = useCallback((list: FileList | null) => {
    if (!list?.length) return;
    const newJobs: FileJob[] = [...list].map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
      status: "waiting",
    }));
    setJobs((prev) => {
      const ids = new Set(prev.map((j) => j.id));
      return [...prev, ...newJobs.filter((j) => !ids.has(j.id))];
    });
  }, []);

  const canStart = jobs.some((j) => j.status === "waiting") && targetTable && codedSolutionId;

  const runQueue = async () => {
    if (!token) {
      toast.error("Faça login novamente.");
      return;
    }
    setRunning(true);
    const queue = jobs.filter((j) => j.status === "waiting");
    let okCount = 0;
    let failCount = 0;

    for (const job of queue) {
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, status: "uploading", message: "Enviando..." } : j)),
      );

      const form = new FormData();
      form.append("file", job.file);
      form.append("targetTable", targetTable);
      form.append("codedSolutionId", codedSolutionId);

      try {
        const res = await fetch("/api/upload/spreadsheet", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        const text = await res.text();
        let data: { success?: boolean; note?: string; error?: string };
        try {
          data = text
            ? (JSON.parse(text) as { success?: boolean; note?: string; error?: string })
            : {};
        } catch {
          throw new Error(
            res.status === 502 || res.status === 503
              ? `Servidor indisponível (HTTP ${res.status}). O Render pode estar reiniciando ou a planilha derrubou o processo — espere 1 min e tente de novo, um arquivo por vez.`
              : `Resposta inválida do servidor (HTTP ${res.status}).`,
          );
        }
        if (!res.ok || !data.success) {
          throw new Error(
            data.error ??
              (res.status === 503
                ? "Serviço temporariamente indisponível (503). Aguarde e tente novamente."
                : "Falha no upload"),
          );
        }
        okCount += 1;
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? { ...j, status: "done", message: data.note ?? "Enviado com sucesso" }
              : j,
          ),
        );
      } catch (e) {
        failCount += 1;
        const msg = e instanceof Error ? e.message : "Erro";
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, status: "error", message: msg } : j)),
        );
      }
    }

    setRunning(false);
    if (failCount > 0 && okCount === 0) {
      toast.error("Nenhum arquivo enviado. Veja as mensagens abaixo.");
    } else if (failCount > 0) {
      toast.warning(`Fila finalizada: ${okCount} ok, ${failCount} com erro.`);
    } else {
      toast.success("Fila de upload finalizada.");
    }
  };

  const summary = useMemo(() => {
    const done = jobs.filter((j) => j.status === "done").length;
    const err = jobs.filter((j) => j.status === "error").length;
    return { done, err, total: jobs.length };
  }, [jobs]);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Upload</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Envio manual de planilhas — uma por vez, mesma lógica das soluções codadas (Pedidos: ffill +
          janela de datas). Planilhas históricas (~60 mil linhas) são pesadas: espere o AUTO do Drive
          terminar e envie <strong className="font-medium text-text-primary">um arquivo</strong> por vez.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-bg-card p-5">
        <label className="block text-sm font-medium text-text-primary">
          Tabela de destino (MySQL)
        </label>
        <select
          value={targetTable}
          onChange={(e) => setTargetTable(e.target.value)}
          className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm"
          disabled={running}
        >
          {tables.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <label className="block text-sm font-medium text-text-primary">
          Método de leitura (solução codada)
        </label>
        <select
          value={codedSolutionId}
          onChange={(e) => setCodedSolutionId(e.target.value)}
          className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm"
          disabled={running}
        >
          {solutions.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        {solutions.find((s) => s.id === codedSolutionId)?.description && (
          <p className="text-xs text-text-secondary">
            {solutions.find((s) => s.id === codedSolutionId)?.description}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-dashed border-border bg-bg-surface/50 p-8 text-center">
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          multiple
          className="hidden"
          id="upload-files"
          disabled={running}
          onChange={(e) => {
            onPickFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <label
          htmlFor="upload-files"
          className={cn(
            "inline-flex cursor-pointer items-center gap-2 rounded-lg bg-accent-blue px-4 py-2.5 text-sm font-medium text-white",
            running && "pointer-events-none opacity-50",
          )}
        >
          <Upload size={18} />
          Selecionar planilhas
        </label>
        <p className="mt-2 text-xs text-text-secondary">Ex.: ped jan-jun 2024.xlsx — envio em fila</p>
      </div>

      {jobs.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">
              {summary.done}/{summary.total} enviadas
              {summary.err > 0 ? ` · ${summary.err} erro(s)` : ""}
            </p>
            <button
              type="button"
              disabled={!canStart || running}
              onClick={() => void runQueue()}
              className="rounded-lg bg-accent-green px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {running ? "Enviando..." : "Iniciar envio"}
            </button>
          </div>

          <ul className="space-y-2">
            {jobs.map((job) => (
              <li
                key={job.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm transition-opacity",
                  job.status === "waiting" && running && "opacity-40",
                  job.status === "uploading" && "border-accent-blue bg-bg-card",
                  job.status === "done" && "border-accent-green/40 bg-accent-green/5",
                  job.status === "error" && "border-accent-red/40 bg-accent-red/5",
                  job.status === "waiting" && !running && "border-border bg-bg-card",
                )}
              >
                {job.status === "uploading" && (
                  <Loader2 className="mt-0.5 shrink-0 animate-spin text-accent-blue" size={18} />
                )}
                {job.status === "done" && (
                  <CheckCircle2 className="mt-0.5 shrink-0 text-accent-green" size={18} />
                )}
                {job.status === "error" && (
                  <XCircle className="mt-0.5 shrink-0 text-accent-red" size={18} />
                )}
                {job.status === "waiting" && (
                  <span className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border border-border" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary">{job.file.name}</p>
                  {job.message && (
                    <p className="mt-1 text-xs text-text-secondary">{job.message}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
