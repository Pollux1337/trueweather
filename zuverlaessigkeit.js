// Vorhersage-Check – vergleicht archivierte Vorhersagen mit DWD-Messwerten.
// „Alle Orte“ und die Karte nutzen die vorberechnete data/summary.json, ein einzelner Ort seine Rohdaten.

import {
  METRICS, METRIC_KEYS, RAIN_MM, MIN_N, MIN_N_MONTH, LEADS,
  parseCsv, computePairs, computeStats, relativeByLead, score, badness, computeRanking, mean,
} from "./lib/scoring.js?v=__VERSION__";

const ALL = "__alle";
const GEO_URL = "https://cdn.jsdelivr.net/gh/isellsoap/deutschlandGeoJSON@main/2_bundeslaender/3_mittel.geo.json";
const LEAD_GROUPS = { all: LEADS, short: [1, 2], mid: [3, 4], long: [5, 6, 7] };

const $ = (id) => document.getElementById(id);
const state = { providers: [], locations: [], status: null, summary: null, cache: {}, charts: {}, geo: null, ctx: null };

// ---------- Hilfsfunktionen ----------

const fmt = (v, digits = 1) => (v == null ? "–" : v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const fmtDate = (d, opts = { day: "numeric", month: "long", year: "numeric" }) => new Date(d + "T12:00").toLocaleDateString("de-DE", opts);
const leadLabel = (k) => (k === 1 ? "1 Tag" : `${k} Tage`);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const color = (p) => cssVar(`--series-${state.providers.indexOf(p) + 1}`);
const providerById = (id) => state.providers.find((p) => p.id === id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (v) => {
  if (v == null) return "–";
  const r = Math.round(v);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)} %`;
};

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function showStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = !text;
}

// ---------- Laden ----------

async function init() {
  try {
    const [providers, locations] = await Promise.all([
      fetchText("config/providers.json").then(JSON.parse),
      fetchText("config/locations.json").then(JSON.parse),
    ]);
    state.providers = providers;
    state.locations = locations;
    [state.status, state.summary] = await Promise.all([
      fetchText("data/status.json").then(JSON.parse).catch(() => null),
      fetchText("data/summary.json").then(JSON.parse).catch(() => null),
    ]);

    const sorted = [...locations].sort((a, b) => a.name.localeCompare(b.name, "de"));
    $("f-location").innerHTML = `<option value="${ALL}">Alle ${locations.length} Orte (gemittelt)</option>` +
      sorted.map((l) => `<option value="${l.id}">${esc(l.name)} (${esc(l.region)})</option>`).join("");
    const params = new URLSearchParams(location.search);
    if (params.get("ort") && locations.some((l) => l.id === params.get("ort"))) $("f-location").value = params.get("ort");

    $("m-mode").innerHTML = `<option value="best">Bester Anbieter je Region</option>` +
      providers.map((p) => `<option value="${p.id}">Nur ${esc(p.name)}: wo gut, wo schlecht?</option>`).join("");

    for (const id of ["f-location", "f-metric", "f-period", "f-common", "f-trend-lead"]) $(id).addEventListener("change", update);
    for (const id of ["m-metric", "m-leads", "m-mode"]) $(id).addEventListener("change", () => renderMap(state.ctx));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", update);
    await update();
  } catch (err) {
    console.error(err);
    showStatus("Die Daten konnten nicht geladen werden. Läuft die Seite über einen Webserver (nicht als Datei geöffnet)?", true);
  }
}

async function loadLocation(id) {
  if (!state.cache[id]) {
    const [obsText, fcText] = await Promise.all([fetchText(`data/${id}/observations.csv`), fetchText(`data/${id}/forecasts.csv`)]);
    state.cache[id] = { obs: new Map(parseCsv(obsText).map((r) => [r.date, r])), fc: parseCsv(fcText) };
  }
  return state.cache[id];
}

// ---------- Kontext: alles, was die Anzeige braucht ----------
// stats[pid][lead] = {n, value, bias}; rel[loc][metric][pid] = [7 Werte]; trend(lead) = {months, values[pid][i]}

function contextFromSummary(metric, period, common) {
  const view = state.summary?.views[`${period}|${common ? 1 : 0}`];
  if (!view || !view.days) return null;
  const stats = {};
  for (const p of state.providers) {
    stats[p.id] = {};
    LEADS.forEach((k, i) => {
      const [n, value, bias] = view.pooled[metric][p.id][i];
      stats[p.id][k] = { n, value, bias };
    });
  }
  const fromMonth = view.firstDay.slice(0, 7);
  const trend = (lead) => {
    const byProv = state.summary.trend[common ? 1 : 0][metric]?.[lead] || {};
    const months = [...new Set(Object.values(byProv).flatMap((o) => Object.keys(o)))].filter((mo) => mo >= fromMonth).sort();
    return { months, values: Object.fromEntries(Object.entries(byProv).map(([pid, o]) => [pid, months.map((mo) => o[mo] ?? null)])), counts: null };
  };
  const locs = Object.entries(view.locDays).filter(([, n]) => n > 0);
  return {
    stats, rel: view.rel, trend, locDays: view.locDays,
    meta: { days: view.days, firstDay: view.firstDay, lastObs: view.lastObs, locCount: locs.length, locDaysTotal: locs.reduce((a, [, n]) => a + n, 0) },
  };
}

function contextFromLocation(loc, data, metric, period, common) {
  let pairs = null, lastObs = null;
  const rel = { [loc.id]: {} };
  for (const m of METRIC_KEYS) {
    const r = computePairs(data, m, period, common, state.providers, loc.id);
    rel[loc.id][m] = relativeByLead(computeStats(r.pairs, METRICS[m].kind, state.providers), METRICS[m].kind, state.providers);
    if (m === metric) { pairs = r.pairs; lastObs = r.lastObs; }
  }
  if (!pairs.length) return null;
  const stats = computeStats(pairs, METRICS[metric].kind, state.providers);
  const trend = (lead) => {
    const months = [...new Set(pairs.map((p) => p.target.slice(0, 7)))].sort();
    const groups = new Map();
    for (const p of pairs) {
      if (p.lead !== lead) continue;
      const key = `${p.provider}|${p.target.slice(0, 7)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const values = {}, counts = {};
    for (const p of state.providers) {
      const s = months.map((mo) => score(groups.get(`${p.id}|${mo}`) || [], METRICS[metric].kind));
      values[p.id] = s.map((x) => (x.n >= MIN_N_MONTH ? x.value : null));
      counts[p.id] = s.map((x) => x.n);
    }
    return { months, values, counts };
  };
  const targets = new Set(pairs.map((p) => p.target));
  return {
    stats, rel, trend, data,
    meta: { days: targets.size, firstDay: [...targets].sort()[0], lastObs, locCount: 1, locDaysTotal: targets.size },
  };
}

// ---------- Anzeige ----------

const CARDS = ["kpis", "map-card", "ranking-card", "city-card", "lead-card", "table-card", "trend-card", "latest-card"];

async function update() {
  const selection = $("f-location").value;
  const all = selection === ALL;
  const metric = $("f-metric").value;
  const period = $("f-period").value, common = $("f-common").checked;
  const loc = state.locations.find((l) => l.id === selection);
  renderWarning();

  let ctx = null;
  if (all) {
    ctx = contextFromSummary(metric, period, common);
  } else {
    showStatus(`Lade ${loc.name} …`);
    try {
      ctx = contextFromLocation(loc, await loadLocation(loc.id), metric, period, common);
    } catch {
      ctx = null;
    }
  }
  if (!ctx) {
    for (const id of CARDS) $(id).hidden = true;
    // Karte trotzdem zeigen: alle Regionen grau, bis Daten da sind
    if (all) { state.ctx = { all: true, rel: {}, locDays: {} }; renderMap(state.ctx); }
    return showStatus(common
      ? "Für diese Auswahl gibt es noch keine vergleichbaren Tage. „Nur Tage, an denen alle Anbieter Daten haben“ braucht einige Tage Sammelzeit."
      : all ? "Es liegen noch keine Daten vor." : `Für ${loc.name} liegen noch keine Daten vor. Der Import läuft.`, true);
  }
  Object.assign(ctx, { all, loc, metric, m: METRICS[metric] });
  state.ctx = ctx;
  showStatus("");
  renderKpis(ctx);
  renderMap(ctx);
  renderRanking(ctx);
  renderLeadChart(ctx);
  renderMatrix(ctx);
  renderTrend(ctx);
  renderLatest(ctx);
}

function renderWarning() {
  const s = state.status;
  if (!s) { $("warning").hidden = true; $("info").hidden = true; return; }
  const failed = Object.entries(s.locations || {}).flatMap(([id, l]) => l.results.filter((r) => !r.ok).map((r) => `${id}/${r.step}`));
  $("warning").hidden = !failed.length;
  $("warning").textContent = failed.length
    ? `Beim letzten Sammellauf gab es Fehler bei: ${failed.slice(0, 6).join(", ")}${failed.length > 6 ? ` und ${failed.length - 6} weiteren` : ""}.`
    : "";

  const archive = Object.entries(s.archive || {});
  const pending = archive.filter(([, v]) => v < 100);
  $("info").hidden = !pending.length;
  if (pending.length) {
    const avg = Math.round(archive.reduce((a, [, v]) => a + v, 0) / archive.length);
    $("info").textContent = `Archiv-Import läuft: ${avg} % der Daten seit Januar 2024 sind eingelesen. Er wird bei jedem täglichen Lauf fortgesetzt, zuerst die jüngsten Monate. Bis dahin beruhen die Werte bei ${pending.length} Orten auf einem kürzeren Zeitraum.`;
  }
}

function bestAt(stats, lead, kind) {
  let best = null;
  for (const p of state.providers) {
    const s = stats[p.id][lead];
    if (s.n < MIN_N) continue;
    if (!best || badness(s, kind) < badness(best.s, kind)) best = { p, s };
  }
  return best;
}

function renderKpis({ m, stats, meta, loc, all }) {
  const short = { day: "numeric", month: "short", year: "numeric" };
  const b1 = bestAt(stats, 1, m.kind);
  const b5 = bestAt(stats, 5, m.kind);
  const avg = (k) => mean(state.providers.map((p) => stats[p.id][k]).filter((s) => s.n >= MIN_N).map((s) => s.value));
  const unit = m.unit === "%" ? " %" : ` ${m.unit}`;
  const lastRun = state.status?.lastRun ? new Date(state.status.lastRun).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "–";
  const tile = (label, value, note) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
  const range = `${fmtDate(meta.firstDay, short)} bis ${fmtDate(meta.lastObs, short)}`;
  const what = m.kind === "hit" ? "Trefferquote" : "Ø Abweichung";
  $("kpis").innerHTML = [
    tile("Ausgewertete Tage", meta.days.toLocaleString("de-DE"), all ? `${range} · ${meta.locCount} Orte, zusammen ${meta.locDaysTotal.toLocaleString("de-DE")} Messtage` : `${range} · Station ${esc(loc.stationName)}`),
    tile("Am genauesten für morgen", b1 ? b1.p.name : "–", b1 ? `${what} ${fmt(b1.s.value, m.digits)}${unit}` : "zu wenig Daten"),
    tile("Am genauesten für in 5 Tagen", b5 ? b5.p.name : "–", b5 ? `${what} ${fmt(b5.s.value, m.digits)}${unit}` : "zu wenig Daten"),
    tile(`${what}: Tag 1 → Tag 7`, `${fmt(avg(1), m.digits)} → ${fmt(avg(7), m.digits)}${unit}`, `Mittel aller Anbieter · letzte Aktualisierung ${lastRun}`),
  ].join("");
  $("kpis").hidden = false;
}

// ---------- Karte ----------

async function loadGeo() {
  if (!state.geo) state.geo = await fetch(GEO_URL).then((r) => r.json());
  return state.geo;
}

function mapRanking(ctx) {
  const metricSel = $("m-metric").value;
  return computeRanking(ctx.rel, state.providers, {
    leads: LEAD_GROUPS[$("m-leads").value],
    metrics: metricSel === "gesamt" ? METRIC_KEYS : [metricSel],
  });
}

async function renderMap(ctx) {
  if (!ctx) return;
  $("map-card").hidden = !ctx.all;
  if (!ctx.all || typeof d3 === "undefined") return;
  let geo;
  try { geo = await loadGeo(); } catch {
    $("map").innerHTML = `<p class="status error">Die Kartengrundlage konnte nicht geladen werden.</p>`;
    return;
  }

  const mode = $("m-mode").value;
  const { byLoc } = mapRanking(ctx);
  const W = 600, H = 800;
  const projection = d3.geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], geo);
  const path = d3.geoPath(projection);
  const locs = state.locations; // alle Stationen; ohne genug Daten bleibt die Fläche grau
  const pts = locs.map((l) => projection([l.lon, l.lat]));
  const voronoi = d3.Delaunay.from(pts).voronoi([0, 0, W, H]);

  // Farbe je Region
  const better = cssVar("--better"), worse = cssVar("--worse"), mid = isDark() ? "#383835" : "#f0efec";
  const diverge = d3.scaleLinear().domain([-25, 0, 25]).range([worse, mid, better]).clamp(true);
  const noData = cssVar("--nodata");
  const fillFor = (l) => {
    const ranking = byLoc[l.id] || [];
    if (mode === "best") return ranking[0] ? color(ranking[0].p) : noData;
    const r = ranking.find((x) => x.p.id === mode);
    return r ? diverge(r.total) : noData;
  };

  const svg = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Deutschlandkarte: ${mode === "best" ? "bester Wetterdienst je Region" : `Güte von ${esc(providerById(mode).name)} je Region`}">`,
    `<defs><clipPath id="de-clip"><path d="${path(geo)}"/></clipPath></defs>`,
    `<g clip-path="url(#de-clip)">`];
  locs.forEach((l, i) => {
    svg.push(`<path class="cell" data-i="${i}" d="${voronoi.renderCell(i)}" fill="${fillFor(l)}"/>`);
  });
  svg.push(`</g>`);
  svg.push(`<path class="states" d="${path(geo)}"/>`);
  locs.forEach((l, i) => {
    const [x, y] = pts[i];
    svg.push(`<circle class="station${l.capital ? " capital" : ""}" cx="${x}" cy="${y}" r="${l.capital ? 4 : 2.8}"/>`);
    if (l.capital) svg.push(`<text class="city-label" x="${x + 6}" y="${y + 4}">${esc(l.name)}</text>`);
  });
  svg.push(`</svg>`);
  $("map").innerHTML = svg.join("");

  // Tooltip
  const tip = $("map-tip");
  const box = $("map");
  box.querySelectorAll(".cell").forEach((cell) => {
    cell.addEventListener("mousemove", (e) => {
      const l = locs[Number(cell.dataset.i)];
      const ranking = byLoc[l.id] || [];
      const rows = mode === "best"
        ? ranking.slice(0, 3).map((r, i) => `<div><span class="swatch" style="background:${color(r.p)}"></span>${i + 1}. ${esc(r.p.name)} <span class="muted">${pct(r.total)}</span></div>`).join("")
        : (() => { const r = ranking.find((x) => x.p.id === mode); return `<div>${esc(providerById(mode).name)}: <strong>${pct(r?.total)}</strong> gegenüber dem Durchschnitt</div>`; })();
      const days = (ctx.locDays?.[l.id] || 0).toLocaleString("de-DE");
      tip.innerHTML = `<strong>${esc(l.name)}</strong><div class="muted">${esc(l.region)} · Station ${esc(l.stationName)} · ${days} Tage</div>${ranking.length ? rows : '<div class="muted">Noch zu wenig Daten, wird gerade gesammelt.</div>'}`;
      const rect = box.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      tip.style.left = `${Math.min(x + 14, rect.width - 250)}px`;
      tip.style.top = `${y + 14}px`;
      tip.hidden = false;
      box.querySelectorAll(".cell.hover").forEach((c) => c.classList.remove("hover"));
      cell.classList.add("hover");
    });
    cell.addEventListener("mouseleave", () => { tip.hidden = true; cell.classList.remove("hover"); });
  });

  renderMapLegend(mode, byLoc, locs, diverge);
  renderStateTable(byLoc, locs);
}

function renderMapLegend(mode, byLoc, locs) {
  const missing = locs.filter((l) => !byLoc[l.id]?.length).length;
  const gray = missing ? `<span class="legend-item"><span class="swatch" style="background:var(--nodata)"></span>noch zu wenig Daten <strong>${missing}</strong></span>` : "";
  renderMapLegendInner(mode, byLoc, locs);
  $("map-legend").insertAdjacentHTML("beforeend", gray);
}

function renderMapLegendInner(mode, byLoc, locs) {
  if (mode === "best") {
    const wins = {};
    for (const l of locs) { const w = byLoc[l.id]?.[0]; if (w) wins[w.p.id] = (wins[w.p.id] || 0) + 1; }
    const rated = Object.values(wins).reduce((a, b) => a + b, 0);
    $("map-legend").innerHTML = state.providers
      .map((p) => ({ p, n: wins[p.id] || 0 }))
      .sort((a, b) => b.n - a.n)
      .map(({ p, n }) => `<span class="legend-item${n ? "" : " zero"}"><span class="swatch" style="background:${color(p)}"></span>${esc(p.name)} <strong>${n}</strong></span>`)
      .join("") + `<span class="legend-note">Anzahl Regionen mit Platz 1, von ${rated} bewerteten</span>`;
  } else {
    $("map-legend").innerHTML = `<span class="legend-note">ungenauer als der Durchschnitt</span><span class="gradient"></span><span class="legend-note">genauer</span><span class="legend-note">(−25 % … +25 %)</span>`;
  }
}

// Bester Anbieter je Bundesland: Gesamtwerte der Orte im Land gemittelt
function renderStateTable(byLoc, locs) {
  const regions = new Map();
  for (const l of locs) {
    if (!regions.has(l.region)) regions.set(l.region, []);
    regions.get(l.region).push(l);
  }
  const rows = [...regions].sort(([a], [b]) => a.localeCompare(b, "de")).map(([region, ls]) => {
    const ranked = state.providers
      .map((p) => ({ p, total: mean(ls.map((l) => byLoc[l.id]?.find((r) => r.p.id === p.id)?.total ?? null)) }))
      .filter((r) => r.total != null)
      .sort((a, b) => b.total - a.total);
    return { region, n: ls.length, ranked };
  });
  const cell = (r) => (r ? `<span class="swatch" style="background:${color(r.p)}"></span>${esc(r.p.name)} <span class="muted">${pct(r.total)}</span>` : `<span class="muted">–</span>`);
  $("states").innerHTML = `<thead><tr><th>Bundesland</th><th>Orte</th><th>🥇 Am sinnvollsten</th><th>🥈 Platz 2</th><th>🥉 Platz 3</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="name">${esc(r.region)}</td><td>${r.n}</td><td class="left">${cell(r.ranked[0])}</td><td class="left">${cell(r.ranked[1])}</td><td class="left">${cell(r.ranked[2])}</td></tr>`).join("") +
    `</tbody>`;
}

// ---------- Ranking ----------

function renderRanking(ctx) {
  const { all, metric, rel, stats, locDays } = ctx;
  const { scores, rows, byLoc } = computeRanking(rel, state.providers);
  const tmaxStats = all ? null : computeStats(computePairs(ctx.data, "tmax", $("f-period").value, $("f-common").checked, state.providers).pairs, "error", state.providers);
  const countFor = (p) => all
    ? Object.values(byLoc).filter((r) => r.some((x) => x.p.id === p.id)).length
    : Math.max(0, ...LEADS.map((k) => tmaxStats[p.id][k].n));

  const ranked = rows.filter((r) => r.total != null);
  const maxAbs = Math.max(1, ...ranked.map((r) => Math.abs(r.total)));
  const periodText = $("f-period").selectedOptions[0].textContent;
  $("ranking-sub").textContent = `Zeitraum: ${periodText}${$("f-common").checked ? ", nur Tage mit Daten aller Anbieter" : ""}. Gewertet werden alle fünf Messgrößen über alle Vorlaufzeiten, die ein Anbieter rechnet.` +
    (all ? ` Das Ranking wird für jeden der ${Object.keys(rel).length} Orte einzeln berechnet und dann gemittelt, jeder Ort zählt gleich viel.` : "");
  const w = ranked[0];
  $("ranking-winner").innerHTML = w
    ? `🏆 Zuverlässigste Quelle: <strong>${esc(w.p.name)}</strong>. Sie liegt im Schnitt ${fmt(Math.abs(w.total), 0)} % ${w.total >= 0 ? "genauer" : "ungenauer"} als der Durchschnitt aller Anbieter.`
    : "Noch zu wenig Daten für ein Ranking.";

  const medal = ["🥇", "🥈", "🥉"];
  let html = `<thead><tr><th>Platz</th><th>Anbieter</th><th>Gesamt</th>${METRIC_KEYS.map((k) => `<th class="${k === metric ? "sel" : ""}">${METRICS[k].label}</th>`).join("")}<th>Reichweite</th><th>${all ? "Orte" : "Tage"}</th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const has = r.total != null;
    const bar = has
      ? `<div class="divbar"><span>${pct(r.total)}</span><span class="track"><span class="fill ${r.total >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(r.total) / maxAbs) * 50}%"></span></span></div>`
      : `<span class="muted">zu wenig Daten</span>`;
    html += `<tr class="${i === 0 && has ? "top" : ""}">
      <td class="place">${has ? medal[i] || `${i + 1}.` : "–"}</td>
      <td class="name"><span class="swatch" style="background:${color(r.p)}"></span>${esc(r.p.name)}<small>${esc(r.p.org)}</small></td>
      <td class="total">${bar}</td>
      ${METRIC_KEYS.map((k) => `<td class="${k === metric ? "sel" : ""} ${scores[k][r.p.id] == null ? "muted" : ""}">${pct(scores[k][r.p.id])}</td>`).join("")}
      <td>${r.p.maxLead} Tage</td>
      <td>${countFor(r.p).toLocaleString("de-DE")}</td>
    </tr>`;
  });
  $("ranking").innerHTML = html + "</tbody>";
  $("ranking-card").hidden = false;
  renderCityWinners(all, byLoc, locDays);
}

function renderCityWinners(all, byLoc, locDays) {
  $("city-card").hidden = !all;
  if (!all) return;
  const locs = state.locations.filter((l) => byLoc[l.id]).sort((a, b) => a.region.localeCompare(b.region, "de") || a.name.localeCompare(b.name, "de"));
  const wins = {};
  for (const l of locs) if (byLoc[l.id][0]) wins[byLoc[l.id][0].p.id] = (wins[byLoc[l.id][0].p.id] || 0) + 1;
  const rated = locs.filter((l) => byLoc[l.id].length).length;
  $("city-sub").textContent = Object.keys(wins).length
    ? `Platz 1 geht an: ${Object.entries(wins).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${providerById(id).name} (${n}×)`).join(", ")}, bei ${rated} bewerteten Orten.`
    : "Noch zu wenig Daten.";

  const place = (r) => (r ? `<span class="swatch" style="background:${color(r.p)}"></span>${esc(r.p.name)} <span class="muted">${pct(r.total)}</span>` : `<span class="muted">–</span>`);
  let html = `<thead><tr><th>Ort</th><th>Station</th><th>🥇 Platz 1</th><th>🥈 Platz 2</th><th>🥉 Platz 3</th><th>Tage</th></tr></thead><tbody>`;
  for (const l of locs) {
    const r = byLoc[l.id];
    html += `<tr><td class="name"><a href="?ort=${l.id}">${esc(l.name)}</a><small>${esc(l.region)}${l.capital ? " · Landeshauptstadt" : ""}</small></td>
      <td class="left muted">${esc(l.stationName)}</td>
      <td class="left">${place(r[0])}</td><td class="left">${place(r[1])}</td><td class="left">${place(r[2])}</td>
      <td>${(locDays[l.id] || 0).toLocaleString("de-DE")}</td></tr>`;
  }
  $("cities").innerHTML = html + "</tbody>";
}

// ---------- Diagramme ----------

function chartTheme() {
  return { text: cssVar("--muted"), grid: cssVar("--grid"), tooltipBg: cssVar("--card"), tooltipText: cssVar("--text"), border: cssVar("--border") };
}

function baseOptions(yTitle, t) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { color: t.text }, grid: { display: false }, border: { color: t.border } },
      y: { title: { display: true, text: yTitle, color: t.text }, ticks: { color: t.text }, grid: { color: t.grid }, border: { display: false } },
    },
    plugins: {
      legend: { position: "bottom", labels: { color: t.tooltipText, usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, padding: 16 } },
      tooltip: {
        backgroundColor: t.tooltipBg, titleColor: t.tooltipText, bodyColor: t.tooltipText, borderColor: t.border, borderWidth: 1,
        padding: 10, usePointStyle: true, boxWidth: 8, boxHeight: 8,
        itemSort: (a, b) => (a.raw ?? Infinity) - (b.raw ?? Infinity),
      },
    },
  };
}

function lineDataset(p, data, extra = {}) {
  const c = color(p);
  return { label: p.name, data, borderColor: c, backgroundColor: c, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: cssVar("--card"), pointBorderWidth: 2, tension: 0.2, spanGaps: false, ...extra };
}

function drawChart(key, canvasId, config) {
  state.charts[key]?.destroy();
  state.charts[key] = new Chart($(canvasId), config);
}

function renderLeadChart({ m, stats }) {
  const isHit = m.kind === "hit";
  $("lead-title").textContent = isHit ? "Trefferquote „Regen ja/nein“ nach Vorlaufzeit" : `Abweichung der ${m.label} nach Vorlaufzeit`;
  $("lead-sub").textContent = isHit
    ? `Anteil der Tage, an denen richtig vorhergesagt wurde, ob mindestens ${RAIN_MM} mm Regen fällt. Höher ist besser.`
    : `Mittlere absolute Abweichung zwischen Vorhersage und Messung in ${m.unit}. Niedriger ist besser.`;
  const datasets = state.providers.map((p) => lineDataset(p, LEADS.map((k) => (stats[p.id][k].n >= MIN_N ? +stats[p.id][k].value.toFixed(2) : null)), { n: LEADS.map((k) => stats[p.id][k].n) }));
  const options = baseOptions(isHit ? "Trefferquote in %" : `Ø Abweichung in ${m.unit}`, chartTheme());
  options.plugins.tooltip.callbacks = {
    title: (items) => `Vorhersage ${leadLabel(items[0].dataIndex + 1)} im Voraus`,
    label: (item) => ` ${item.dataset.label}: ${fmt(item.raw, m.digits)} ${m.unit}  (${item.dataset.n[item.dataIndex].toLocaleString("de-DE")} Tage)`,
  };
  if (isHit) options.scales.y.suggestedMax = 100;
  else options.scales.y.beginAtZero = true;
  $("lead-chart").setAttribute("aria-label", $("lead-title").textContent);
  drawChart("lead", "lead-chart", { type: "line", data: { labels: LEADS.map(leadLabel), datasets }, options });
  $("lead-card").hidden = false;
}

function renderMatrix({ m, stats }) {
  const isHit = m.kind === "hit";
  $("table-title").textContent = "Alle Werte im Überblick";
  $("table-sub").textContent = `${isHit ? "Trefferquote in %" : `Ø Abweichung in ${m.unit}`} je Anbieter und Vorlaufzeit, darunter die Zahl der ausgewerteten Tage. Umrandet ist der beste Wert pro Spalte. Dunkler heißt unzuverlässiger.`;

  const vals = state.providers.flatMap((p) => LEADS.map((k) => stats[p.id][k])).filter((s) => s.n >= MIN_N).map((s) => badness(s, m.kind));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const step = (b) => (hi === lo ? 3 : Math.min(6, Math.floor(((b - lo) / (hi - lo)) * 7)));
  const best = Object.fromEntries(LEADS.map((k) => [k, bestAt(stats, k, m.kind)?.p.id]));
  const light = !isDark();
  const nFmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("de-DE"));

  let html = `<thead><tr><th class="row">Anbieter</th>${LEADS.map((k) => `<th>${leadLabel(k)}</th>`).join("")}</tr></thead><tbody>`;
  for (const p of state.providers) {
    html += `<tr><th class="row" title="${esc(p.org)}"><span class="swatch" style="background:${color(p)}"></span>${esc(p.name)}</th>`;
    for (const k of LEADS) {
      const s = stats[p.id][k];
      if (k > p.maxLead) { html += `<td class="empty" title="${esc(p.name)} rechnet nicht so weit">·</td>`; continue; }
      if (s.n < MIN_N) { html += `<td class="empty" title="Noch zu wenig Daten">–<span class="n">${s.n} T.</span></td>`; continue; }
      const st = step(badness(s, m.kind));
      const bias = s.bias != null ? ` · Tendenz ${s.bias > 0 ? "zu hoch" : "zu niedrig"} um Ø ${fmt(Math.abs(s.bias), m.digits)} ${m.unit}` : "";
      const cls = [best[k] === p.id ? "best" : "", light && st >= 4 ? "dark-cell" : ""].join(" ");
      html += `<td class="${cls}" style="background:var(--heat-${st})" title="${esc(p.name)}, ${leadLabel(k)}: ${fmt(s.value, m.digits)} ${m.unit}${bias} (${s.n} Tage)">${fmt(s.value, m.digits)}<span class="n">${nFmt(s.n)} T.</span></td>`;
    }
    html += `</tr>`;
  }
  $("matrix").innerHTML = html + `</tbody>`;
  const legend = `<div class="legend-scale">zuverlässiger ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<span class="box" style="background:var(--heat-${i})"></span>`).join("")} unzuverlässiger</div>`;
  const wrap = $("matrix").parentElement;
  if (wrap.nextElementSibling?.classList.contains("legend-scale")) wrap.nextElementSibling.remove();
  wrap.insertAdjacentHTML("afterend", legend);
  $("table-card").hidden = false;
}

function renderTrend({ m, trend }) {
  const lead = Number($("f-trend-lead").value);
  const isHit = m.kind === "hit";
  $("trend-title").textContent = "Verlauf nach Monaten";
  $("trend-sub").textContent = `${isHit ? "Trefferquote" : "Ø Abweichung"} pro Monat für Vorhersagen ${leadLabel(lead)} im Voraus. Monate mit weniger als ${MIN_N_MONTH} Tagen werden ausgelassen.`;
  const { months, values, counts } = trend(lead);
  const datasets = state.providers
    .filter((p) => p.maxLead >= lead)
    .map((p) => lineDataset(p, (values[p.id] || months.map(() => null)).map((v) => (v == null ? null : +v.toFixed(2))), { n: counts?.[p.id], pointRadius: months.length > 24 ? 2 : 4 }));
  const labels = months.map((mo) => new Date(mo + "-15").toLocaleDateString("de-DE", { month: "short", year: "2-digit" }));
  const options = baseOptions(isHit ? "Trefferquote in %" : `Ø Abweichung in ${m.unit}`, chartTheme());
  options.plugins.tooltip.callbacks = {
    title: (items) => new Date(months[items[0].dataIndex] + "-15").toLocaleDateString("de-DE", { month: "long", year: "numeric" }),
    label: (item) => ` ${item.dataset.label}: ${fmt(item.raw, m.digits)} ${m.unit}${item.dataset.n ? `  (${item.dataset.n[item.dataIndex]} Tage)` : ""}`,
  };
  if (!isHit) options.scales.y.beginAtZero = true;
  $("trend-chart").setAttribute("aria-label", `${$("trend-title").textContent}, ${leadLabel(lead)} im Voraus`);
  drawChart("trend", "trend-chart", { type: "line", data: { labels, datasets }, options });
  $("trend-card").hidden = false;
}

function renderLatest({ m, data, meta, all }) {
  // Einzelvergleich nur für einen Ort sinnvoll
  if (all || !meta.lastObs) { $("latest-card").hidden = true; return; }
  const lastObs = meta.lastObs;
  const o = data.obs.get(lastObs);
  const field = m.field;
  const unit = field === "precip" ? "mm" : m.unit;
  const fcs = new Map(data.fc.filter((r) => r.target === lastObs).map((r) => [`${r.provider}|${r.lead}`, r[field]]));
  const label = field === "precip" ? "Niederschlag" : m.label;
  $("latest-title").textContent = `Letzter gemessener Tag: ${fmtDate(lastObs, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
  $("latest-sub").textContent = `${label}: gemessen ${fmt(o?.[field], 1)} ${unit}. Darunter: Was die Anbieter 1 bis 7 Tage vorher für diesen Tag vorhergesagt haben.`;

  let html = `<thead><tr><th class="row">Anbieter</th>${LEADS.map((k) => `<th>${leadLabel(k)} vorher</th>`).join("")}</tr></thead><tbody>`;
  html += `<tr class="obs"><th class="row">Gemessen</th><td colspan="7">${fmt(o?.[field], 1)} ${unit}</td></tr>`;
  for (const p of state.providers) {
    html += `<tr><th class="row"><span class="swatch" style="background:${color(p)}"></span>${esc(p.name)}</th>`;
    for (const k of LEADS) {
      const f = fcs.get(`${p.id}|${k}`);
      if (f == null) { html += `<td class="empty">–</td>`; continue; }
      const d = o?.[field] != null ? f - o[field] : null;
      const diff = d == null ? "" : `<span class="diff">${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmt(Math.abs(d), 1)}</span>`;
      html += `<td>${fmt(f, 1)}${diff}</td>`;
    }
    html += `</tr>`;
  }
  $("latest").innerHTML = html + `</tbody>`;
  $("latest-card").hidden = false;
}

init();
