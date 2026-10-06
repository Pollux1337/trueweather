// Regen-Check – Webseite. Daten kommen vorberechnet aus data/ (siehe collector/build-site.mjs).

import { CELLS, FIELDS, VIEWS, SLOT_LEADS, DAY_LEADS, metrics, addInto, emptyCounts } from "./lib/rain.js?v=__VERSION__";

const GEO_URL = "https://cdn.jsdelivr.net/gh/isellsoap/deutschlandGeoJSON@main/2_bundeslaender/3_mittel.geo.json";
const SMOOTH_KM = 25;
const MIN_EVENTS = 15;     // mindestens so viele Regen-Ereignisse (Treffer + Fehlalarme + verpasst) je Fläche
const MIN_CASES = 60;      // mindestens so viele Vergleichsfälle für eine Mengen-Aussage
const BUILDING = 0.2;      // weniger als 20 % der Fälle des stärksten Dienstes → „im Aufbau“
const NF = FIELDS.length, NC = CELLS.length;
const CITIES = [
  ["Berlin", 52.52, 13.405], ["Hamburg", 53.551, 9.994], ["München", 48.137, 11.575], ["Köln", 50.938, 6.96],
  ["Frankfurt", 50.11, 8.682], ["Stuttgart", 48.776, 9.183], ["Leipzig", 51.34, 12.375], ["Dresden", 51.05, 13.737],
  ["Hannover", 52.376, 9.732], ["Nürnberg", 49.452, 11.077], ["Bremen", 53.079, 8.802], ["Kiel", 54.323, 10.123],
  ["Rostock", 54.092, 12.099], ["Erfurt", 50.985, 11.03], ["Magdeburg", 52.12, 11.628], ["Saarbrücken", 49.24, 6.997],
  ["Freiburg", 47.999, 7.842], ["Münster", 51.962, 7.626], ["Kassel", 51.312, 9.48], ["Regensburg", 49.013, 12.102],
];

const $ = (id) => document.getElementById(id);
const state = {
  meta: null, views: {}, national: null, geo: null, chart: null,
  sel: { mode: "reliability", provider: "avg", res: "h", lead: 1, metric: "yn", view: "m12", smooth: true },
  selected: null, map: null, neighbors: null,
};

// ---------- Hilfsfunktionen ----------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => true; // Anthrazit-Design ist immer dunkel
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v) => (v == null ? "–" : `${fmt(v)} %`);
const signed = (v) => {
  if (v == null) return "–";
  const r = Math.round(v);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)} %`;
};
const color = (pi) => css(`--series-${pi + 1}`);
const cellOf = () => CELLS.indexOf(`${state.sel.res}${state.sel.lead}`);
const leadName = (k) => ["", "morgen", "übermorgen", "in 3 Tagen", "in 4 Tagen", "in 5 Tagen", "in 6 Tagen", "in 7 Tagen"][k];
const resName = () => (state.sel.res === "h" ? "2-Stunden-Abschnitte" : "ganze Tage");
const unitName = () => (state.sel.res === "h" ? "mm je 2 Std." : "mm je Tag");

function km(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Zähler einer Station für Anbieter pi (oder alle zusammen) in Zelle ci
function counts(flat, pi, ci) {
  if (!flat) return null;
  if (pi === "avg") {
    const sum = emptyCounts();
    state.meta.providers.forEach((_, p) => addInto(sum, counts(flat, p, ci)));
    return sum;
  }
  const o = (pi * NC + ci) * NF;
  return flat.slice(o, o + NF);
}

// Zähler mehrerer Stationen addieren
function pooled(ids, data, pi, ci) {
  const sum = emptyCounts();
  for (const id of ids) { const c = counts(data[id], pi, ci); if (c) addInto(sum, c); }
  return sum;
}

const providerIndex = () => (state.sel.provider === "avg" ? "avg" : state.meta.providers.findIndex((p) => p.id === state.sel.provider));

// Für die Karte: Zuverlässigkeit (Treffsicherheit bzw. Ø Abweichung) und Rangfolge der Dienste
function valueOf(m) {
  if (!m) return null;
  if (state.sel.metric === "yn") return m.a + m.b + m.c >= MIN_EVENTS ? m.csi : null;
  return m.n >= MIN_CASES ? m.mae : null;
}
function relOf(m) {
  if (!m) return null;
  return state.sel.metric === "yn" ? (m.a + m.b + m.c >= MIN_EVENTS ? m.relYN : null) : (m.n >= MIN_CASES ? m.relA : null);
}
function withCounts(c) {
  const m = metrics(c);
  if (!m) return null;
  return { ...m, a: c[0], b: c[1], c: c[2] };
}
function rankingFor(ids, data, ci) {
  return state.meta.providers
    .map((p, pi) => ({ p, pi, m: withCounts(pooled(ids, data, pi, ci)) }))
    .map((r) => ({ ...r, rel: relOf(r.m) }))
    .filter((r) => r.rel != null)
    .sort((a, b) => b.rel - a.rel);
}

// ---------- Laden ----------

async function init() {
  try {
    state.meta = await getJson("data/meta.json");
  } catch (err) {
    console.error(err);
    $("status-chip").textContent = "Daten konnten nicht geladen werden";
    return;
  }
  const { meta } = state;
  document.querySelectorAll("#station-count, .station-count").forEach((el) => (el.textContent = meta.stations.length.toLocaleString("de-DE")));
  $("c-provider").innerHTML = `<option value="avg">Alle Dienste (Durchschnitt)</option>` +
    meta.providers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("c-view").innerHTML = Object.entries(VIEWS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  $("c-view").value = state.sel.view;

  // Nachbarn für die Glättung
  state.neighbors = Object.fromEntries(meta.stations.map((s) => [s.id, meta.stations.filter((t) => km(s, t) <= SMOOTH_KM).map((t) => t.id)]));

  bindControls();
  renderStatus();
  fillLeads();
  await update();
}

function bindControls() {
  for (const [id, key] of [["c-mode", "mode"], ["c-res", "res"], ["c-metric", "metric"]]) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.sel[key] = b.dataset.v;
      $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      if (key === "res") fillLeads();
      update();
    });
  }
  $("c-provider").addEventListener("change", (e) => { state.sel.provider = e.target.value; update(); });
  $("c-lead").addEventListener("change", (e) => { state.sel.lead = Number(e.target.value); update(); });
  $("c-view").addEventListener("change", (e) => { state.sel.view = e.target.value; update(); });
  $("c-smooth").addEventListener("change", (e) => { state.sel.smooth = e.target.checked; update(); });
}

function fillLeads() {
  const leads = state.sel.res === "h" ? SLOT_LEADS : DAY_LEADS;
  if (!leads.includes(state.sel.lead)) state.sel.lead = 1;
  $("c-lead").innerHTML = leads.map((k) => `<option value="${k}">${k === 1 ? "Morgen" : k === 2 ? "Übermorgen" : `In ${k} Tagen`}</option>`).join("");
  $("c-lead").value = String(state.sel.lead);
}

async function loadView(key) {
  if (!state.views[key]) state.views[key] = await getJson(`data/v-${key}.json`);
  return state.views[key];
}

function renderStatus() {
  const { meta } = state;
  const st = meta.status || {};
  const to = st.window?.to ? new Date(st.window.to + "T12:00").toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" }) : "–";
  $("status-chip").textContent = `${meta.stations.length} Stationen · ausgewertet bis ${to}`;
  const notes = [];
  if (st.archive != null && st.archive < 100) notes.push(`Die Daten werden noch eingelesen: ${st.archive} % der letzten 24 Monate sind fertig, jüngste Monate zuerst. Die Karte wird mit jedem Lauf vollständiger.`);
  const errs = st.collectErrors?.length || 0;
  if (errs > 20) notes.push(`Beim letzten Sammeln gab es ${errs} Fehler.`);
  $("notice").hidden = !notes.length;
  $("notice").textContent = notes.join(" ");
}

// ---------- Aktualisieren ----------

async function update() {
  const { sel } = state;
  $("c-provider-wrap").hidden = sel.mode !== "reliability";
  let data;
  try { data = await loadView(sel.view); } catch (err) {
    console.error(err);
    return;
  }
  const ci = cellOf();
  const ctx = { data, ci, ids: Object.keys(data) };
  await renderMap(ctx);
  renderKpis(ctx);
  renderStation(ctx);
  renderRanking(ctx);
  renderLeadChart(ctx);
  renderSeasons(ctx);
  renderStates(ctx);
}

// ---------- Karte ----------

async function setupMap() {
  if (state.map) return state.map;
  state.geo ??= await getJson(GEO_URL);
  const W = 620, H = 820;
  const projection = d3.geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], state.geo);
  const path = d3.geoPath(projection);
  const stations = state.meta.stations;
  const pts = stations.map((s) => projection([s.lon, s.lat]));
  const voronoi = d3.Delaunay.from(pts).voronoi([0, 0, W, H]);
  const outline = path(state.geo);

  const svg = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Deutschlandkarte">`,
    `<defs><clipPath id="de"><path d="${outline}"/></clipPath>` +
    `<pattern id="nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${css("--nodata")}"/><line x1="0" y1="0" x2="0" y2="6" stroke="${css("--faint")}" stroke-opacity="0.35" stroke-width="1.4"/></pattern></defs><g clip-path="url(#de)">`];
  stations.forEach((s, i) => svg.push(`<path class="cell" data-i="${i}" d="${voronoi.renderCell(i)}"/>`));
  svg.push(`</g><path class="states" d="${outline}"/>`);
  for (const [name, lat, lon] of CITIES) {
    const [x, y] = projection([lon, lat]);
    svg.push(`<circle class="city" cx="${x}" cy="${y}" r="2.6"/><text class="city-label" x="${x + 5}" y="${y + 4}">${name}</text>`);
  }
  svg.push(`</svg>`);
  $("map").innerHTML = svg.join("");

  const cells = [...$("map").querySelectorAll(".cell")];
  const tip = $("tip");
  for (const cell of cells) {
    cell.addEventListener("mousemove", (e) => showTip(e, stations[Number(cell.dataset.i)]));
    cell.addEventListener("mouseleave", () => { tip.hidden = true; });
    cell.addEventListener("click", () => {
      state.selected = stations[Number(cell.dataset.i)].id;
      cells.forEach((c) => c.classList.toggle("selected", c === cell));
      renderStation(state.lastCtx);
      if (matchMedia("(max-width: 960px)").matches) $("station-card").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  state.map = { cells, stations };
  return state.map;
}

// Daten einer Fläche: Station allein oder mit Nachbarn im Umkreis
const areaIds = (id) => (state.sel.smooth ? state.neighbors[id] : [id]);

function seqScale(values, higherIsBetter) {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const lo = q(0.03), hi = q(0.97);
  const steps = 7;
  const colors = Array.from({ length: steps }, (_, i) => css(`--seq-${i}`));
  const scale = d3.scaleQuantize().domain([lo, hi]).range(higherIsBetter ? colors : [...colors].reverse());
  return { scale, lo, hi, colors };
}

async function renderMap(ctx) {
  const { data, ci } = ctx;
  state.lastCtx = ctx;
  let map;
  try { map = await setupMap(); } catch {
    $("map").innerHTML = `<p class="muted">Die Kartengrundlage konnte nicht geladen werden.</p>`;
    return;
  }
  const { sel } = state;
  const yn = sel.metric === "yn";
  const lead = leadName(sel.lead);
  const noData = "url(#nodata)"; // schraffiert, damit „keine Daten“ nicht mit „wenig zuverlässig“ verwechselt wird
  const area = {}; // Station → { value } bzw. { ranking }

  if (sel.mode === "reliability") {
    const pi = providerIndex();
    for (const s of map.stations) area[s.id] = { value: valueOf(withCounts(pooled(areaIds(s.id), data, pi, ci))) };
    const sc = seqScale(Object.values(area).map((a) => a.value), yn);
    map.cells.forEach((c, i) => {
      const v = area[map.stations[i].id].value;
      c.style.fill = v == null || !sc ? noData : sc.scale(v);
    });
    const who = sel.provider === "avg" ? "aller Wetterdienste" : `von ${state.meta.providers[pi].name}`;
    $("map-title").textContent = yn ? "Wie zuverlässig wird Regen vorhergesagt?" : "Wie genau wird die Regenmenge vorhergesagt?";
    $("map-sub").textContent = yn
      ? `Treffsicherheit ${who} für ${resName()}, Vorhersage für ${lead}. ${isDark() ? "Heller" : "Dunkler"} = zuverlässiger.`
      : `Mittlere Abweichung der Regenmenge ${who} (${unitName()}), Vorhersage für ${lead}. ${isDark() ? "Heller" : "Dunkler"} = genauer.`;
    renderSeqLegend(sc, yn);
  } else {
    for (const s of map.stations) area[s.id] = { ranking: rankingFor(areaIds(s.id), data, ci) };
    map.cells.forEach((c, i) => {
      const r = area[map.stations[i].id].ranking;
      c.style.fill = r.length ? color(r[0].pi) : noData;
    });
    $("map-title").textContent = "Welcher Wetterdienst ist wo am zuverlässigsten?";
    $("map-sub").textContent = `Bester Dienst bei ${yn ? "Regen ja/nein" : "der Regenmenge"} für ${resName()}, Vorhersage für ${lead}, im fairen Paarvergleich. ${sel.smooth ? `Jede Fläche fasst die Stationen im Umkreis von ${SMOOTH_KM} km zusammen.` : ""}`;
    renderWinnerLegend(area);
  }
  ctx.area = area;
  map.cells.forEach((c, i) => c.classList.toggle("selected", map.stations[i].id === state.selected));
}

function renderSeqLegend(sc, yn) {
  if (!sc) { $("legend").innerHTML = `<span class="note">Noch zu wenig Daten für diese Auswahl.</span>`; return; }
  const ticks = [sc.lo, (sc.lo + sc.hi) / 2, sc.hi].map((v) => (yn ? `${fmt(v)} %` : `${fmt(v, 2)} mm`));
  const colors = sc.colors;
  $("legend").innerHTML = `
    <div><div class="scale">${(yn ? colors : [...colors].reverse()).map((c) => `<span style="background:${c}"></span>`).join("")}</div>
    <div class="ticks"><span>${ticks[0]}</span><span>${ticks[1]}</span><span>${ticks[2]}</span></div></div>
    <span class="note">${yn ? "Treffsicherheit: höher = zuverlässiger" : "Ø Abweichung: kleiner = genauer"}</span>
    <span class="item"><span class="swatch square nodata"></span>zu wenig Regen für eine Aussage</span>`;
}

function renderWinnerLegend(area) {
  const wins = {};
  let none = 0;
  for (const a of Object.values(area)) { if (a.ranking.length) wins[a.ranking[0].pi] = (wins[a.ranking[0].pi] || 0) + 1; else none++; }
  $("legend").innerHTML = state.meta.providers
    .map((p, pi) => ({ p, pi, n: wins[pi] || 0 }))
    .sort((a, b) => b.n - a.n)
    .map(({ p, pi, n }) => `<span class="item${n ? "" : " zero"}"><span class="swatch" style="background:${color(pi)}"></span>${esc(p.name)} <strong>${n}</strong></span>`)
    .join("") + (none ? `<span class="item"><span class="swatch square nodata"></span>zu wenig Daten <strong>${none}</strong></span>` : "") +
    `<span class="note">Zahl = Flächen mit Platz 1</span>`;
}

function showTip(e, s) {
  const ctx = state.lastCtx;
  if (!ctx?.area) return;
  const a = ctx.area[s.id];
  const yn = state.sel.metric === "yn";
  let body;
  if (state.sel.mode === "reliability") {
    body = a.value == null ? `<div class="muted">Noch zu wenig Regen für eine Aussage.</div>`
      : `<div class="row"><span>${yn ? "Treffsicherheit" : "Ø Abweichung"}</span><strong>${yn ? pct(a.value) : `${fmt(a.value, 2)} mm`}</strong></div>`;
  } else {
    body = a.ranking.length
      ? a.ranking.slice(0, 3).map((r, i) => `<div class="row"><span><span class="swatch" style="background:${color(r.pi)}"></span> ${i + 1}. ${esc(r.p.name)}</span><span>${signed(r.rel)}</span></div>`).join("")
      : `<div class="muted">Noch zu wenig Daten.</div>`;
  }
  const tip = $("tip");
  tip.innerHTML = `<strong>${esc(s.name)}</strong><div class="muted">${esc(s.region)} · ${s.height} m${state.sel.smooth ? ` · mit ${state.neighbors[s.id].length - 1} Nachbarn` : ""}</div>${body}`;
  const box = $("map").getBoundingClientRect();
  const x = e.clientX - box.left, y = e.clientY - box.top;
  tip.style.left = `${Math.min(x + 14, box.width - 250)}px`;
  tip.style.top = `${Math.min(y + 14, box.height - 120)}px`;
  tip.hidden = false;
}

// ---------- Kennzahlen ----------

function renderKpis({ data, ci, ids }) {
  const { sel } = state;
  const pi = sel.mode === "reliability" ? providerIndex() : "avg";
  const m = withCounts(pooled(ids, data, pi, ci));
  const who = pi === "avg" ? "Alle Wetterdienste" : state.meta.providers[pi].name;
  $("kpi-title").textContent = "Deutschland gesamt";
  $("kpi-sub").textContent = `${who} · ${resName()} · Vorhersage für ${leadName(sel.lead)} · ${VIEWS[sel.view].label}`;
  const tile = (label, value, hint) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
  $("kpis").innerHTML = m ? [
    tile("Treffsicherheit", pct(m.csi), "wenn Regen angesagt war oder fiel"),
    tile("Regen erkannt", pct(m.pod), "der Regenfälle vorhergesagt"),
    tile("Fehlalarme", pct(m.far), "der Regenvorhersagen blieben trocken"),
    tile("Ø Abweichung", `${fmt(m.mae, 2)} mm`, unitName()),
  ].join("") : `<p class="muted">Noch keine Daten.</p>`;
}

// ---------- Station ----------

function renderStation(ctx) {
  if (!ctx) return;
  const s = state.meta.stations.find((x) => x.id === state.selected);
  if (!s) { $("station-table").innerHTML = ""; return; }
  const flat = ctx.data[s.id];
  $("station-title").textContent = s.name;
  $("station-sub").textContent = `${s.region} · ${s.height} m · DWD-Station ${s.id} · nur diese Station, ungeglättet`;
  if (!flat) { $("station-table").innerHTML = `<tr><td class="l muted">Für diese Station liegen noch keine Daten vor.</td></tr>`; return; }
  const rows = state.meta.providers.map((p, pi) => {
    const m = withCounts(counts(flat, pi, ctx.ci));
    return { p, pi, m, rel: relOf(m) };
  }).filter((r) => r.m).sort((a, b) => (b.rel ?? -999) - (a.rel ?? -999));
  $("station-table").innerHTML = `<thead><tr><th class="l">Dienst</th><th>Vergleich</th><th>Treffsicherh.</th><th>Erkannt</th><th>Fehlalarme</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="l"><span class="swatch" style="background:${color(r.pi)}"></span> ${esc(r.p.name)}</td><td>${signed(r.rel)}</td><td>${pct(r.m.csi)}</td><td>${pct(r.m.pod)}</td><td>${pct(r.m.far)}</td></tr>`).join("") + `</tbody>`;
}

// ---------- Ranking ----------

function renderRanking({ data, ci, ids }) {
  const { sel } = state;
  const yn = sel.metric === "yn";
  const all = state.meta.providers.map((p, pi) => ({ p, pi, m: withCounts(pooled(ids, data, pi, ci)) }));
  const maxN = Math.max(0, ...all.map((r) => r.m?.n || 0));
  all.forEach((r) => { r.rel = relOf(r.m); r.building = r.m && r.m.n < BUILDING * maxN; });
  const rows = all.sort((a, b) => (b.rel ?? -999) - (a.rel ?? -999));
  const ranked = rows.filter((r) => r.rel != null);
  const top = ranked[0], topSolid = ranked.find((r) => !r.building);
  $("ranking-sub").textContent = `${yn ? "Regen ja/nein" : "Regenmenge"} · ${resName()} · Vorhersage für ${leadName(sel.lead)} · ${VIEWS[sel.view].label} · alle Stationen zusammen`;
  $("ranking-winner").innerHTML = !top ? "Noch zu wenig Daten für ein Ranking."
    : `🏆 <strong>${esc(top.p.name)}</strong> macht ${signed(top.rel).replace("+", "")} weniger Fehler als der Durchschnitt aller Dienste.` +
      (top.building && topSolid ? ` <span class="muted">Noch im Aufbau, wenige Vergleichsfälle. Bester mit voller Datenbasis: <strong>${esc(topSolid.p.name)}</strong> (${signed(topSolid.rel)}).</span>` : "");
  const maxAbs = Math.max(1, ...ranked.map((r) => Math.abs(r.rel)));
  const medal = ["🥇", "🥈", "🥉"];
  $("ranking").innerHTML = `<thead><tr><th class="l">Platz</th><th class="l">Dienst</th><th>Vergleich zum Durchschnitt</th><th>Treffsicherheit</th><th>Regen erkannt</th><th>Fehlalarme</th><th>Ø Abweichung</th><th>Fälle</th></tr></thead><tbody>` +
    rows.map((r, i) => {
      const has = r.rel != null;
      const bar = has ? `<span class="bar"><span>${signed(r.rel)}</span><span class="track"><span class="fill ${r.rel >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(r.rel) / maxAbs) * 50}%"></span></span></span>` : `<span class="muted">${r.m ? "zu wenig Daten" : "keine Vorhersage"}</span>`;
      return `<tr class="${i === 0 && has ? "top" : ""}">
        <td class="place">${has ? medal[i] || `${i + 1}.` : "–"}</td>
        <td class="name l"><span class="swatch" style="background:${color(r.pi)}"></span> ${esc(r.p.name)}${r.building ? `<span class="badge">im Aufbau</span>` : ""}<small>${esc(r.p.org)}</small></td>
        <td>${bar}</td>
        <td>${pct(r.m?.csi)}</td><td>${pct(r.m?.pod)}</td><td>${pct(r.m?.far)}</td>
        <td>${r.m ? `${fmt(r.m.mae, 2)} mm` : "–"}</td>
        <td>${r.m ? r.m.n.toLocaleString("de-DE") : "–"}</td></tr>`;
    }).join("") + `</tbody>`;
}

// ---------- Vorlauf-Diagramm ----------

function renderLeadChart({ data, ids }) {
  const { sel } = state;
  const yn = sel.metric === "yn";
  const leads = sel.res === "h" ? SLOT_LEADS : DAY_LEADS;
  $("lead-sub").textContent = `${yn ? "Treffsicherheit (höher = besser)" : `Ø Abweichung in ${unitName()} (niedriger = besser)`} für ${resName()}, alle Stationen, ${VIEWS[sel.view].label}.`;
  const datasets = state.meta.providers.map((p, pi) => {
    const values = leads.map((k) => {
      const m = withCounts(pooled(ids, data, pi, CELLS.indexOf(`${sel.res}${k}`)));
      const v = yn ? (m && m.a + m.b + m.c >= MIN_EVENTS ? m.csi : null) : (m && m.n >= MIN_CASES ? m.mae : null);
      return v == null ? null : +v.toFixed(2);
    });
    const c = color(pi);
    return { label: p.name, data: values, borderColor: c, backgroundColor: c, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: css("--card"), pointBorderWidth: 2, tension: 0.25 };
  });
  const t = { text: css("--muted"), grid: css("--grid"), card: css("--card"), ink: css("--text"), border: css("--border") };
  state.chart?.destroy();
  state.chart = new Chart($("lead-chart"), {
    type: "line",
    data: { labels: leads.map((k) => (k === 1 ? "Morgen" : k === 2 ? "Übermorgen" : `${k} Tage`)), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: t.text }, grid: { display: false }, border: { color: t.border } },
        y: { beginAtZero: !yn, title: { display: true, text: yn ? "Treffsicherheit in %" : "Ø Abweichung in mm", color: t.text }, ticks: { color: t.text }, grid: { color: t.grid }, border: { display: false } },
      },
      plugins: {
        legend: { position: "bottom", labels: { color: t.ink, usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, padding: 14 } },
        tooltip: {
          backgroundColor: t.card, titleColor: t.ink, bodyColor: t.ink, borderColor: t.border, borderWidth: 1, padding: 10,
          usePointStyle: true, boxWidth: 8, boxHeight: 8,
          itemSort: (a, b) => (yn ? (b.raw ?? -1) - (a.raw ?? -1) : (a.raw ?? 1e9) - (b.raw ?? 1e9)),
          callbacks: { label: (i) => ` ${i.dataset.label}: ${yn ? pct(i.raw) : `${fmt(i.raw, 2)} mm`}` },
        },
      },
    },
  });
  $("lead-chart").setAttribute("aria-label", `Diagramm: ${$("lead-sub").textContent}`);
}

// ---------- Jahreszeiten ----------

async function renderSeasons({ ci }) {
  const { sel } = state;
  const yn = sel.metric === "yn";
  const seasons = ["winter", "spring", "summer", "autumn"];
  $("season-sub").textContent = `${yn ? "Treffsicherheit" : "Ø Abweichung"} je Jahreszeit · ${resName()} · Vorhersage für ${leadName(sel.lead)} · alle Stationen.`;
  const datas = await Promise.all(seasons.map((k) => loadView(k).catch(() => ({}))));
  const vals = state.meta.providers.map((p, pi) => seasons.map((_, si) => {
    const m = withCounts(pooled(Object.keys(datas[si]), datas[si], pi, ci));
    return yn ? (m && m.a + m.b + m.c >= MIN_EVENTS ? m.csi : null) : (m && m.n >= MIN_CASES ? m.mae : null);
  }));
  const best = seasons.map((_, si) => {
    const col = vals.map((v) => v[si]).filter((v) => v != null);
    return col.length ? (yn ? Math.max(...col) : Math.min(...col)) : null;
  });
  const short = { winter: "Winter", spring: "Frühling", summer: "Sommer", autumn: "Herbst" };
  $("seasons").innerHTML = `<thead><tr><th class="l">Dienst</th>${seasons.map((k) => `<th>${short[k]}</th>`).join("")}</tr></thead><tbody>` +
    state.meta.providers.map((p, pi) => `<tr><td class="l"><span class="swatch" style="background:${color(pi)}"></span> ${esc(p.name)}</td>${vals[pi].map((v, si) =>
      `<td class="${v != null && v === best[si] ? "best" : v == null ? "empty" : ""}">${yn ? pct(v) : v == null ? "–" : `${fmt(v, 2)} mm`}</td>`).join("")}</tr>`).join("") + `</tbody>`;
}

// ---------- Bundesländer ----------

function renderStates({ data, ci }) {
  const { sel } = state;
  const yn = sel.metric === "yn";
  const regions = new Map();
  for (const s of state.meta.stations) {
    if (!data[s.id]) continue;
    if (!regions.has(s.region)) regions.set(s.region, []);
    regions.get(s.region).push(s.id);
  }
  $("states-sub").textContent = `Bester Dienst je Bundesland im fairen Paarvergleich · ${yn ? "Regen ja/nein" : "Regenmenge"} · ${resName()} · Vorhersage für ${leadName(sel.lead)} · ${VIEWS[sel.view].label}.`;
  const cell = (r) => (r ? `<span class="swatch" style="background:${color(r.pi)}"></span> ${esc(r.p.name)} <span class="muted">${signed(r.rel)}</span>` : `<span class="muted">–</span>`);
  $("states").innerHTML = `<thead><tr><th class="l">Bundesland</th><th>Stationen</th><th class="l">🥇 Am zuverlässigsten</th><th class="l">🥈 Platz 2</th><th class="l">🥉 Platz 3</th><th>${yn ? "Treffsicherheit" : "Ø Abweichung"} (alle)</th></tr></thead><tbody>` +
    [...regions].sort(([a], [b]) => a.localeCompare(b, "de")).map(([region, ids]) => {
      const r = rankingFor(ids, data, ci);
      const avg = withCounts(pooled(ids, data, "avg", ci));
      return `<tr><td class="l name">${esc(region)}</td><td>${ids.length}</td><td class="l">${cell(r[0])}</td><td class="l">${cell(r[1])}</td><td class="l">${cell(r[2])}</td><td>${yn ? pct(avg?.csi) : avg ? `${fmt(avg.mae, 2)} mm` : "–"}</td></tr>`;
    }).join("") + `</tbody>`;
}

init();
