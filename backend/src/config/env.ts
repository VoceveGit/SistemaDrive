// backend/src/config/env.ts — Variáveis de ambiente tipadas

import dotenv from "dotenv";
dotenv.config({ override: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

export const env = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:5173",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3001/api/auth/google/callback",
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  adminEmail: process.env.ADMIN_EMAIL ?? "admin@voceve.com",
  adminPassword: process.env.ADMIN_PASSWORD ?? "admin123",
  adminName: process.env.ADMIN_NAME ?? "Administrador",
};

export function assertDatabaseUrl(): void {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL não configurada. Configure o PostgreSQL (Neon) no .env");
  }
}
