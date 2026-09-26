/**
 * Cria pedidos_emissao_avinor no EXTRACTOR (mesma estrutura de base_pedidos_avinor).
 * Rode LOCALMENTE após autorização — NÃO executamos no MySQL remoto sem OK do usuário.
 *
 * node backend/scripts/create-pedidos-emissao-table.mjs
 */
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config({ override: true, path: "backend/.env" });

const config = {
  host: process.env.TEST_DB_HOST ?? "45.79.29.86",
  port: parseInt(process.env.TEST_DB_PORT ?? "3306", 10),
  user: process.env.TEST_DB_USER ?? "gccconsultoria",
  password: process.env.TEST_DB_PASSWORD ?? "",
  database: process.env.TEST_DB_NAME ?? "EXTRACTOR",
};

const SOURCE = "base_pedidos_avinor";
const TARGET = "pedidos_emissao_avinor";

async function main() {
  if (!config.password) {
    console.error("Defina TEST_DB_PASSWORD no backend/.env");
    process.exit(1);
  }

  const conn = await mysql.createConnection(config);
  try {
    const [exists] = await conn.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
      [config.database, TARGET],
    );
    if (exists.length > 0) {
      console.log(`Tabela ${TARGET} já existe.`);
      return;
    }

    const [src] = await conn.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
      [config.database, SOURCE],
    );
    if (!src.length) {
      console.error(`Tabela modelo ${SOURCE} não encontrada.`);
      process.exit(1);
    }

    await conn.query(`CREATE TABLE \`${TARGET}\` LIKE \`${SOURCE}\``);
    console.log(`Tabela ${TARGET} criada (LIKE ${SOURCE}).`);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
