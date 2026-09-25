import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimitError extends Error {}

// fetch mit Wiederholung bei Netzwerkfehlern, 429 (Rate-Limit) und 5xx
export async function fetchJson(url, { headers = {}, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(5_000 * (attempt + 1));
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    // Stunden- oder Tageslimit: Warten lohnt nicht, später weitermachen
    if (res.status === 429 && /hourly|daily/i.test(body)) throw new RateLimitError(body.slice(0, 200));
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(res.status === 429 ? 65_000 : 5_000 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} (${url.split("?")[0]}): ${body.slice(0, 200)}`);
  }
}

// ---------- Datum ----------

export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date); // YYYY-MM-DD
}

export function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

// ---------- Tageswerte aus Stundenwerten ----------

// points: [{ date, temp, precip, wind }] – ein Eintrag pro Stunde (Ortszeit)
// Ein Wert zählt nur, wenn mindestens minHours Stunden vorhanden sind.
export function aggregateDaily(points, minHours = 22) {
  const byDate = new Map();
  for (const p of points) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }
  const days = new Map();
  for (const [date, hours] of byDate) {
    const vals = (k) => hours.map((h) => h[k]).filter((v) => v != null && Number.isFinite(v));
    const temp = vals("temp"), precip = vals("precip"), wind = vals("wind");
    const day = {
      tmax: temp.length >= minHours ? round1(Math.max(...temp)) : null,
      tmin: temp.length >= minHours ? round1(Math.min(...temp)) : null,
      precip: precip.length >= minHours ? round1(precip.reduce((a, b) => a + b, 0)) : null,
      wind: wind.length >= minHours ? round1(Math.max(...wind)) : null,
    };
    if (Object.values(day).some((v) => v != null)) days.set(date, day);
  }
  return days;
}

// ---------- CSV (nur Zahlen und einfache IDs, daher ohne Anführungszeichen) ----------

export async function readCsv(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { return []; }
  const [header, ...lines] = text.trim().split(/\r?\n/);
  if (!header) return [];
  const cols = header.split(",");
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

export async function writeCsv(path, columns, rows) {
  await mkdir(dirname(path), { recursive: true });
  const lines = rows.map((r) => columns.map((c) => r[c] ?? "").join(","));
  await writeFile(path, [columns.join(","), ...lines].join("\n") + "\n", "utf8");
}

// Neue Zeilen einfügen. overwrite=true ersetzt vorhandene Zeilen mit gleichem Schlüssel.
export async function upsertCsv(path, columns, keyCols, newRows, { overwrite = true } = {}) {
  const key = (r) => keyCols.map((c) => r[c]).join("|");
  const map = new Map((await readCsv(path)).map((r) => [key(r), r]));
  let added = 0, updated = 0;
  for (const r of newRows) {
    const k = key(r);
    if (!map.has(k)) { map.set(k, r); added++; }
    else if (overwrite) { map.set(k, r); updated++; }
  }
  const rows = [...map.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  await writeCsv(path, columns, rows);
  return { added, updated, total: rows.length };
}
