// Altera APENAS zz_spreadsheet_sync_test — espelho da planilha (id repetido, coluna cliente)
import dotenv from "dotenv";
import mysql from "mysql2/promise";

dotenv.config({ override: true });

const TABLE = "zz_spreadsheet_sync_test";

const conn = await mysql.createConnection({
  host: process.env.TEST_DB_HOST,
  port: parseInt(process.env.TEST_DB_PORT ?? "3306", 10),
  user: process.env.TEST_DB_USER,
  password: process.env.TEST_DB_PASSWORD,
  database: process.env.TEST_DB_NAME,
});

const [cols] = await conn.query(`SHOW COLUMNS FROM \`${TABLE}\``);
const colNames = cols.map((c) => c.Field);
console.log("Colunas atuais:", colNames.join(", "));

// Remove AUTO_INCREMENT + PK em id (permite mesmo código de nota em várias linhas)
const idCol = cols.find((c) => c.Field === "id");
if (idCol?.Extra?.includes("auto_increment") || idCol?.Key === "PRI") {
  await conn.query(`ALTER TABLE \`${TABLE}\` MODIFY COLUMN id INT NULL`);
  try {
    await conn.query(`ALTER TABLE \`${TABLE}\` DROP PRIMARY KEY`);
  } catch {
    // já sem PK
  }
  console.log("id: removido AUTO_INCREMENT/PK — aceita valores da planilha");
}

if (!colNames.includes("cliente")) {
  await conn.query(
    `ALTER TABLE \`${TABLE}\` ADD COLUMN cliente VARCHAR(255) NULL AFTER nome`,
  );
  console.log("Coluna cliente adicionada");
}

const [finalCols] = await conn.query(`SHOW COLUMNS FROM \`${TABLE}\``);
console.log(
  "Estrutura final:",
  finalCols.map((c) => `${c.Field}(${c.Type})${c.Key ? " " + c.Key : ""}`).join(", "),
);

await conn.end();
console.log("Tabela", TABLE, "atualizada com sucesso.");
