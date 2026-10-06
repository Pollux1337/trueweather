// Regen-Check: sammelt Regenvorhersagen und Messwerte und schreibt Monatszähler je Station.
//
//   node collector/collect.mjs --collect            Morgenlauf: MOSMIX + MET Norway sammeln, dann auswerten
//   node collector/collect.mjs                      nur auswerten / Archiv importieren
//   Optionen: --state <Ordner> (Standard ./state), --budget <Open-Meteo-Einheiten> (Standard 4500),
//             --minutes <Zeitlimit> (Standard 50), --only <Stations-ID>
//
// Ablauf
//  1. MOSMIX und MET Norway haben kein Archiv: ihre Vorhersagen werden jeden Morgen in state/pending gelegt.
//  2. Ist ein Tag „reif“ (10 Tage vorbei, DWD-Messwerte vollständig), wird er ausgewertet: Messwerte und
//     das Open-Meteo-Archiv der 6 Modelle holen, mit den gesammelten Vorhersagen vergleichen, Zähler in
//     state/acc/<Station>.json fortschreiben. Das geschieht in Blöcken von mindestens 7 Tagen (spart Abfragen).
//  3. Mit dem übrigen Budget wird das 24-Monats-Fenster rückwärts gefüllt (jüngste Monate zuerst, reihum).
//  4. Monate, die aus dem Fenster fallen, werden gelöscht.

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { addDays, daysBetween, localDate, readJson, writeJson, RateLimitError } from "./util.mjs";
import { fetchObservations, fetchOpenMeteo, openMeteoCost, fetchMosmix, fetchMetno } from "./sources.mjs";
import { toRecords, accumulateDay } from "./core.mjs";
import { windowStart } from "../lib/rain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STATE = resolve(arg("--state", join(ROOT, "state")));
const COLLECT = args.includes("--collect");
let budget = Number(arg("--budget", process.env.ARCHIVE_BUDGET || 4500));
const deadline = Date.now() + Number(arg("--minutes", 50)) * 60_000;
const only = arg("--only", null);
const USER_AGENT = process.env.MET_USER_AGENT || "RegenCheck/1.0 (privates Hobbyprojekt)";

const MATURE_DAYS = 10;  // so lange warten, bis Messwerte vollständig nachgeliefert sind
const FORWARD_MIN = 7;   // neue Tage erst in Blöcken ab 7 Tagen auswerten
const CHUNK = 92;        // Archiv-Import in Stücken von 92 Tagen

const now = new Date();
const today = localDate(now);
const matureTo = addDays(today, -MATURE_DAYS);
const wStart = windowStart(now);
const stations = (await readJson(join(ROOT, "config", "stations.json"))).filter((s) => !only || s.id === only);
const providers = await readJson(join(ROOT, "config", "providers.json"));
const archived = providers.filter((p) => p.source === "openmeteo");
const progress = await readJson(join(STATE, "progress.json"), {});
const file = (dir, id) => join(STATE, dir, `${id}.json`);

const status = { lastRun: now.toISOString(), collect: COLLECT, errors: [], counts: { gesammelt: 0, ausgewertet: 0, tage: 0 } };
const fail = (where, err) => {
  status.errors.push(`${where}: ${String(err.message || err).slice(0, 160)}`);
  console.error(`✘ ${where}: ${err.message || err}`);
};

for (const s of stations) {
  const p = (progress[s.id] ??= { from: addDays(matureTo, 1), to: matureTo });
  if (p.from < wStart) p.from = wStart; // Fenster gleitet weiter
}

// ---------- 1. MOSMIX und MET Norway sammeln ----------

if (COLLECT) {
  const t0 = Date.now();
  for (const s of stations) {
    const pending = await readJson(file("pending", s.id), {});
    for (const prov of providers.filter((x) => x.source === "brightsky" || x.source === "metno")) {
      try {
        const raw = prov.source === "brightsky" ? await fetchMosmix(s, today, prov.maxLead) : await fetchMetno(s, USER_AGENT);
        if (!raw) continue; // kein MOSMIX-Punkt in der Nähe
        const recs = toRecords(raw.fine, raw.coarse);
        for (let k = 1; k <= prov.maxLead; k++) {
          const target = addDays(today, k);
          const rec = recs.get(target);
          const slot = ((pending[target] ??= {})[prov.id] ??= {});
          if (rec && !slot[k]) { slot[k] = rec; status.counts.gesammelt++; } // erster Lauf des Tages zählt
        }
      } catch (err) {
        fail(`${s.id}/${prov.id}`, err);
      }
    }
    await writeJson(file("pending", s.id), pending);
  }
  console.log(`✔ MOSMIX/MET Norway: ${status.counts.gesammelt} Vorhersagen (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}

// ---------- 2./3. Auswerten: neue Tage und Archiv ----------

async function evaluate(s, from, to, forward) {
  const obs = toRecords(await fetchObservations(s, from, to));
  const fc = {}; // Datum → Anbieter → Vorlauf → Werte
  for (const prov of archived) {
    const byLead = await fetchOpenMeteo(s, prov, from, to);
    budget -= openMeteoCost(prov, daysBetween(from, to) + 3);
    for (const [k, series] of Object.entries(byLead)) {
      for (const [date, rec] of toRecords(series)) {
        if (date >= from && date <= to) (((fc[date] ??= {})[prov.id] ??= {})[k] = rec);
      }
    }
  }
  const pending = forward ? await readJson(file("pending", s.id), {}) : {};
  for (const [date, byProv] of Object.entries(pending)) {
    if (date < from || date > to) continue;
    for (const [pid, leads] of Object.entries(byProv)) ((fc[date] ??= {})[pid] = leads);
  }

  const acc = await readJson(file("acc", s.id), {});
  for (let d = from; d <= to; d = addDays(d, 1)) accumulateDay(acc, d, obs.get(d), fc[d] || {});
  for (const m of Object.keys(acc)) if (m < wStart.slice(0, 7)) delete acc[m];
  await writeJson(file("acc", s.id), acc);

  if (forward) {
    progress[s.id].to = to;
    for (const date of Object.keys(pending)) if (date <= to) delete pending[date];
    await writeJson(file("pending", s.id), pending);
  } else {
    progress[s.id].from = from;
  }
  await writeJson(join(STATE, "progress.json"), progress);
  status.counts.ausgewertet++;
  status.counts.tage += daysBetween(from, to) + 1;
}

const taskCost = (days) => archived.reduce((sum, prov) => sum + openMeteoCost(prov, days + 3), 0);
let stopReason = null;

const skipped = new Set(); // Stationen mit Fehler werden in diesem Lauf ausgelassen
// feste, gut durchmischte Reihenfolge (Goldener-Schnitt-Folge über die Stationsnummern)
const spread = (s) => (Number(s.id) * 0.6180339887) % 1;

function nextTask() {
  const active = stations.filter((s) => !skipped.has(s.id));
  // zuerst neue Tage (vorwärts), dann das Archiv (rückwärts, jüngste Lücke zuerst)
  const fwd = active.find((s) => daysBetween(progress[s.id].to, matureTo) >= FORWARD_MIN);
  if (fwd) return { s: fwd, from: addDays(progress[fwd.id].to, 1), to: matureTo, forward: true };
  // bei gleichem Stand in gestreuter Reihenfolge, damit sich die Karte gleichmäßig füllt
  const back = active
    .filter((s) => progress[s.id].from > wStart)
    .sort((a, b) => (progress[b.id].from > progress[a.id].from ? 1 : progress[b.id].from < progress[a.id].from ? -1 : spread(a) - spread(b)))[0];
  if (!back) return null;
  const to = addDays(progress[back.id].from, -1);
  const from = addDays(to, -(CHUNK - 1)) < wStart ? wStart : addDays(to, -(CHUNK - 1));
  return { s: back, from, to, forward: false };
}

while (true) {
  const task = nextTask();
  if (!task) break;
  const cost = taskCost(daysBetween(task.from, task.to) + 1);
  if (cost > budget) { stopReason = "Budget dieses Laufs aufgebraucht"; break; }
  if (Date.now() > deadline) { stopReason = "Zeitlimit dieses Laufs erreicht"; break; }
  try {
    await evaluate(task.s, task.from, task.to, task.forward);
    console.log(`✔ ${task.s.name} ${task.forward ? "neu" : "Archiv"} ${task.from}…${task.to} (Budget ${Math.round(budget)})`);
  } catch (err) {
    if (err instanceof RateLimitError) { stopReason = `Open-Meteo-Limit: ${err.message}`; break; }
    fail(`${task.s.id} ${task.from}…${task.to}`, err);
    skipped.add(task.s.id);
  }
}

// ---------- Fortschritt ----------

const all = await readJson(join(ROOT, "config", "stations.json"));
const full = daysBetween(wStart, matureTo) + 1;
const shares = all.map((s) => {
  const p = progress[s.id];
  return p ? Math.max(0, daysBetween(p.from, p.to) + 1) / full : 0;
});
status.archive = Math.round((100 * shares.reduce((a, b) => a + b, 0)) / all.length);
status.window = { from: wStart, to: matureTo };
status.note = stopReason;

// Stationen, die nicht mehr in der Konfiguration stehen, aufräumen
const known = new Set(all.map((s) => s.id));
for (const id of Object.keys(progress)) if (!known.has(id)) delete progress[id];
await writeJson(join(STATE, "progress.json"), progress);

// status.json zusammenführen: Fehler des Morgenlaufs bleiben bis zum nächsten Morgenlauf sichtbar
const old = await readJson(join(STATE, "status.json"), {});
const merged = { ...old, ...status, collectErrors: COLLECT ? status.errors.filter((e) => /\/(mosmix|metno)/.test(e)) : old.collectErrors || [] };
await writeJson(join(STATE, "status.json"), merged, true);

console.log(`\nArchiv ${status.archive} % · ${status.counts.ausgewertet} Auswertungen (${status.counts.tage} Stationstage) · ${stopReason || "fertig"}`);
console.log(status.errors.length ? `${status.errors.length} Fehler.` : "Keine Fehler.");
// Einzelne Aussetzer (z. B. eine MET-Abfrage) sind normal; rot wird der Lauf erst bei vielen Fehlern
process.exitCode = status.errors.length > 20 ? 1 : 0;

