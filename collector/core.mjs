// Aus Stundenwerten Tages- und 2-Stunden-Werte bilden und die Monatszähler fortschreiben.

import { RAIN_DAY_MM, RAIN_SLOT_MM, SLOTS, DAY_LEADS, SLOT_LEADS, CELLS, FIELDS } from "../lib/rain.js";
import { round1 } from "./util.mjs";

const MIN_DAY_HOURS = 22; // ein Tag zählt nur mit (fast) allen Stunden; Zeitumstellung hat 23 bzw. 25

// series: Map(Stundenschlüssel → mm) mit stündlicher Auflösung; coarse: grobe Werte (nur für Tagessummen)
// Ergebnis: Map(Datum → [Tagessumme | null, Abschnitt 0 … 11 | null])
export function toRecords(series, coarse = new Map()) {
  const byDate = new Map();
  const put = (key, mm, fine) => {
    const date = key.slice(0, 10), hour = Number(key.slice(11, 13));
    if (!byDate.has(date)) byDate.set(date, { hours: new Map(), fine: new Map() });
    const d = byDate.get(date);
    d.hours.set(hour, (d.hours.get(hour) || 0) + mm);
    if (fine) d.fine.set(hour, (d.fine.get(hour) || 0) + mm);
  };
  for (const [k, mm] of series) put(k, mm, true);
  for (const [k, mm] of coarse) if (!series.has(k)) put(k, mm, false);

  const out = new Map();
  for (const [date, d] of byDate) {
    const rec = [null, ...Array(SLOTS).fill(null)];
    if (d.hours.size >= MIN_DAY_HOURS) rec[0] = round1([...d.hours.values()].reduce((a, b) => a + b, 0));
    for (let s = 0; s < SLOTS; s++) {
      const h1 = d.fine.get(2 * s), h2 = d.fine.get(2 * s + 1);
      if (h1 != null && h2 != null) rec[s + 1] = round1(h1 + h2);
    }
    if (rec.some((v) => v != null)) out.set(date, rec);
  }
  return out;
}

const r2 = (v) => Math.round(v * 100) / 100;

// Zähler eines Monats für einen Anbieter: 10 Zellen (d1…d7, h1…h3) × 9 Felder
const emptyProvider = () => CELLS.map(() => FIELDS.map(() => 0));

// Einen Tag auswerten.
// obs: [Tag, Abschnitte…] oder undefined; fc: { providerId: { lead: [Tag, Abschnitte…] } }
export function accumulateDay(acc, date, obs, fc) {
  if (!obs) return 0;
  const month = date.slice(0, 7);
  let used = 0;
  const units = [];
  for (const k of DAY_LEADS) units.push({ cell: CELLS.indexOf(`d${k}`), lead: k, idx: 0, thr: RAIN_DAY_MM });
  for (const k of SLOT_LEADS) for (let s = 0; s < SLOTS; s++) units.push({ cell: CELLS.indexOf(`h${k}`), lead: k, idx: s + 1, thr: RAIN_SLOT_MM });

  for (const u of units) {
    const o = obs[u.idx];
    if (o == null) continue;
    const list = [];
    for (const [pid, leads] of Object.entries(fc)) {
      const f = leads[u.lead]?.[u.idx];
      if (f == null) continue;
      list.push({ pid, f, yn: (f >= u.thr) !== (o >= u.thr) ? 1 : 0, ae: Math.abs(f - o) });
    }
    if (!list.length) continue;
    const paired = list.length >= 2;
    const avgYN = list.reduce((s, x) => s + x.yn, 0) / list.length;
    const avgA = list.reduce((s, x) => s + x.ae, 0) / list.length;
    const wet = o >= u.thr;
    for (const x of list) {
      const c = (((acc[month] ??= {})[x.pid] ??= emptyProvider()))[u.cell];
      const fWet = x.f >= u.thr;
      c[fWet && wet ? 0 : fWet ? 1 : wet ? 2 : 3] += 1;
      c[4] = r2(c[4] + x.ae);
      if (paired) {
        c[5] = r2(c[5] + x.yn); c[6] = r2(c[6] + avgYN);
        c[7] = r2(c[7] + x.ae); c[8] = r2(c[8] + avgA);
      }
      used++;
    }
  }
  return used;
}
