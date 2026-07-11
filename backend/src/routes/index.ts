// backend/src/routes/index.ts — Rotas da API

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { login, me } from "../controllers/authController.js";
import {
  getSettings,
  saveSettings,
  testDbConnection,
  googleAuth,
  googleCallback,
  googleDisconnect,
  googleStatus,
} from "../controllers/settingsController.js";
import {
  listCompanies,
  listAllCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  getCompanyTables,
  getCompanyColumns,
  getTablesPreview,
  getColumnsPreview,
  getCompanySpreadsheets,
  getCompany,
} from "../controllers/companiesController.js";
import {
  getDiff,
  approveSpreadsheet,
  sendSpreadsheet,
  sendTestSpreadsheet,
} from "../controllers/spreadsheetsController.js";
import { getStats, getConnectionStatus } from "../controllers/dashboardController.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

router.post("/auth/login", login);
router.get("/auth/google", googleAuth);
router.get("/auth/google/callback", googleCallback);

router.use(authMiddleware);

router.get("/auth/me", me);
router.get("/settings", getSettings);
router.post("/settings", saveSettings);
router.post("/settings/test-connection", testDbConnection);
router.get("/settings/google/status", googleStatus);
router.post("/settings/google/disconnect", googleDisconnect);

router.get("/dashboard/stats", getStats);
router.get("/dashboard/connection", getConnectionStatus);

router.get("/companies", listCompanies);
router.get("/companies/all", listAllCompanies);
router.get("/companies/tables-preview", getTablesPreview);
router.get("/companies/columns-preview", getColumnsPreview);
router.post("/companies", createCompany);
router.get("/companies/:id", getCompany);
router.put("/companies/:id", updateCompany);
router.delete("/companies/:id", deleteCompany);
router.get("/companies/:id/tables", getCompanyTables);
router.get("/companies/:id/columns", getCompanyColumns);
router.get("/companies/:id/spreadsheets", getCompanySpreadsheets);

router.get("/spreadsheets/:id/diff", getDiff);
router.post("/spreadsheets/:id/approve", approveSpreadsheet);
router.post("/spreadsheets/:id/send", sendSpreadsheet);
router.post("/spreadsheets/:id/send-test", sendTestSpreadsheet);

export default router;
