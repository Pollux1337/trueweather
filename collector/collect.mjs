// Sammelt täglich Vorhersagen und Messwerte für alle Orte aus config/locations.json.
//
//   node collector/collect.mjs                       Normalbetrieb (letzte 14 Tage nachziehen)
//   node collector/collect.mjs --backfill            Archiv ab 2024-01-01 importieren
//   node collector/collect.mjs --backfill 2025-01-01 Archiv ab einem bestimmten Datum
//   node collector/collect.mjs --only luebeck        nur einen Ort

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { addDays, localDate, upsertCsv } from "./util.mjs";
import { fetchObservations, fetchOpenMeteoArchive, fetchMosmix, fetchMetno } from "./sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OBS_COLUMNS = ["date", "tmax", "tmin", "precip", "wind"];
const FC_COLUMNS = ["target", "provider", "lead", "tmax", "tmin", "precip", "wind"];
const USER_AGENT = process.env.MET_USER_AGENT || "WetterVorhersageCheck/1.0 (privates Hobbyprojekt)";

const args = process.argv.slice(2);
const backfillIdx = args.indexOf("--backfill");
const backfillFrom = backfillIdx >= 0 ? (/^\d{4}-\d{2}-\d{2}$/.test(args[backfillIdx + 1] || "") ? args[backfillIdx + 1] : "2024-01-01") : null;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const locations = (await readJson("config/locations.json")).filter((l) => !only || l.id === only);
const providers = await readJson("config/providers.json");

const status = { lastRun: new Date().toISOString(), mode: backfillFrom ? `backfill ab ${backfillFrom}` : "täglich", locations: {} };
let failures = 0;

for (const loc of locations) {
  const today = localDate(new Date(), loc.timezone);
  const yesterday = addDays(today, -1);
  const start = backfillFrom ?? addDays(today, -14);
  const obsFile = join(ROOT, "data", loc.id, "observations.csv");
  const fcFile = join(ROOT, "data", loc.id, "forecasts.csv");
  const results = [];
  status.locations[loc.id] = { today, results };

  async function step(name, fn) {
    const t0 = Date.now();
    try {
      const info = await fn();
      results.push({ step: name, ok: true, ...info });
      console.log(`✔ ${loc.name} · ${name}: ${JSON.stringify(info)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      failures++;
      results.push({ step: name, ok: false, error: String(err.message || err) });
      console.error(`✘ ${loc.name} · ${name}: ${err.stack || err}`);
    }
  }

  // Messwerte: bei jedem Lauf die letzten Tage erneut prüfen, weil der DWD Werte nachliefert
  await step("messwerte", async () => {
    const rows = await fetchObservations(loc, start, yesterday);
    return upsertCsv(obsFile, OBS_COLUMNS, ["date"], rows, { overwrite: true });
  });

  for (const p of providers) {
    if (p.source === "openmeteo") {
      // Archiv ist maßgeblich und ergänzt Lücken selbst → überschreiben
      await step(p.id, async () => {
        const rows = await fetchOpenMeteoArchive(loc, p, start, yesterday);
        return upsertCsv(fcFile, FC_COLUMNS, ["target", "provider", "lead"], rows, { overwrite: true });
      });
    } else if (backfillFrom) {
      continue; // MOSMIX und MET Norway haben kein Archiv
    } else if (p.source === "brightsky") {
      // erster Lauf des Tages zählt → nicht überschreiben
      await step(p.id, async () => upsertCsv(fcFile, FC_COLUMNS, ["target", "provider", "lead"], await fetchMosmix(loc, p, today), { overwrite: false }));
    } else if (p.source === "metno") {
      await step(p.id, async () => upsertCsv(fcFile, FC_COLUMNS, ["target", "provider", "lead"], await fetchMetno(loc, p, today, USER_AGENT), { overwrite: false }));
    }
  }
}

await writeFile(join(ROOT, "data", "status.json"), JSON.stringify(status, null, 2) + "\n", "utf8");
console.log(failures ? `\n${failures} Schritt(e) fehlgeschlagen.` : "\nAlles erfolgreich.");
process.exitCode = failures ? 1 : 0;
