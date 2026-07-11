// frontend/src/components/companies/CompanyFormModal.tsx

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { CompanyDbFields, confirmSaveWithoutDate } from "./CompanyDbFields";

type CompanyFormModalProps = {
  onClose: () => void;
};

export function CompanyFormModal({ onClose }: CompanyFormModalProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"geral" | "banco">("geral");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4F8EF7");
  const [googleFolderId, setGoogleFolderId] = useState("");
  const [targetTable, setTargetTable] = useState("");
  const [dateColumn, setDateColumn] = useState("");
  const [compareColumn, setCompareColumn] = useState("");
  const [primaryKeyColumn, setPrimaryKeyColumn] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api("/companies", {
        method: "POST",
        body: JSON.stringify({
          name,
          color,
          googleFolderId,
          targetTable: targetTable || undefined,
          dateColumn: dateColumn || undefined,
          compareColumn: compareColumn || undefined,
          primaryKeyColumn: primaryKeyColumn || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Empresa criada");
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["companies-all"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSave = () => {
    if (!confirmSaveWithoutDate(dateColumn)) return;
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-hidden rounded-xl border border-border bg-bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">Nova Empresa</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-bg-card">
            <X size={20} />
          </button>
        </div>

        <div className="flex border-b border-border">
          {(["geral", "banco"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 px-4 py-3 text-sm font-medium ${
                tab === t
                  ? "border-b-2 border-accent-blue text-accent-blue"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t === "geral" ? "Geral" : "Banco de Dados"}
            </button>
          ))}
        </div>

        <div className="max-h-[50vh] space-y-4 overflow-auto p-6">
          {tab === "geral" && (
            <>
              <Field label="Nome da empresa">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input"
                  placeholder="Ex: Frigosol"
                />
              </Field>
              <Field label="Cor do card">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-10 w-full cursor-pointer rounded-lg border border-border bg-bg-card"
                />
              </Field>
              <Field label="Pasta do Google Drive">
                <input
                  value={googleFolderId}
                  onChange={(e) => setGoogleFolderId(e.target.value)}
                  className="input"
                  placeholder="Cole o link ou ID da pasta"
                />
                <p className="mt-1 text-xs text-text-muted">
                  URL: drive.google.com/drive/folders/SEU_ID
                </p>
              </Field>
            </>
          )}

          {tab === "banco" && (
            <CompanyDbFields
              targetTable={targetTable}
              dateColumn={dateColumn}
              compareColumn={compareColumn}
              primaryKeyColumn={primaryKeyColumn}
              onTargetTableChange={setTargetTable}
              onDateColumnChange={setDateColumn}
              onCompareColumnChange={setCompareColumn}
              onPrimaryKeyColumnChange={setPrimaryKeyColumn}
              enabled={tab === "banco"}
            />
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name || !googleFolderId || mutation.isPending}
            className="btn-primary"
          >
            Criar empresa
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-text-secondary">{label}</span>
      {children}
    </label>
  );
}
