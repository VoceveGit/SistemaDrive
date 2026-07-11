// frontend/src/pages/SettingsPage.tsx

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, HardDrive, Bell, Eye, EyeOff } from "lucide-react";
import { api, type AppSettings } from "../lib/api";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"db" | "google" | "notifications">("db");
  const [showPassword, setShowPassword] = useState(false);

  const [dbType, setDbType] = useState("mysql");
  const [dbHost, setDbHost] = useState("");
  const [dbPort, setDbPort] = useState(3306);
  const [dbName, setDbName] = useState("");
  const [dbUser, setDbUser] = useState("");
  const [dbPassword, setDbPassword] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [wsEnabled, setWsEnabled] = useState(true);

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: AppSettings | null }>("/settings"),
  });

  useEffect(() => {
    if (data?.settings) {
      const s = data.settings;
      setDbType(s.dbType);
      setDbHost(s.dbHost);
      setDbPort(s.dbPort);
      setDbName(s.dbName);
      setDbUser(s.dbUser);
    }
  }, [data]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      toast.success(`Google conectado: ${params.get("email") ?? ""}`);
      window.history.replaceState({}, "", "/settings");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  }, [queryClient]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api("/settings", {
        method: "POST",
        body: JSON.stringify({ dbType, dbHost, dbPort, dbName, dbUser, dbPassword }),
      }),
    onSuccess: () => {
      toast.success("Configurações salvas");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["connection-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testMutation = useMutation({
    mutationFn: () => api<{ success: boolean; message: string }>("/settings/test-connection", { method: "POST" }),
    onSuccess: (res) => {
      if (res.success) toast.success(res.message);
      else toast.error(res.message);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const settings = data?.settings;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Configurações</h2>
        <p className="text-sm text-text-secondary">
          Conexão com banco de destino, Google Drive e notificações
        </p>
      </div>

      <div className="flex gap-2 border-b border-border">
        {[
          { id: "db" as const, label: "Banco de Dados", icon: Database },
          { id: "google" as const, label: "Google Drive", icon: HardDrive },
          { id: "notifications" as const, label: "Notificações", icon: Bell },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium ${
              tab === id
                ? "border-b-2 border-accent-blue text-accent-blue"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-bg-surface p-6">
        {tab === "db" && (
          <div className="space-y-4">
            {!settings?.dbHost && (
              <div className="rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
                Conexão com o banco de destino ainda não foi salva. Sem isso, as tabelas não
                aparecem na configuração das empresas.
              </div>
            )}
            <p className="text-sm text-text-secondary">
              Banco onde os dados aprovados serão inseridos. Para testes, use a tabela{" "}
              <strong className="text-text-primary">zz_spreadsheet_sync_test</strong> na configuração de cada empresa.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-sm text-text-secondary">Tipo de banco</span>
              <select
                value={dbType}
                onChange={(e) => setDbType(e.target.value)}
                className="input"
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Host" value={dbHost} onChange={setDbHost} />
              <Field label="Porta" value={String(dbPort)} onChange={(v) => setDbPort(Number(v))} />
            </div>
            <Field label="Nome do banco" value={dbName} onChange={setDbName} />
            <Field label="Usuário" value={dbUser} onChange={setDbUser} />
            <label className="block">
              <span className="mb-1.5 block text-sm text-text-secondary">Senha</span>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={dbPassword}
                  onChange={(e) => setDbPassword(e.target.value)}
                  className="input pr-10"
                  placeholder={settings?.hasPassword ? "••••••••" : ""}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
                className="btn-secondary"
              >
                Testar conexão
              </button>
              <button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="btn-primary"
              >
                Salvar
              </button>
            </div>
          </div>
        )}

        {tab === "google" && (
          <div className="space-y-4">
            <div className="rounded-lg bg-bg-card p-4 text-sm text-text-secondary">
              <p className="font-medium text-text-primary">Service Account (recomendado)</p>
              <p className="mt-2">
                Use o mesmo arquivo <code className="text-xs">drive-credentials.json</code> do sistema antigo.
                Coloque em <code className="text-xs">backend/config/</code> ou aponte no{" "}
                <code className="text-xs">GOOGLE_APPLICATION_CREDENTIALS</code> do .env.
              </p>
              <p className="mt-2 text-accent-amber">
                Compartilhe cada pasta do Drive com o e-mail da Service Account (termina em{" "}
                <code className="text-xs">.iam.gserviceaccount.com</code>).
              </p>
            </div>

            {settings?.googleConnected ? (
              <div className="flex items-center justify-between rounded-lg border border-accent-green/30 bg-accent-green/10 p-4">
                <div>
                  <p className="font-medium text-accent-green">Drive conectado</p>
                  <p className="text-sm text-text-secondary">{settings.googleEmail}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">
                Reinicie o backend após configurar o arquivo JSON. O status aparecerá aqui automaticamente.
              </p>
            )}

            <details className="text-sm text-text-secondary">
              <summary className="cursor-pointer text-text-primary">OAuth alternativo (opcional)</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env</li>
                <li>Callback: http://localhost:3001/api/auth/google/callback</li>
              </ol>
              <a href={`${API_BASE}/auth/google`} className="btn-secondary mt-3 inline-flex text-sm">
                Conectar com OAuth
              </a>
            </details>
          </div>
        )}

        {tab === "notifications" && (
          <div className="space-y-4">
            <Toggle
              label="Notificações em tempo real (WebSocket)"
              checked={wsEnabled}
              onChange={setWsEnabled}
            />
            <Toggle
              label="Som ao receber nova planilha"
              checked={soundEnabled}
              onChange={setSoundEnabled}
            />
            <p className="text-xs text-text-muted">
              Preferências salvas localmente neste navegador
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-text-secondary">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="input" />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border p-4">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 accent-accent-blue"
      />
    </label>
  );
}
