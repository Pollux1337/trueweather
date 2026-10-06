// Wählt gleichmäßig über Deutschland verteilte DWD-Niederschlagsstationen aus und prüft ihre Daten.
//
//   node collector/select-stations.mjs              445 Stationen vorschlagen und config/stations.json schreiben
//   node collector/select-stations.mjs --count 300  andere Anzahl
//
// Verfahren: „Farthest Point Sampling“. Begonnen wird mit der Station nahe der Mitte Deutschlands, dann
// kommt immer die Station dazu, die am weitesten von allen bisher gewählten entfernt ist. So entsteht ein
// gleichmäßiges Netz. Jede Station muss stündliche Niederschlagswerte seit Beginn des 24-Monats-Fensters
// haben und in zwei Stichprobenwochen über Bright Sky lückenlos sein.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sleep } from "./util.mjs";
import { windowStart } from "../lib/rain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const COUNT = Number(args.includes("--count") ? args[args.indexOf("--count") + 1] : 445);
const LIST = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/recent/RR_Stundenwerte_Beschreibung_Stationen.txt";

async function stationList() {
  const text = new TextDecoder("latin1").decode(await (await fetch(LIST)).arrayBuffer());
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{5})\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+?)\s{2,}(\S.*?)(?:\s{2,}|\s*$)/);
    if (m) out.push({ id: m[1], from: m[2], to: m[3], height: Number(m[4]), lat: Number(m[5]), lon: Number(m[6]), name: m[7].trim(), region: m[8].trim() });
  }
  return out;
}

function km(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Anteil lückenloser Niederschlagsstunden der Station selbst (ohne Ersatzwerte anderer Stationen)
async function coverage(id, from, to) {
  try {
    const j = await (await fetch(`https://api.brightsky.dev/weather?dwd_station_id=${id}&date=${from}&last_date=${to}&tz=Europe/Berlin`)).json();
    if (!j.weather) return 0;
    const obs = new Set(j.sources.filter((s) => s.observation_type !== "forecast").map((s) => s.id));
    const ok = j.weather.filter((w) => obs.has(w.source_id) && w.precipitation != null && !(w.fallback_source_ids || {}).precipitation).length;
    return ok / Math.round((Date.parse(to) - Date.parse(from)) / 3.6e6);
  } catch {
    return 0;
  } finally {
    await sleep(150);
  }
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const start = windowStart(new Date()).replace(/-/g, "");
const recent = isoDaysAgo(20).replace(/-/g, "");
const candidates = (await stationList()).filter((s) => s.from <= start && s.to >= recent);
console.log(`${candidates.length} aktive Niederschlagsstationen mit Daten seit ${start}`);

// Stichproben: eine Woche am Anfang des Fensters, eine aus den letzten Wochen
const w1 = [windowStart(new Date()), null];
w1[1] = new Date(Date.parse(w1[0]) + 7 * 86_400_000).toISOString().slice(0, 10);
const w2 = [isoDaysAgo(16), isoDaysAgo(9)];

const center = { lat: 51.16, lon: 10.45 };
const chosen = [];
const minDist = candidates.map(() => Infinity);
const rejected = new Set();
let first = candidates.reduce((best, s, i) => (km(s, center) < km(candidates[best], center) ? i : best), 0);
let next = first;
while (chosen.length < COUNT && next != null) {
  const s = candidates[next];
  const ok = (await coverage(s.id, ...w1)) >= 0.95 && (await coverage(s.id, ...w2)) >= 0.95;
  if (ok) {
    chosen.push(s);
    candidates.forEach((c, i) => { minDist[i] = Math.min(minDist[i], km(c, s)); });
    if (chosen.length % 25 === 0) console.log(`${chosen.length} Stationen, aktueller Abstand ${minDist.reduce((m, d, i) => (rejected.has(i) || d === 0 ? m : Math.max(m, d)), 0).toFixed(1)} km`);
  }
  rejected.add(next);
  // nächste Station: am weitesten von allen gewählten entfernt
  next = null;
  let best = -1;
  candidates.forEach((c, i) => { if (!rejected.has(i) && minDist[i] > best) { best = minDist[i]; next = i; } });
}

const spacing = Math.min(...chosen.map((s) => Math.min(...chosen.filter((t) => t !== s).map((t) => km(s, t)))));
console.log(`\n${chosen.length} Stationen gewählt, Mindestabstand ${spacing.toFixed(1)} km.`);
const stations = chosen
  .map((s) => ({ id: s.id, name: s.name, region: s.region, lat: s.lat, lon: s.lon, height: s.height }))
  .sort((a, b) => a.region.localeCompare(b.region, "de") || a.name.localeCompare(b.name, "de"));
await writeFile(join(ROOT, "config", "stations.json"), JSON.stringify(stations, null, 1) + "\n", "utf8");
console.log("config/stations.json geschrieben.");
