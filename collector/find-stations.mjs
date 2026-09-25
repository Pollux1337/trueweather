// Sucht DWD-Stationen für ein gleichmäßiges Raster über Deutschland und prüft ihre Datenqualität.
//
//   node collector/find-stations.mjs                 Vorschläge anzeigen (Rasterabstand 70 km)
//   node collector/find-stations.mjs --spacing 50    engeres Raster
//   node collector/find-stations.mjs --write         Vorschläge in config/locations.json übernehmen
//
// Kriterien: stündliche Temperatur, Niederschlag und Wind seit mindestens Dez. 2023 und aktuell aktiv,
// höchstens 800 m hoch (Gipfelstationen verzerren den Vergleich), mindestens 70 % des Rasterabstands
// von bereits vorhandenen Orten entfernt, und in Stichproben lückenlose Daten über Bright Sky.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sleep } from "./util.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const SPACING_KM = Number(args.includes("--spacing") ? args[args.indexOf("--spacing") + 1] : 70);
const WRITE = args.includes("--write");
const MAX_HEIGHT = 800;
const CDC = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly";
const LISTS = {
  temp: `${CDC}/air_temperature/recent/TU_Stundenwerte_Beschreibung_Stationen.txt`,
  rain: `${CDC}/precipitation/recent/RR_Stundenwerte_Beschreibung_Stationen.txt`,
  wind: `${CDC}/wind/recent/FF_Stundenwerte_Beschreibung_Stationen.txt`,
};

async function stationList(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const text = new TextDecoder("latin1").decode(buf);
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{5})\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+?)\s{2,}(\S.*?)\s{2,}/) ||
              line.match(/^\s*(\d{5})\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+?)\s{2,}(\S.*?)\s*$/);
    if (!m) continue;
    map.set(m[1], { id: m[1], from: m[2], to: m[3], height: Number(m[4]), lat: Number(m[5]), lon: Number(m[6]), name: m[7].trim(), region: m[8].trim() });
  }
  return map;
}

function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Anteil lückenloser Stunden (Temperatur, Regen, Wind) in einer Woche, ohne Ersatzwerte anderer Stationen
async function coverage(id, from, to) {
  const j = await (await fetch(`https://api.brightsky.dev/weather?dwd_station_id=${id}&date=${from}&last_date=${to}&tz=Europe/Berlin`)).json();
  await sleep(300);
  if (!j.weather) return 0;
  const obs = new Set(j.sources.filter((s) => s.observation_type !== "forecast").map((s) => s.id));
  const hours = j.weather.filter((w) => obs.has(w.source_id));
  const expected = Math.round((Date.parse(to) - Date.parse(from)) / 3.6e6);
  const ok = (k) => hours.filter((w) => w[k] != null && !(w.fallback_source_ids || {})[k]).length / expected;
  return Math.min(ok("temperature"), ok("precipitation"), ok("wind_speed"));
}

function slug(name) {
  return name.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------- Kandidaten ----------

const [temp, rain, wind] = await Promise.all([stationList(LISTS.temp), stationList(LISTS.rain), stationList(LISTS.wind)]);
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
const candidates = [...temp.values()].filter((s) =>
  rain.has(s.id) && wind.has(s.id) &&
  [temp, rain, wind].every((l) => l.get(s.id).from <= "20231201" && l.get(s.id).to >= recent) &&
  s.height <= MAX_HEIGHT);
console.log(`${temp.size} Temperatur-, ${rain.size} Regen-, ${wind.size} Windstationen → ${candidates.length} Kandidaten mit allen drei Messungen, ≤ ${MAX_HEIGHT} m`);

const locationsPath = join(ROOT, "config", "locations.json");
const locations = JSON.parse(await readFile(locationsPath, "utf8"));
const taken = locations.map((l) => ({ lat: l.lat, lon: l.lon }));
const usedIds = new Set(locations.map((l) => l.dwdStation));

// Raster: Zellen mit SPACING_KM Kantenlänge, je Zelle die Station nächst der Zellmitte
const dLat = SPACING_KM / 111, dLon = SPACING_KM / 70;
const cells = new Map();
for (const s of candidates) {
  const key = `${Math.floor(s.lat / dLat)}|${Math.floor(s.lon / dLon)}`;
  const center = { lat: (Math.floor(s.lat / dLat) + 0.5) * dLat, lon: (Math.floor(s.lon / dLon) + 0.5) * dLon };
  (cells.get(key) ?? cells.set(key, []).get(key)).push({ ...s, dist: km(s, center) });
}

const chosen = [];
for (const [, list] of [...cells].sort(([a], [b]) => (a < b ? -1 : 1))) {
  for (const s of list.sort((a, b) => a.dist - b.dist)) {
    if (usedIds.has(s.id)) break;
    if ([...taken, ...chosen].some((t) => km(t, s) < SPACING_KM * 0.7)) break;
    const c1 = await coverage(s.id, "2024-03-01", "2024-03-08");
    const c2 = c1 >= 0.95 ? await coverage(s.id, addDaysIso(-12), addDaysIso(-5)) : 0;
    if (c1 >= 0.95 && c2 >= 0.95) {
      chosen.push(s);
      console.log(`✔ ${s.id} ${s.name} (${s.region}, ${s.height} m)`);
      break;
    }
    console.log(`  ${s.id} ${s.name}: Daten lückenhaft (${Math.round(c1 * 100)} % / ${Math.round(c2 * 100)} %)`);
  }
}

function addDaysIso(n) {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

console.log(`\n${chosen.length} neue Stationen im ${SPACING_KM}-km-Raster.`);
const newLocations = chosen.map((s) => ({
  id: slug(s.name), name: s.name, region: s.region, capital: false,
  lat: s.lat, lon: s.lon, height: s.height, dwdStation: s.id, stationName: s.name, timezone: "Europe/Berlin",
}));

if (WRITE) {
  const ids = new Set(locations.map((l) => l.id));
  for (const l of newLocations) { while (ids.has(l.id)) l.id += "-2"; ids.add(l.id); }
  await writeFile(locationsPath, JSON.stringify([...locations, ...newLocations], null, 2) + "\n", "utf8");
  console.log(`config/locations.json: jetzt ${locations.length + newLocations.length} Orte.`);
} else {
  console.log("Zum Übernehmen mit --write aufrufen.");
}
