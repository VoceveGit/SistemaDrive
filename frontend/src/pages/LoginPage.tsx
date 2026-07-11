// frontend/src/pages/LoginPage.tsx

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowRight, Eye, EyeOff, Lock, Mail } from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../stores/authStore";

const REMEMBER_KEY = "despacho-remember-email";

export function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBER_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(() => Boolean(localStorage.getItem(REMEMBER_KEY)));
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api<{
        token: string;
        user: { id: string; email: string; name: string };
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (remember) localStorage.setItem(REMEMBER_KEY, email);
      else localStorage.removeItem(REMEMBER_KEY);
      setAuth(res.token, res.user);
      toast.success(`Bem-vindo, ${res.user.name}!`);
      navigate("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro no login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Painel esquerdo — arte */}
      <aside className="relative hidden w-[48%] overflow-hidden bg-[#0a1628] lg:block">
        <img
          src="/login-bg.png"
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628]/80 via-transparent to-[#0a1628]/40" />

        <div className="relative z-10 flex h-full flex-col justify-between p-10">
          <p className="flex items-center gap-2.5 text-[11px] font-medium tracking-[0.22em] text-[#8E8A7E]">
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#C41E3A]" aria-hidden />
            DESPACHO · EST. 2026
          </p>
          <p className="text-[11px] tracking-wide text-[#6B665E]/80">
            Voceve · planilhas → banco de dados
          </p>
        </div>
      </aside>

      {/* Painel direito — formulário */}
      <main className="flex w-full flex-col justify-center bg-[#F4F1EC] px-8 py-12 sm:px-14 lg:w-[52%] lg:px-20 xl:px-28">
        <div className="mx-auto w-full max-w-[400px]">
          <p className="mb-3 text-[11px] font-semibold tracking-[0.2em] text-[#8A857C]">
            ACESSO AO SISTEMA
          </p>
          <h1
            className="text-[2.15rem] leading-tight text-[#1A1A1A]"
            style={{ fontFamily: '"Instrument Serif", Georgia, serif' }}
          >
            Bem-vindo de volta.
          </h1>
          <p className="mt-2 text-sm text-[#6B665E]">
            Entre com suas credenciais para continuar despachando.
          </p>

          <form onSubmit={handleSubmit} className="mt-10 space-y-5">
            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold tracking-[0.14em] text-[#6B665E]">
                E-MAIL
              </span>
              <div className="relative">
                <Mail
                  className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-[#9A958C]"
                  size={17}
                  aria-hidden
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-[#D9D4CB] bg-white py-3 pr-3 text-sm text-[#1A1A1A] outline-none transition placeholder:text-[#B0AAA0] focus:border-[#1A1A1A]"
                  style={{ paddingLeft: "2.75rem" }}
                  placeholder="voce@empresa.com"
                  required
                  autoComplete="email"
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold tracking-[0.14em] text-[#6B665E]">
                SENHA
              </span>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-[#9A958C]"
                  size={17}
                  aria-hidden
                />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-[#D9D4CB] bg-white py-3 pr-11 text-sm text-[#1A1A1A] outline-none transition placeholder:text-[#B0AAA0] focus:border-[#1A1A1A]"
                  style={{ paddingLeft: "2.75rem" }}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A958C] hover:text-[#1A1A1A]"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>

            <label className="flex cursor-pointer items-center gap-2.5 pt-1">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-[#D9D4CB] accent-[#1A1A1A]"
              />
              <span className="text-sm text-[#6B665E]">
                Manter-me conectado neste dispositivo
              </span>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#1A1A1A] py-3.5 text-sm font-medium text-white transition hover:bg-[#2C2C2C] disabled:opacity-50"
            >
              {loading ? "Entrando..." : "Entrar"}
              {!loading && <ArrowRight size={16} />}
            </button>
          </form>

          <p className="mt-12 text-center text-[10px] tracking-[0.12em] text-[#9A958C]">
            © 2026 DESPACHO · VOCEVE
          </p>
        </div>
      </main>
    </div>
  );
}
