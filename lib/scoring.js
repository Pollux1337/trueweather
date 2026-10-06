// Gemeinsame Auswertung für Browser (Dashboard) und Node (Zusammenfassung im Sammel-Skript).

export const METRICS = {
  tmax:    { label: "Höchsttemperatur",    field: "tmax",   unit: "°C",   kind: "error", digits: 1 },
  tmin:    { label: "Tiefsttemperatur",    field: "tmin",   unit: "°C",   kind: "error", digits: 1 },
  rainhit: { label: "Regen ja/nein",       field: "precip", unit: "%",    kind: "hit",   digits: 0 },
  precip:  { label: "Niederschlagsmenge",  field: "precip", unit: "mm",   kind: "error", digits: 1 },
  wind:    { label: "Wind (Tagesmaximum)", field: "wind",   unit: "km/h", kind: "error", digits: 1 },
};
export const METRIC_KEYS = Object.keys(METRICS);
export const RAIN_MM = 1;       // ab dieser Tagesmenge gilt ein Tag als Regentag
export const MIN_N = 5;         // mindestens so viele Tage, damit ein Wert zählt
export const MIN_N_MONTH = 10;  // Monatswerte im Verlauf
export const LEADS = [1, 2, 3, 4, 5, 6, 7];
export const PERIODS = ["30", "90", "365", "all"];

export function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  if (!header) return [];
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row = {};
    cols.forEach((c, i) => {
      const v = cells[i] ?? "";
      row[c] = c === "provider" || c === "target" || c === "date" ? v : v === "" ? null : Number(v);
    });
    return row;
  });
}

// data = { obs: Map(date → Messwerte), fc: [Vorhersagezeilen] }
export function computePairs(data, metric, period, commonOnly, providers, locId = "") {
  const m = METRICS[metric];
  const dates = [...data.obs.keys()].sort();
  const lastObs = dates.at(-1);
  if (!lastObs) return { pairs: [], lastObs: null, firstObs: null };
  const from = period === "all" ? dates[0] : addDays(lastObs, -Number(period) + 1);

  let pairs = [];
  for (const r of data.fc) {
    if (r.target < from || r.target > lastObs) continue;
    const o = data.obs.get(r.target);
    if (!o || o[m.field] == null || r[m.field] == null) continue;
    pairs.push({ loc: locId, provider: r.provider, lead: r.lead, target: r.target, f: r[m.field], o: o[m.field] });
  }

  if (commonOnly) {
    // Pro Vorlaufzeit nur Tage behalten, an denen jeder Anbieter mit dieser Reichweite einen Wert hat
    const keep = new Set();
    for (const k of LEADS) {
      const eligible = providers.filter((p) => p.maxLead >= k).length;
      const count = new Map();
      for (const p of pairs) if (p.lead === k) count.set(p.target, (count.get(p.target) || 0) + 1);
      for (const [t, c] of count) if (c === eligible) keep.add(`${k}|${t}`);
    }
    pairs = pairs.filter((p) => keep.has(`${p.lead}|${p.target}`));
  }
  return { pairs, lastObs, firstObs: dates[0] };
}

export function score(list, kind) {
  if (!list.length) return { n: 0, value: null, bias: null };
  if (kind === "hit") {
    const hits = list.filter((p) => (p.f >= RAIN_MM) === (p.o >= RAIN_MM)).length;
    return { n: list.length, value: (100 * hits) / list.length, bias: null };
  }
  let abs = 0, sum = 0;
  for (const p of list) { abs += Math.abs(p.f - p.o); sum += p.f - p.o; }
  return { n: list.length, value: abs / list.length, bias: sum / list.length };
}

// kleiner = besser, auch für die Trefferquote
export const badness = (s, kind) => (s.value == null ? null : kind === "hit" ? 100 - s.value : s.value);

// stats[providerId][lead] = { n, value, bias }
export function computeStats(pairs, kind, providers) {
  const groups = new Map();
  for (const p of pairs) {
    const key = `${p.provider}|${p.lead}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const stats = {};
  for (const prov of providers) {
    stats[prov.id] = {};
    for (const k of LEADS) stats[prov.id][k] = score(groups.get(`${prov.id}|${k}`) || [], kind);
  }
  return stats;
}

// Fehler eines einzelnen Tages: Abweichung bzw. 100 für einen falsch vorhergesagten Regentag
const dayError = (p, kind) => (kind === "hit" ? ((p.f >= RAIN_MM) === (p.o >= RAIN_MM) ? 0 : 100) : Math.abs(p.f - p.o));

// Relative Güte je Anbieter und Vorlaufzeit in Prozent, als Paarvergleich: Ein Anbieter wird nur an
// den Tagen bewertet, an denen er selbst Daten hat, und dort mit dem mittleren Fehler aller Anbieter
// an genau diesen Tagen verglichen. +10 heißt: 10 % genauer als der Durchschnitt. So ist der Vergleich
// fair, auch wenn ein Anbieter erst seit kurzem gesammelt wird oder nicht so weit rechnet.
// Ergebnis: { providerId: [rel Tag 1, …, rel Tag 7] }, dazu n: { providerId: [Tage je Vorlaufzeit] }
export function relativeByLead(pairs, kind, providers) {
  const result = {}, n = {};
  for (const p of providers) { result[p.id] = LEADS.map(() => null); n[p.id] = LEADS.map(() => 0); }
  for (const k of LEADS) {
    const byDay = new Map(); // Tag → [{ provider, e }]
    for (const p of pairs) {
      if (p.lead !== k) continue;
      if (!byDay.has(p.target)) byDay.set(p.target, []);
      byDay.get(p.target).push({ provider: p.provider, e: dayError(p, kind) });
    }
    const own = {}, ref = {}, cnt = {};
    for (const list of byDay.values()) {
      if (list.length < 2) continue; // ohne Vergleich kein Urteil
      const avg = list.reduce((a, x) => a + x.e, 0) / list.length;
      for (const x of list) {
        own[x.provider] = (own[x.provider] || 0) + x.e;
        ref[x.provider] = (ref[x.provider] || 0) + avg;
        cnt[x.provider] = (cnt[x.provider] || 0) + 1;
      }
    }
    for (const p of providers) {
      const c = cnt[p.id] || 0;
      n[p.id][k - 1] = c;
      if (c < MIN_N) continue;
      result[p.id][k - 1] = ref[p.id] > 0 ? Math.round(1000 * (1 - own[p.id] / ref[p.id])) / 10 : 0;
    }
  }
  return { rel: result, n };
}

export const mean = (vals) => {
  const v = vals.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// rel = { locId: { metric: { providerId: [7 Werte] } } } → Ranking, gemittelt über Orte (jeder Ort gleich)
// leads: welche Vorlaufzeiten zählen; metrics: welche Messgrößen (Gesamt = alle)
export function computeRanking(rel, providers, { leads = LEADS, metrics = METRIC_KEYS } = {}) {
  const idx = leads.map((k) => k - 1);
  const locIds = Object.keys(rel);
  // Wert eines Anbieters an einem Ort für eine Messgröße: Mittel über die gewählten Vorlaufzeiten
  const at = (l, m, pid) => mean(idx.map((i) => rel[l]?.[m]?.[pid]?.[i] ?? null));
  // Gesamtwert an einem Ort: nur wenn alle gewählten Messgrößen vorhanden sind
  const totalAt = (l, pid) => {
    const vals = metrics.map((m) => at(l, m, pid));
    return vals.every((v) => v != null) ? mean(vals) : null;
  };
  const scores = Object.fromEntries(METRIC_KEYS.map((m) => [m, Object.fromEntries(providers.map((p) => [p.id, mean(locIds.map((l) => at(l, m, p.id)))]))]));
  const rows = providers
    .map((p) => {
      const vals = metrics.map((m) => scores[m][p.id]);
      return { p, total: vals.every((v) => v != null) ? mean(vals) : null };
    })
    .sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity));
  const byLoc = Object.fromEntries(locIds.map((l) => [l, providers
    .map((p) => ({ p, total: totalAt(l, p.id) }))
    .filter((r) => r.total != null)
    .sort((a, b) => b.total - a.total)]));
  return { scores, rows, byLoc };
}
