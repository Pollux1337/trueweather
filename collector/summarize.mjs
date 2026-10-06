// Erzeugt data/summary.json: alles, was das Dashboard für „Alle Orte“ und die Karte braucht,
// vorberechnet für jeden Zeitraum und mit/ohne „nur gemeinsame Tage“. So muss der Browser nicht
// die Rohdaten aller Orte laden.
//
//   node collector/summarize.mjs

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { METRICS, METRIC_KEYS, LEADS, PERIODS, MIN_N_MONTH, parseCsv, computePairs, computeStats, relativeByLead, score } from "../lib/scoring.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export async function buildSummary() {
  const locations = JSON.parse(await readFile(join(ROOT, "config", "locations.json"), "utf8"));
  const providers = JSON.parse(await readFile(join(ROOT, "config", "providers.json"), "utf8"));

  const sets = [];
  for (const loc of locations) {
    try {
      const [obsText, fcText] = await Promise.all([
        readFile(join(ROOT, "data", loc.id, "observations.csv"), "utf8"),
        readFile(join(ROOT, "data", loc.id, "forecasts.csv"), "utf8"),
      ]);
      const data = { obs: new Map(parseCsv(obsText).map((r) => [r.date, r])), fc: parseCsv(fcText) };
      if (data.obs.size) sets.push({ loc, data });
    } catch { /* Ort noch ohne Daten */ }
  }

  const views = {};
  const trend = {};
  for (const period of PERIODS) {
    for (const common of [false, true]) {
      // provDays: je Anbieter die Zahl der Vergleichstage pro Ort (Höchsttemperatur, 1 Tag Vorlauf), gemittelt
      const view = { pooled: {}, rel: {}, provDays: {}, locDays: {}, days: 0, firstDay: null, lastObs: null };
      const allTargets = new Set();
      const pooledPairs = Object.fromEntries(METRIC_KEYS.map((m) => [m, []]));
      for (const { loc, data } of sets) {
        view.rel[loc.id] = {};
        for (const m of METRIC_KEYS) {
          const { pairs, lastObs } = computePairs(data, m, period, common, providers, loc.id);
          const { rel, n } = relativeByLead(pairs, METRICS[m].kind, providers);
          view.rel[loc.id][m] = rel;
          if (m === "tmax") for (const p of providers) (view.provDays[p.id] ??= []).push(n[p.id][0]);
          for (const p of pairs) pooledPairs[m].push(p);
          if (m === "tmax") {
            const targets = new Set(pairs.map((p) => p.target));
            view.locDays[loc.id] = targets.size;
            for (const t of targets) allTargets.add(t);
            if (lastObs && (!view.lastObs || lastObs > view.lastObs)) view.lastObs = lastObs;
          }
        }
      }
      for (const id of Object.keys(view.provDays)) {
        const v = view.provDays[id];
        view.provDays[id] = v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
      }
      view.days = allTargets.size;
      view.firstDay = [...allTargets].sort()[0] ?? null;
      for (const m of METRIC_KEYS) {
        const stats = computeStats(pooledPairs[m], METRICS[m].kind, providers);
        view.pooled[m] = Object.fromEntries(providers.map((p) => [p.id, LEADS.map((k) => {
          const s = stats[p.id][k];
          return [s.n, round(s.value), round(s.bias)];
        })]));
      }
      views[`${period}|${common ? 1 : 0}`] = view;

      // Monatsverlauf nur einmal (ganzer Zeitraum); das Dashboard schneidet ihn passend zu
      if (period === "all") {
        const t = {};
        for (const m of METRIC_KEYS) {
          const groups = new Map();
          for (const p of pooledPairs[m]) {
            const key = `${p.provider}|${p.lead}|${p.target.slice(0, 7)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p);
          }
          t[m] = {};
          for (const [key, list] of groups) {
            if (list.length < MIN_N_MONTH) continue;
            const [pid, lead, month] = key.split("|");
            ((t[m][lead] ??= {})[pid] ??= {})[month] = round(score(list, METRICS[m].kind).value);
          }
        }
        trend[common ? 1 : 0] = t;
      }
    }
  }

  const summary = { generated: new Date().toISOString(), locations: sets.map((s) => s.loc.id), views, trend };
  await writeFile(join(ROOT, "data", "summary.json"), JSON.stringify(summary), "utf8");
  return { orte: sets.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t0 = Date.now();
  const info = await buildSummary();
  console.log(`data/summary.json erstellt: ${info.orte} Orte (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
