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

export function parseDateTimeCell(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const utc = Date.UTC(1899, 11, 30) + serial * 86400000;
      return formatMysqlDateTime(new Date(utc));
    }
  }

  const br = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]) - 1;
    let year = Number(br[3]);
    if (year < 100) year += 2000;
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

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return formatMysqlDateTime(d);
  return null;
}

function formatMysqlDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
