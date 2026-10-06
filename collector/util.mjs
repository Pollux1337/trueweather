import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const TZ = "Europe/Berlin";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimitError extends Error {}

// fetch mit Wiederholung bei Netzwerkfehlern, 429 (Minutenlimit), 5xx und kaputten Antworten
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
    const body = await res.text().catch(() => "");
    if (res.ok) {
      // Open-Meteo liefert gelegentlich Text statt JSON (Server-Aussetzer) → wie Netzwerkfehler wiederholen
      try { return JSON.parse(body); } catch {
        if (attempt >= retries) throw new Error(`Ungültige Antwort (${url.split("?")[0]}): ${body.slice(0, 120)}`);
        await sleep(5_000 * (attempt + 1));
        continue;
      }
    }
    // Stunden- oder Tageslimit: Warten lohnt nicht, beim nächsten Lauf weitermachen
    if (res.status === 429 && /hourly|daily/i.test(body)) throw new RateLimitError(body.slice(0, 200));
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(res.status === 429 ? 65_000 : 5_000 * (attempt + 1));
      continue;
    }
    const err = new Error(`HTTP ${res.status} (${url.split("?")[0]}): ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

// ---------- Zeit ----------
// Stundenschlüssel „YYYY-MM-DDTHH“ = Beginn der Stunde in deutscher Ortszeit

const keyFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const dateFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ });

export const hourKey = (startDate) => keyFmt.format(startDate).replace(" ", "T");
// Werte, die die vorangegangene Stunde zusammenfassen (Messung, Open-Meteo, MOSMIX): Ende → Beginn
export const hourKeyFromEnd = (endDate) => hourKey(new Date(endDate.getTime() - 3_600_000));
export const localDate = (date) => dateFmt.format(date);

export function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
export const round1 = (v) => Math.round(v * 10) / 10;

// ---------- Dateien ----------

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (err) {
    if (fallback !== undefined && err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJson(path, data, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, pretty ? 1 : 0) + "\n", "utf8");
}
