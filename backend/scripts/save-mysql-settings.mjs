// Salva conexão MySQL EXTRACTOR nas configurações do app (lê do .env)
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import pg from "pg";

dotenv.config({ override: true });

const settings = {
  dbType: "mysql",
  dbHost: process.env.TEST_DB_HOST ?? "45.79.29.86",
  dbPort: parseInt(process.env.TEST_DB_PORT ?? "3306", 10),
  dbName: process.env.TEST_DB_NAME ?? "EXTRACTOR",
  dbUser: process.env.TEST_DB_USER ?? "gccconsultoria",
  dbPassword: process.env.TEST_DB_PASSWORD ?? "",
};

if (!settings.dbPassword) {
  console.error("TEST_DB_PASSWORD não definida no .env");
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: settings.dbHost,
  port: settings.dbPort,
  user: settings.dbUser,
  password: settings.dbPassword,
  database: settings.dbName,
});
await conn.ping();
await conn.end();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(
  `INSERT INTO "AppSettings" (id, "dbType", "dbHost", "dbPort", "dbName", "dbUser", "dbPassword", "createdAt", "updatedAt")
   VALUES (1, $1, $2, $3, $4, $5, $6, NOW(), NOW())
   ON CONFLICT (id) DO UPDATE SET
     "dbType" = EXCLUDED."dbType",
     "dbHost" = EXCLUDED."dbHost",
     "dbPort" = EXCLUDED."dbPort",
     "dbName" = EXCLUDED."dbName",
     "dbUser" = EXCLUDED."dbUser",
     "dbPassword" = EXCLUDED."dbPassword",
     "updatedAt" = NOW()`,
  [settings.dbType, settings.dbHost, settings.dbPort, settings.dbName, settings.dbUser, settings.dbPassword],
);

console.log("Conexão MySQL EXTRACTOR salva e testada com sucesso.");

await client.end();
