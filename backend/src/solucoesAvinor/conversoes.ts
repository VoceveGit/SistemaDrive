// backend/src/solucoesAvinor/conversoes.ts

export type MysqlColMeta = {
  name: string;
  dataType: string;
};

export function parseNumberBr(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s || s === "-" || s === "—") return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) {
    const n = Number(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseBigIntCell(raw: string): number | null {
  const n = parseNumberBr(raw);
  if (n == null) return null;
  return Math.trunc(n);
}

function formatMysqlDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatMysqlDateTimeUTC(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Serial Excel → Date via Unix ms (sem new Date(ano,mês,dia)). */
export function excelSerialToDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569);
  const utcMs = utcDays * 86400 * 1000;
  const fractionalDay = serial - Math.floor(serial) + 1e-7;
  const totalSeconds = Math.floor(86400 * fractionalDay);
  return new Date(utcMs + totalSeconds * 1000);
}

/**
 * Converte célula de data da planilha Avinor.
 * Prioridade: DD/MM/YYYY (BR) → ISO → serial Excel moderno → Date parse seguro.
 */
export function parseDateTimeCell(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Ano sozinho ou serial minúsculo (2026 → 1905) — rejeita
  if (/^\d{4}$/.test(s)) return null;

  // DD/MM/YYYY primeiro (texto formatado do Excel)
  const br = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]) - 1;
    let year = Number(br[3]);
    if (year < 100) year += 2000;
    if (year < 1980 || year > 2100) return null;
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    const d = new Date(
      year,
      month,
      day,
      Number(br[4] ?? 0),
      Number(br[5] ?? 0),
      Number(br[6] ?? 0),
    );
    if (!Number.isNaN(d.getTime())) return formatMysqlDateTime(d);
  }

  // Serial Excel moderno (~1982+)
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= 30000 && serial < 80000) {
      return formatMysqlDateTimeUTC(excelSerialToDate(serial));
    }
    return null;
  }

  // ISO / MySQL
  const iso = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/,
  );
  if (iso) {
    const year = Number(iso[1]);
    if (year < 1980 || year > 2100) return null;
    const d = new Date(
      year,
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    );
    if (!Number.isNaN(d.getTime())) return formatMysqlDateTime(d);
  }

  if (!/\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(s) && !/[a-z]{3}/i.test(s)) {
    return null;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && d.getFullYear() >= 1980 && d.getFullYear() <= 2100) {
    return formatMysqlDateTime(d);
  }
  return null;
}

export function convertCellForMysql(raw: string, col: MysqlColMeta): unknown {
  const t = col.dataType.toLowerCase();
  const s = String(raw ?? "").trim();

  if (
    t.includes("int") ||
    t === "bigint" ||
    t === "mediumint" ||
    t === "smallint" ||
    t === "tinyint"
  ) {
    return s === "" ? null : parseBigIntCell(s);
  }
  if (
    t === "double" ||
    t === "float" ||
    t === "decimal" ||
    t === "real" ||
    t === "numeric"
  ) {
    return s === "" ? null : parseNumberBr(s);
  }
  if (t === "datetime" || t === "timestamp") {
    return s === "" ? null : parseDateTimeCell(s);
  }
  if (t === "date") {
    const full = parseDateTimeCell(s);
    return full ? full.slice(0, 10) : null;
  }
  return s === "" ? null : s;
}
