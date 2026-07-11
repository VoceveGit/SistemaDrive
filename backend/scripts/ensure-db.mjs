// backend/scripts/ensure-db.mjs — Cria o banco spreadsheet_sync se não existir

import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ override: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida");
  process.exit(1);
}

const parsed = new URL(url);
const dbName = parsed.pathname.replace(/^\//, "") || "spreadsheet_sync";

parsed.pathname = "/postgres";
const adminUrl = parsed.toString();

const client = new pg.Client({ connectionString: adminUrl });

try {
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Banco "${dbName}" criado.`);
  } else {
    console.log(`Banco "${dbName}" já existe.`);
  }
} finally {
  await client.end();
}
