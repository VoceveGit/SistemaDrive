// backend/src/controllers/authController.ts — Login e sessão

import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { signToken } from "../middlewares/auth.js";

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ success: false, error: "E-mail e senha são obrigatórios" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ success: false, error: "Credenciais inválidas" });
      return;
    }

    const token = signToken({ userId: user.id, email: user.email, name: user.name });
    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro no login";
    res.status(500).json({ success: false, error: message });
  }
}

export async function me(req: Request, res: Response): Promise<void> {
  res.json({ success: true, user: req.user });
}

export async function seedAdmin(): Promise<void> {
  const count = await prisma.user.count();
  if (count > 0) return;

  const passwordHash = await bcrypt.hash(env.adminPassword, 10);
  await prisma.user.create({
    data: {
      email: env.adminEmail,
      passwordHash,
      name: env.adminName,
    },
  });
  console.log(`Usuário admin criado: ${env.adminEmail}`);
}
