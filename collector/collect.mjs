// Sammelt täglich Vorhersagen und Messwerte für alle Orte aus config/locations.json.
//
//   node collector/collect.mjs                  Normalbetrieb: aktuelle Daten + Archiv-Import im Rahmen des Budgets
//   node collector/collect.mjs --budget 8000    Budget für den Archiv-Import (Open-Meteo-Einheiten, Standard 6000)
//   node collector/collect.mjs --only luebeck   nur einen Ort
//
// Archiv-Import: Für jeden Ort und jedes Modell wird das Open-Meteo-Archiv rückwärts bis ARCHIVE_FROM
// eingelesen, in 92-Tage-Stücken, reihum über alle Orte (zuerst die jüngsten Monate). Der Fortschritt
// steht in data/archive-progress.json. Bei erreichtem Tageslimit geht es beim nächsten Lauf weiter.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { addDays, localDate, upsertCsv, RateLimitError } from "./util.mjs";
import { fetchObservations, fetchOpenMeteoArchive, openMeteoCost, fetchMosmix, fetchMetno } from "./sources.mjs";
import { buildSummary } from "./summarize.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARCHIVE_FROM = "2024-01-01";
const RECENT_DAYS = 14;
const CHUNK_DAYS = 92;
const OBS_COLUMNS = ["date", "tmax", "tmin", "precip", "wind"];
const FC_COLUMNS = ["target", "provider", "lead", "tmax", "tmin", "precip", "wind"];
const FC_KEY = ["target", "provider", "lead"];
const USER_AGENT = process.env.MET_USER_AGENT || "WetterVorhersageCheck/1.0 (privates Hobbyprojekt)";

const args = process.argv.slice(2);
const argValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = argValue("--only");
let budget = Number(argValue("--budget") ?? process.env.ARCHIVE_BUDGET ?? 6000);

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(join(ROOT, p), "utf8")); } catch (err) { if (fallback !== undefined) return fallback; throw err; }
};
const locations = (await readJson("config/locations.json")).filter((l) => !only || l.id === only);
const providers = await readJson("config/providers.json");
const archiveProviders = providers.filter((p) => p.source === "openmeteo");
const progress = await readJson("data/archive-progress.json", {});
const files = (loc) => ({ obs: join(ROOT, "data", loc.id, "observations.csv"), fc: join(ROOT, "data", loc.id, "forecasts.csv") });

const status = { lastRun: new Date().toISOString(), locations: {}, archive: {} };
let failures = 0;

function log(loc, name, ok, info, t0) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (ok) console.log(`✔ ${loc.name} · ${name}: ${JSON.stringify(info)} (${secs} s)`);
  else console.error(`✘ ${loc.name} · ${name}: ${info}`);
}

// ---------- 1. Tägliche Daten für alle Orte ----------

for (const loc of locations) {
  const today = localDate(new Date(), loc.timezone);
  const yesterday = addDays(today, -1);
  const start = addDays(today, -RECENT_DAYS);
  const f = files(loc);
  const results = [];
  status.locations[loc.id] = { today, results };

  async function step(name, fn) {
    const t0 = Date.now();
    try {
      const info = await fn();
      results.push({ step: name, ok: true, ...info });
      log(loc, name, true, info, t0);
    } catch (err) {
      failures++;
      results.push({ step: name, ok: false, error: String(err.message || err) });
      log(loc, name, false, err.stack || err, t0);
    }
  }

  // Messwerte der letzten Tage erneut prüfen, weil der DWD Werte nachliefert
  await step("messwerte", async () => upsertCsv(f.obs, OBS_COLUMNS, ["date"], await fetchObservations(loc, start, yesterday), { overwrite: true }));

  for (const p of providers) {
    if (p.source === "openmeteo") {
      await step(p.id, async () => {
        budget -= openMeteoCost(p, start, yesterday);
        return upsertCsv(f.fc, FC_COLUMNS, FC_KEY, await fetchOpenMeteoArchive(loc, p, start, yesterday), { overwrite: true });
      });
    } else if (p.source === "brightsky") {
      // erster Lauf des Tages zählt → nicht überschreiben
      await step(p.id, async () => upsertCsv(f.fc, FC_COLUMNS, FC_KEY, await fetchMosmix(loc, p, today), { overwrite: false }));
    } else if (p.source === "metno") {
      await step(p.id, async () => upsertCsv(f.fc, FC_COLUMNS, FC_KEY, await fetchMetno(loc, p, today, USER_AGENT), { overwrite: false }));
    }
  }
}

// ---------- 2. Archiv-Import im Rahmen des Budgets ----------

const tasks = locations.flatMap((loc) => ["messwerte", ...archiveProviders.map((p) => p.id)].map((id) => ({ loc, id })));
const doneTo = (loc, id) => progress[loc.id]?.[id] ?? addDays(localDate(new Date(), loc.timezone), -RECENT_DAYS);
let stopReason = null;
const failed = new Set(); // bei Fehlern in diesem Lauf nicht erneut versuchen

archive: while (true) {
  const open = tasks.filter((t) => doneTo(t.loc, t.id) > ARCHIVE_FROM && !failed.has(`${t.loc.id}|${t.id}`));
  if (!open.length) break;
  for (const { loc, id } of open) { // eine Runde: jedes offene Paar ein Stück weiter zurück
    const end = addDays(doneTo(loc, id), -1);
    const start = addDays(end, -(CHUNK_DAYS - 1)) < ARCHIVE_FROM ? ARCHIVE_FROM : addDays(end, -(CHUNK_DAYS - 1));
    const provider = archiveProviders.find((p) => p.id === id);
    const cost = provider ? openMeteoCost(provider, start, end) : 0;
    if (cost > budget) { stopReason = "Budget für diesen Lauf aufgebraucht"; break archive; }
    const t0 = Date.now();
    const f = files(loc);
    try {
      const info = provider
        ? await upsertCsv(f.fc, FC_COLUMNS, FC_KEY, await fetchOpenMeteoArchive(loc, provider, start, end), { overwrite: true })
        : await upsertCsv(f.obs, OBS_COLUMNS, ["date"], await fetchObservations(loc, start, end), { overwrite: true });
      budget -= cost;
      (progress[loc.id] ??= {})[id] = start;
      await saveProgress();
      log(loc, `archiv ${id} ${start}…${end}`, true, info, t0);
    } catch (err) {
      if (err instanceof RateLimitError) { stopReason = `Open-Meteo-Limit erreicht: ${err.message}`; break archive; }
      failures++;
      failed.add(`${loc.id}|${id}`);
      log(loc, `archiv ${id} ${start}…${end}`, false, err.stack || err, t0);
      (status.archiveErrors ??= []).push(`${loc.id}/${id}: ${err.message}`);
    }
  }
}

async function saveProgress() {
  await writeFile(join(ROOT, "data", "archive-progress.json"), JSON.stringify(progress, null, 2) + "\n", "utf8");
}

// Fortschritt je Ort in Prozent (für das Dashboard)
const allLocations = await readJson("config/locations.json");
for (const loc of allLocations) {
  const today = localDate(new Date(), loc.timezone);
  const total = Date.parse(today) - Date.parse(ARCHIVE_FROM);
  const ids = ["messwerte", ...archiveProviders.map((p) => p.id)];
  const done = ids.map((id) => {
    const to = progress[loc.id]?.[id] ?? addDays(today, -RECENT_DAYS);
    return Math.min(1, (Date.parse(today) - Date.parse(to)) / total);
  });
  status.archive[loc.id] = Math.round((100 * done.reduce((a, b) => a + b, 0)) / ids.length);
}
if (stopReason) status.archiveNote = stopReason;

// Zusammenfassung für das Dashboard
try {
  const t0 = Date.now();
  const info = await buildSummary();
  console.log(`✔ Zusammenfassung: ${info.orte} Orte (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
} catch (err) {
  failures++;
  console.error(`✘ Zusammenfassung: ${err.stack || err}`);
}

// status.json: Ergebnisse anderer Orte bei --only erhalten
if (only) {
  const old = await readJson("data/status.json", { locations: {} });
  status.locations = { ...old.locations, ...status.locations };
}
await writeFile(join(ROOT, "data", "status.json"), JSON.stringify(status, null, 2) + "\n", "utf8");

const pending = Object.values(status.archive).some((v) => v < 100);
console.log(`\nArchiv: ${pending ? `noch nicht vollständig (${stopReason ?? "offen"})` : "vollständig"}.`);
console.log(failures ? `${failures} Schritt(e) fehlgeschlagen.` : "Alles erfolgreich.");
process.exitCode = failures ? 1 : 0;
