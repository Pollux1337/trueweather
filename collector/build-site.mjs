// Baut die Webseite nach _site/: statische Dateien plus vorberechnete Daten je Zeitraum.
//
//   node collector/build-site.mjs [--state <Ordner>] [--version <Kennung>]
//
// _site/data/meta.json        Stationen, Anbieter, Stand, Fortschritt
// _site/data/v-<Zeitraum>.json  je Station: 8 Anbieter × 10 Zellen × 9 Zähler (siehe lib/rain.js)

import { readdir, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { readJson, writeJson } from "./util.mjs";
import { VIEWS, CELLS, FIELDS, viewMonths } from "../lib/rain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STATE = resolve(arg("--state", join(ROOT, "state")));
const VERSION = arg("--version", String(Date.now()));
const OUT = join(ROOT, "_site");

const STATIC = ["index.html", "regen.js", "regen.css", "lib/rain.js", "wetter.html", "wetter.js", "wetter.css", "zuverlaessigkeit.html"];

const stations = await readJson(join(ROOT, "config", "stations.json"));
const providers = await readJson(join(ROOT, "config", "providers.json"));
const status = await readJson(join(STATE, "status.json"), {});

// Zähler aller Stationen laden
const accs = {};
let lastMonth = "0000-00";
const accDir = join(STATE, "acc");
for (const f of await readdir(accDir).catch(() => [])) {
  const id = f.replace(/\.json$/, "");
  accs[id] = JSON.parse(await readFile(join(accDir, f), "utf8"));
  for (const m of Object.keys(accs[id])) if (m > lastMonth) lastMonth = m;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "data"), { recursive: true });

const round = (v, i) => (i < 4 ? v : Math.round(v * 10) / 10);
const views = {};
for (const key of Object.keys(VIEWS)) {
  const months = lastMonth === "0000-00" ? [] : viewMonths(key, lastMonth);
  const out = {};
  for (const s of stations) {
    const acc = accs[s.id];
    if (!acc) continue;
    const flat = new Array(providers.length * CELLS.length * FIELDS.length).fill(0);
    let any = false;
    for (const m of months) {
      const byProv = acc[m];
      if (!byProv) continue;
      providers.forEach((p, pi) => {
        const cells = byProv[p.id];
        if (!cells) return;
        cells.forEach((c, ci) => c.forEach((v, fi) => {
          if (v) { flat[(pi * CELLS.length + ci) * FIELDS.length + fi] += v; any = true; }
        }));
      });
    }
    if (any) out[s.id] = flat.map((v, i) => round(v, i % FIELDS.length));
  }
  views[key] = { label: VIEWS[key].label, months: months.filter((m) => Object.values(accs).some((a) => a[m])) };
  await writeFile(join(OUT, "data", `v-${key}.json`), JSON.stringify(out), "utf8");
}

await writeJson(join(OUT, "data", "meta.json"), {
  generated: new Date().toISOString(),
  version: VERSION,
  lastMonth,
  status,
  views,
  providers: providers.map(({ id, name, org, maxLead, source }) => ({ id, name, org, maxLead, source })),
  stations,
});

// Statische Dateien kopieren, Versionskennung gegen veraltete Browser-Caches einsetzen
for (const f of STATIC) {
  const src = join(ROOT, f), dst = join(OUT, f);
  await mkdir(dirname(dst), { recursive: true });
  if (/\.(html|js)$/.test(f)) await writeFile(dst, (await readFile(src, "utf8")).replaceAll("__VERSION__", VERSION), "utf8");
  else await copyFile(src, dst);
}

console.log(`_site/ gebaut: ${Object.keys(accs).length} Stationen mit Daten, letzter Monat ${lastMonth}, Version ${VERSION}`);
