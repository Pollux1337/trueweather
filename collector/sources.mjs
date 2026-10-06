// Datenquellen. Alle liefern stündliche Niederschlagsmengen als Map(Stundenschlüssel → mm),
// Schlüssel = Beginn der Stunde in deutscher Ortszeit (siehe util.hourKey).

import { fetchJson, addDays, hourKey, hourKeyFromEnd, sleep } from "./util.mjs";

const add = (map, key, mm) => map.set(key, (map.get(key) || 0) + mm);

// ---------- Messwerte: DWD-Station über Bright Sky ----------

export async function fetchObservations(station, from, to) {
  const series = new Map();
  // ein Tag Rand, damit auch die ersten/letzten Stunden in Ortszeit vollständig sind
  for (let a = addDays(from, -1); a <= addDays(to, 1); a = addDays(a, 31)) {
    const b = addDays(a, 31) < addDays(to, 2) ? addDays(a, 31) : addDays(to, 2);
    let j;
    try {
      j = await fetchJson(`https://api.brightsky.dev/weather?dwd_station_id=${station.id}&date=${a}&last_date=${b}&tz=UTC`);
    } catch (err) {
      if (err.status === 404) continue; // Station hat in diesem Zeitraum keine Messwerte → Tage bleiben unbewertet
      throw err;
    }
    const own = new Set(j.sources.filter((s) => s.observation_type !== "forecast").map((s) => s.id));
    for (const w of j.weather) {
      // nur Werte dieser Station, keine Ersatzwerte von Nachbarstationen
      if (!own.has(w.source_id) || w.precipitation == null || (w.fallback_source_ids || {}).precipitation) continue;
      add(series, hourKeyFromEnd(new Date(w.timestamp)), w.precipitation);
    }
  }
  return series;
}

// ---------- Open-Meteo: archivierte Vorhersagen (Previous Runs API) ----------
// precipitation_previous_dayK = Vorhersage, die K Tage vorher für diese Stunde gemacht wurde

// Open-Meteo zählt Abfragen mit mehr als 10 Variablen oder 14 Tagen mehrfach
export const openMeteoCost = (provider, days) => Math.max(1, provider.maxLead / 10) * Math.max(1, days / 14);

export async function fetchOpenMeteo(station, provider, from, to) {
  const leads = Array.from({ length: provider.maxLead }, (_, i) => i + 1);
  const params = new URLSearchParams({
    latitude: station.lat, longitude: station.lon, models: provider.model, timezone: "GMT",
    hourly: leads.map((k) => `precipitation_previous_day${k}`).join(","),
    start_date: addDays(from, -1), end_date: addDays(to, 1),
  });
  const j = await fetchJson(`https://previous-runs-api.open-meteo.com/v1/forecast?${params}`);
  const h = j.hourly;
  const byLead = {};
  for (const k of leads) {
    const col = h[`precipitation_previous_day${k}`] ?? h[`precipitation_previous_day${k}_${provider.model}`] ?? [];
    const series = new Map();
    h.time.forEach((t, i) => { if (col[i] != null) add(series, hourKeyFromEnd(new Date(t + ":00Z")), col[i]); });
    byLead[k] = series;
  }
  await sleep(Math.max(800, openMeteoCost(provider, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 3) * 130)); // Minutenlimit schonen
  return byLead;
}

// ---------- DWD MOSMIX über Bright Sky (aktuelle Vorhersage, täglich gesammelt) ----------

export async function fetchMosmix(station, today, maxLead) {
  const range = `date=${today}&last_date=${addDays(today, maxLead + 2)}&tz=UTC`;
  let j;
  try {
    j = await fetchJson(`https://api.brightsky.dev/weather?dwd_station_id=${station.id}&${range}`);
  } catch (err) {
    // Die meisten Regenstationen haben keinen eigenen MOSMIX-Punkt: nächsten im Umkreis von 15 km nehmen
    if (err.status !== 404) throw err;
    try {
      j = await fetchJson(`https://api.brightsky.dev/weather?lat=${station.lat}&lon=${station.lon}&max_dist=15000&${range}`);
    } catch (err2) {
      if (err2.status === 404) return null; // kein MOSMIX in der Nähe
      throw err2;
    }
  }
  const fc = new Set(j.sources.filter((s) => s.observation_type === "forecast").map((s) => s.id));
  const series = new Map();
  for (const w of j.weather) {
    if (fc.has(w.source_id) && w.precipitation != null) add(series, hourKeyFromEnd(new Date(w.timestamp)), w.precipitation);
  }
  return { fine: series, coarse: new Map() };
}

// ---------- MET Norway Locationforecast (aktuelle Vorhersage, täglich gesammelt) ----------
// Die ersten ~2,5 Tage stündlich („fine“), danach 6-Stunden-Blöcke („coarse“, gleichmäßig verteilt).
// 2-Stunden-Abschnitte werden nur aus stündlichen Werten gebildet.

export async function fetchMetno(station, userAgent) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${station.lat.toFixed(4)}&lon=${station.lon.toFixed(4)}`;
  const j = await fetchJson(url, { headers: { "User-Agent": userAgent } });
  const ts = j.properties.timeseries;
  const fine = new Map(), coarse = new Map();
  for (let i = 0; i < ts.length; i++) {
    const start = new Date(ts[i].time);
    const gap = ts[i + 1] ? Math.round((new Date(ts[i + 1].time) - start) / 3_600_000) : 0;
    const d = ts[i].data;
    if (d.next_1_hours && gap === 1) {
      add(fine, hourKey(start), d.next_1_hours.details.precipitation_amount ?? 0);
    } else if (d.next_6_hours && gap > 1) {
      const hours = Math.min(6, gap);
      const mm = d.next_6_hours.details.precipitation_amount ?? 0;
      for (let k = 0; k < hours; k++) add(coarse, hourKey(new Date(start.getTime() + k * 3_600_000)), mm / hours);
    }
  }
  return { fine, coarse };
}
