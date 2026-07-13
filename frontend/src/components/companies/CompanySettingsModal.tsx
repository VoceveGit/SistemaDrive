// frontend/src/components/companies/CompanySettingsModal.tsx

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api, type Company } from "../../lib/api";
import { CompanyDbFields, confirmSaveWithoutDate } from "./CompanyDbFields";

type CompanySettingsModalProps = {
  company: Company;
  onClose: () => void;
};

export function CompanySettingsModal({ company, onClose }: CompanySettingsModalProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"geral" | "banco">("geral");
  const [name, setName] = useState(company.name);
  const [color, setColor] = useState(company.color);
  const [googleFolderId, setGoogleFolderId] = useState(company.googleFolderId);
  const [autoSend, setAutoSend] = useState(company.autoSend ?? false);
  const [targetTable, setTargetTable] = useState(company.targetTable ?? "");
  const [dateColumn, setDateColumn] = useState(company.dateColumn ?? "");
  const [compareColumn, setCompareColumn] = useState(company.compareColumn ?? "");
  const [primaryKeyColumn, setPrimaryKeyColumn] = useState(company.primaryKeyColumn ?? "");

  const mutation = useMutation({
    mutationFn: () =>
      api(`/companies/${company.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          color,
          googleFolderId,
          autoSend,
          targetTable: targetTable || null,
          dateColumn: dateColumn || null,
          compareColumn: compareColumn || null,
          primaryKeyColumn: primaryKeyColumn || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Configurações salvas");
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["companies-all"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  useEffect(() => {
    if (!targetTable && company.targetTable) setTargetTable(company.targetTable);
  }, [company.targetTable, targetTable]);

  const handleSave = () => {
    if (!confirmSaveWithoutDate(dateColumn)) return;
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-hidden rounded-xl border border-border bg-bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">Configurar — {company.name}</h2>
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
              <Input label="Nome" value={name} onChange={setName} />
              <label className="block">
                <span className="mb-1.5 block text-sm text-text-secondary">Cor</span>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-10 w-full cursor-pointer rounded-lg border border-border"
                />
              </label>
              <Input
                label="Pasta do Google Drive"
                value={googleFolderId}
                onChange={setGoogleFolderId}
              />
              <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-card p-4">
                <input
                  type="checkbox"
                  checked={autoSend}
                  onChange={(e) => setAutoSend(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium text-text-primary">Envio automático</span>
                  <span className="mt-1 block text-sm text-text-secondary">
                    Ao detectar planilha nova/atualizada, compara com o banco e envia só o que falta.
                    Em caso de erro, o automático desta empresa é desligado.
                  </span>
                </span>
              </label>
            </>
          )}

          {tab === "banco" && (
            <CompanyDbFields
              companyId={company.id}
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
            disabled={mutation.isPending}
            className="btn-primary"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function Input({
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
