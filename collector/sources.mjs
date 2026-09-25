import { fetchJson, aggregateDaily, addDays, daysBetween, localDate, round1, sleep } from "./util.mjs";

// ---------- Messwerte: DWD-Station über Bright Sky ----------

export async function fetchObservations(loc, start, end) {
  const points = new Map(); // timestamp -> Stundenwert
  for (let from = start; from <= end; from = addDays(from, 30)) {
    const to = addDays(from, 30) <= end ? addDays(from, 30) : addDays(end, 1);
    const url = `https://api.brightsky.dev/weather?dwd_station_id=${loc.dwdStation}&date=${from}&last_date=${to}&tz=${encodeURIComponent(loc.timezone)}`;
    const j = await fetchJson(url);
    const obsSources = new Set(j.sources.filter((s) => s.observation_type !== "forecast").map((s) => s.id));
    for (const w of j.weather) {
      if (!obsSources.has(w.source_id)) continue;
      const date = w.timestamp.slice(0, 10);
      if (date < start || date > end) continue;
      points.set(w.timestamp, { date, temp: w.temperature, precip: w.precipitation, wind: w.wind_speed });
    }
  }
  const days = aggregateDaily([...points.values()]);
  // Nur Tage mit vollständiger Temperatur gelten als gemessen
  return [...days].filter(([, d]) => d.tmax != null).map(([date, d]) => ({ date, ...d }));
}

// ---------- Open-Meteo: archivierte Vorhersagen (Previous Runs API) ----------
// temperature_2m_previous_dayK = Vorhersage, die K Tage vorher für diese Stunde gemacht wurde.

export async function fetchOpenMeteoArchive(loc, provider, start, end) {
  const leads = Array.from({ length: provider.maxLead }, (_, i) => i + 1);
  const vars = leads.flatMap((k) => [`temperature_2m_previous_day${k}`, `precipitation_previous_day${k}`, `wind_speed_10m_previous_day${k}`]);
  const rows = [];
  for (let from = start; from <= end; from = addDays(from, 92)) {
    const to = addDays(from, 91) < end ? addDays(from, 91) : end;
    const params = new URLSearchParams({
      latitude: loc.lat, longitude: loc.lon, hourly: vars.join(","), models: provider.model,
      start_date: from, end_date: to, timezone: loc.timezone, wind_speed_unit: "kmh",
    });
    const j = await fetchJson(`https://previous-runs-api.open-meteo.com/v1/forecast?${params}`);
    const h = j.hourly;
    const col = (name) => h[name] ?? h[`${name}_${provider.model}`] ?? [];
    for (const k of leads) {
      const t = col(`temperature_2m_previous_day${k}`), p = col(`precipitation_previous_day${k}`), w = col(`wind_speed_10m_previous_day${k}`);
      const points = h.time.map((time, i) => ({ date: time.slice(0, 10), temp: t[i], precip: p[i], wind: w[i] }));
      for (const [target, d] of aggregateDaily(points)) {
        if (d.tmax != null) rows.push({ target, provider: provider.id, lead: k, ...d });
      }
    }
    await sleep(1_500); // Rate-Limit schonen
  }
  return rows;
}

// ---------- DWD MOSMIX über Bright Sky (aktuelle Vorhersage, täglich gesammelt) ----------

export async function fetchMosmix(loc, provider, today) {
  const url = `https://api.brightsky.dev/weather?dwd_station_id=${loc.dwdStation}&date=${addDays(today, 1)}&last_date=${addDays(today, provider.maxLead + 1)}&tz=${encodeURIComponent(loc.timezone)}`;
  const j = await fetchJson(url);
  const fcSources = new Set(j.sources.filter((s) => s.observation_type === "forecast").map((s) => s.id));
  const points = j.weather
    .filter((w) => fcSources.has(w.source_id))
    .map((w) => ({ date: w.timestamp.slice(0, 10), temp: w.temperature, precip: w.precipitation, wind: w.wind_speed }));
  return toLeadRows(aggregateDaily(points), provider, today);
}

// ---------- MET Norway Locationforecast (aktuelle Vorhersage, täglich gesammelt) ----------
// Die ersten ~2,5 Tage kommen stündlich, danach in 6-Stunden-Blöcken.

export async function fetchMetno(loc, provider, today, userAgent) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`;
  const j = await fetchJson(url, { headers: { "User-Agent": userAgent } });
  const ts = j.properties.timeseries;
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { temps: [], precip: 0, precipHours: 0, winds: [], hours: 0 });
    return days.get(date);
  };

  for (let i = 0; i < ts.length; i++) {
    const e = ts[i];
    const start = new Date(e.time);
    const next = ts[i + 1] ? new Date(ts[i + 1].time) : null;
    const gap = next ? Math.round((next - start) / 3_600_000) : 0;
    const d = e.data;
    const block = d.next_1_hours && gap === 1 ? { h: 1, ...d.next_1_hours.details } : d.next_6_hours ? { h: Math.min(6, gap || 6), ...d.next_6_hours.details } : null;
    if (!block) continue;

    // Temperatur und Wind (Momentanwert) gehören zum Startzeitpunkt
    const startDay = day(localDate(start, loc.timezone));
    startDay.temps.push(d.instant.details.air_temperature);
    startDay.winds.push(d.instant.details.wind_speed * 3.6);

    // Blockwerte: Extremwerte zum Tag der Blockmitte, Niederschlag anteilig pro Stunde
    const mid = new Date(start.getTime() + (block.h / 2) * 3_600_000);
    const midDay = day(localDate(mid, loc.timezone));
    if (block.air_temperature_max != null) midDay.temps.push(block.air_temperature_max);
    if (block.air_temperature_min != null) midDay.temps.push(block.air_temperature_min);
    for (let k = 0; k < block.h; k++) {
      const hourDay = day(localDate(new Date(start.getTime() + k * 3_600_000), loc.timezone));
      hourDay.hours++;
      if (block.precipitation_amount != null) {
        hourDay.precip += block.precipitation_amount / block.h;
        hourDay.precipHours++;
      }
    }
  }

  const result = new Map();
  for (const [date, d] of days) {
    if (d.hours < 22 || !d.temps.length) continue; // Tag nicht vollständig abgedeckt
    result.set(date, {
      tmax: round1(Math.max(...d.temps)),
      tmin: round1(Math.min(...d.temps)),
      precip: d.precipHours >= 22 ? round1(d.precip) : null,
      wind: round1(Math.max(...d.winds)),
    });
  }
  return toLeadRows(result, provider, today);
}

function toLeadRows(days, provider, today) {
  const rows = [];
  for (const [target, d] of days) {
    const lead = daysBetween(today, target);
    if (lead >= 1 && lead <= provider.maxLead && d.tmax != null) rows.push({ target, provider: provider.id, lead, ...d });
  }
  return rows;
}
