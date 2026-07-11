// backend/src/index.ts — Entry point do servidor

import express from "express";
import cors from "cors";
import cron from "node-cron";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config({ override: true });
import { env, assertDatabaseUrl } from "./config/env.js";
import router from "./routes/index.js";
import { seedAdmin } from "./controllers/authController.js";
import { pollAllCompanies, setSocketServer } from "./services/googleDriveService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Em produção: backend/dist/src → ../../../frontend/dist */
const frontendDist = path.resolve(__dirname, "../../../frontend/dist");

async function main() {
  assertDatabaseUrl();

  const app = express();
  const httpServer = createServer(app);
  const serveFrontend = env.nodeEnv === "production" || existsSync(frontendDist);

  const io = new SocketServer(httpServer, {
    cors: {
      origin: serveFrontend ? true : env.frontendUrl,
      methods: ["GET", "POST"],
    },
  });

  setSocketServer(io);

  app.use(
    cors({
      origin: serveFrontend ? true : env.frontendUrl,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "50mb" }));

  app.use("/api", router);

  if (serveFrontend) {
    app.use(express.static(frontendDist));
    app.get(/^(?!\/api(?:\/|$)|\/socket\.io(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  await seedAdmin();

  cron.schedule("*/2 * * * *", () => {
    pollAllCompanies().catch((err) => console.error("Erro no polling:", err));
  });

  pollAllCompanies().catch((err) => console.error("Erro na varredura inicial:", err));

  httpServer.listen(env.port, () => {
    console.log(`Despacho API rodando em http://localhost:${env.port}`);
    if (serveFrontend) {
      console.log(`Frontend estático: ${frontendDist}`);
    }
  });
}

main().catch((err) => {
  console.error("Falha ao iniciar servidor:", err);
  process.exit(1);
});
