// Vorhersage-Check – vergleicht archivierte Vorhersagen mit DWD-Messwerten

const METRICS = {
  tmax:    { label: "Höchsttemperatur",    field: "tmax",   unit: "°C",   kind: "error", digits: 1 },
  tmin:    { label: "Tiefsttemperatur",    field: "tmin",   unit: "°C",   kind: "error", digits: 1 },
  rainhit: { label: "Regen ja/nein",       field: "precip", unit: "%",    kind: "hit",   digits: 0 },
  precip:  { label: "Niederschlagsmenge",  field: "precip", unit: "mm",   kind: "error", digits: 1 },
  wind:    { label: "Wind (Tagesmaximum)", field: "wind",   unit: "km/h", kind: "error", digits: 1 },
};
const RAIN_MM = 1;        // ab dieser Tagesmenge gilt ein Tag als Regentag
const MIN_N_CHART = 5;    // mindestens so viele Tage, damit ein Wert angezeigt wird
const MIN_N_MONTH = 10;   // Monatswerte im Verlauf
const LEADS = [1, 2, 3, 4, 5, 6, 7];

const $ = (id) => document.getElementById(id);
const state = { providers: [], locations: [], status: null, cache: {}, charts: {} };

// ---------- Hilfsfunktionen ----------

const fmt = (v, digits = 1) => (v == null ? "–" : v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const fmtDate = (d, opts = { day: "numeric", month: "long", year: "numeric" }) => new Date(d + "T12:00").toLocaleDateString("de-DE", opts);
const leadLabel = (k) => (k === 1 ? "1 Tag" : `${k} Tage`);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const color = (p) => cssVar(`--series-${state.providers.indexOf(p) + 1}`);

function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row = {};
    cols.forEach((c, i) => {
      const v = cells[i] ?? "";
      row[c] = c === "provider" || c === "target" || c === "date" ? v : v === "" ? null : Number(v);
    });
    return row;
  });
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
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
    state.status = await fetchText("data/status.json").then(JSON.parse).catch(() => null);

    $("f-location").innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}${l.region ? ` (${l.region})` : ""}</option>`).join("");
    const params = new URLSearchParams(location.search);
    if (params.get("ort") && locations.some((l) => l.id === params.get("ort"))) $("f-location").value = params.get("ort");

    for (const id of ["f-location", "f-metric", "f-period", "f-common", "f-trend-lead"]) $(id).addEventListener("change", update);
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
    const obs = new Map(parseCsv(obsText).map((r) => [r.date, r]));
    state.cache[id] = { obs, fc: parseCsv(fcText) };
  }
  return state.cache[id];
}

function showStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = !text;
}

// ---------- Auswertung ----------

function computePairs(data, metric, period, commonOnly) {
  const m = METRICS[metric];
  const dates = [...data.obs.keys()].sort();
  const lastObs = dates.at(-1);
  const from = period === "all" ? dates[0] : addDays(lastObs, -Number(period) + 1);

  let pairs = [];
  for (const r of data.fc) {
    if (r.target < from || r.target > lastObs) continue;
    const o = data.obs.get(r.target);
    if (!o || o[m.field] == null || r[m.field] == null) continue;
    pairs.push({ provider: r.provider, lead: r.lead, target: r.target, f: r[m.field], o: o[m.field] });
  }

  if (commonOnly) {
    // Pro Vorlaufzeit nur Tage behalten, an denen jeder Anbieter mit dieser Reichweite einen Wert hat
    const keep = new Set();
    for (const k of LEADS) {
      const eligible = state.providers.filter((p) => p.maxLead >= k).length;
      const count = new Map();
      for (const p of pairs) if (p.lead === k) count.set(p.target, (count.get(p.target) || 0) + 1);
      for (const [t, c] of count) if (c === eligible) keep.add(`${k}|${t}`);
    }
    pairs = pairs.filter((p) => keep.has(`${p.lead}|${p.target}`));
  }
  return { pairs, from, lastObs, firstObs: dates[0] };
}

function score(list, kind) {
  if (!list.length) return { n: 0, value: null, bias: null };
  if (kind === "hit") {
    const hits = list.filter((p) => (p.f >= RAIN_MM) === (p.o >= RAIN_MM)).length;
    return { n: list.length, value: (100 * hits) / list.length, bias: null };
  }
  let abs = 0, sum = 0;
  for (const p of list) { abs += Math.abs(p.f - p.o); sum += p.f - p.o; }
  return { n: list.length, value: abs / list.length, bias: sum / list.length };
}

// kleiner = besser, auch für die Trefferquote
const badness = (s, kind) => (s.value == null ? null : kind === "hit" ? 100 - s.value : s.value);

function computeStats(pairs, kind) {
  const groups = new Map();
  for (const p of pairs) {
    const key = `${p.provider}|${p.lead}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const stats = {};
  for (const prov of state.providers) {
    stats[prov.id] = {};
    for (const k of LEADS) stats[prov.id][k] = score(groups.get(`${prov.id}|${k}`) || [], kind);
  }
  return stats;
}

// Relative Güte je Anbieter: pro Vorlaufzeit mit dem Mittel aller Anbieter vergleichen, dann mitteln.
// +10 heißt: im Schnitt 10 % genauer als der Durchschnitt. Fair auch bei unterschiedlicher Reichweite.
function relativeScores(stats, kind) {
  const avgAt = {};
  for (const k of LEADS) {
    const vals = state.providers.map((p) => stats[p.id][k]).filter((s) => s.n >= MIN_N_CHART).map((s) => badness(s, kind));
    avgAt[k] = vals.length >= 2 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  const result = {};
  for (const p of state.providers) {
    const rels = LEADS.filter((k) => avgAt[k] && stats[p.id][k].n >= MIN_N_CHART).map((k) => 1 - badness(stats[p.id][k], kind) / avgAt[k]);
    result[p.id] = rels.length ? (100 * rels.reduce((a, b) => a + b, 0)) / rels.length : null;
  }
  return result;
}

function bestAt(stats, lead, kind) {
  let best = null;
  for (const p of state.providers) {
    const s = stats[p.id][lead];
    if (s.n < MIN_N_CHART) continue;
    if (!best || badness(s, kind) < badness(best.s, kind)) best = { p, s };
  }
  return best;
}

// ---------- Anzeige ----------

async function update() {
  const locId = $("f-location").value;
  const metric = $("f-metric").value;
  const m = METRICS[metric];
  const loc = state.locations.find((l) => l.id === locId);
  showStatus(`Lade ${loc.name} …`);

  let data;
  try { data = await loadLocation(locId); } catch (err) {
    console.error(err);
    return showStatus(`Für ${loc.name} liegen noch keine Daten vor.`, true);
  }

  const { pairs, from, lastObs, firstObs } = computePairs(data, metric, $("f-period").value, $("f-common").checked);
  const stats = computeStats(pairs, m.kind);
  const ctx = { loc, metric, m, pairs, stats, from, lastObs, firstObs, data };

  renderWarning();
  if (!pairs.length) {
    showStatus("Für diese Auswahl gibt es noch keine vergleichbaren Tage. Tipp: „Nur Tage, an denen alle Anbieter Daten haben“ braucht einige Tage Sammelzeit.", true);
    for (const id of ["kpis", "ranking-card", "lead-card", "table-card", "trend-card"]) $(id).hidden = true;
    renderLatest(ctx);
    return;
  }
  showStatus("");
  renderKpis(ctx);
  renderRanking(ctx);
  renderLeadChart(ctx);
  renderMatrix(ctx);
  renderTrend(ctx);
  renderLatest(ctx);
}

function renderWarning() {
  const s = state.status;
  const el = $("warning");
  if (!s) { el.hidden = true; return; }
  const failed = Object.entries(s.locations || {}).flatMap(([id, l]) => l.results.filter((r) => !r.ok).map((r) => `${id}/${r.step}`));
  el.hidden = !failed.length;
  el.textContent = failed.length ? `Beim letzten Sammellauf gab es Fehler bei: ${failed.join(", ")}.` : "";
}

function renderKpis({ m, pairs, stats, lastObs, loc }) {
  const days = new Set(pairs.map((p) => p.target)).size;
  const firstDay = pairs.reduce((a, p) => (p.target < a ? p.target : a), lastObs);
  const short = { day: "numeric", month: "short", year: "numeric" };
  const b1 = bestAt(stats, 1, m.kind);
  const b5 = bestAt(stats, 5, m.kind);
  const avg = (k) => {
    const vals = state.providers.map((p) => stats[p.id][k]).filter((s) => s.n >= MIN_N_CHART).map((s) => s.value);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const unit = m.unit === "%" ? " %" : ` ${m.unit}`;
  const lastRun = state.status?.lastRun ? new Date(state.status.lastRun).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "–";
  const tile = (label, value, note) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
  $("kpis").innerHTML = [
    tile("Ausgewertete Tage", days.toLocaleString("de-DE"), `${fmtDate(firstDay, short)} bis ${fmtDate(lastObs, short)} · Station ${loc.stationName}`),
    tile("Am genauesten für morgen", b1 ? b1.p.name : "–", b1 ? `${m.kind === "hit" ? "Trefferquote" : "Ø Abweichung"} ${fmt(b1.s.value, m.digits)}${unit}` : "zu wenig Daten"),
    tile("Am genauesten für in 5 Tagen", b5 ? b5.p.name : "–", b5 ? `${m.kind === "hit" ? "Trefferquote" : "Ø Abweichung"} ${fmt(b5.s.value, m.digits)}${unit}` : "zu wenig Daten"),
    tile(m.kind === "hit" ? "Trefferquote: Tag 1 → Tag 7" : "Ø Abweichung: Tag 1 → Tag 7", `${fmt(avg(1), m.digits)} → ${fmt(avg(7), m.digits)}${unit}`, `Mittel aller Anbieter · letzte Aktualisierung ${lastRun}`),
  ].join("");
  $("kpis").hidden = false;
}

function renderRanking({ data, metric }) {
  const period = $("f-period").value;
  const common = $("f-common").checked;
  const keys = Object.keys(METRICS);
  const scores = {}; // metric -> providerId -> Prozent
  const days = {};   // providerId -> ausgewertete Tage (Höchsttemperatur)
  for (const key of keys) {
    const { pairs } = computePairs(data, key, period, common);
    scores[key] = relativeScores(computeStats(pairs, METRICS[key].kind), METRICS[key].kind);
    if (key === "tmax") for (const p of pairs) days[p.provider] = (days[p.provider] || new Set()).add(p.target);
  }

  const rows = state.providers.map((p) => {
    const vals = keys.map((k) => scores[k][p.id]).filter((v) => v != null);
    return { p, total: vals.length === keys.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, days: days[p.id]?.size || 0 };
  });
  rows.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity));

  const ranked = rows.filter((r) => r.total != null);
  const maxAbs = Math.max(1, ...ranked.map((r) => Math.abs(r.total)));
  const pct = (v) => {
    if (v == null) return "–";
    const r = Math.round(v);
    return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)} %`;
  };
  const periodText = $("f-period").selectedOptions[0].textContent;

  $("ranking-sub").textContent = `Zeitraum: ${periodText}${common ? ", nur Tage mit Daten aller Anbieter" : ""}. Gewertet werden alle fünf Messgrößen über alle Vorlaufzeiten, die ein Anbieter rechnet.`;
  const w = ranked[0];
  $("ranking-winner").innerHTML = w
    ? `🏆 Zuverlässigste Quelle: <strong>${w.p.name}</strong>. Sie liegt im Schnitt ${fmt(Math.abs(w.total), 0)} % ${w.total >= 0 ? "genauer" : "ungenauer"} als der Durchschnitt aller Anbieter.`
    : "Noch zu wenig Daten für ein Ranking.";

  const medal = ["🥇", "🥈", "🥉"];
  let html = `<thead><tr><th>Platz</th><th>Anbieter</th><th>Gesamt</th>${keys.map((k) => `<th class="${k === metric ? "sel" : ""}">${METRICS[k].label}</th>`).join("")}<th>Reichweite</th><th>Tage</th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const has = r.total != null;
    const place = has ? medal[i] || `${i + 1}.` : "–";
    const bar = has
      ? `<div class="divbar"><span>${pct(r.total)}</span><span class="track"><span class="fill ${r.total >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(r.total) / maxAbs) * 50}%"></span></span></div>`
      : `<span class="muted">zu wenig Daten</span>`;
    html += `<tr class="${i === 0 && has ? "top" : ""}">
      <td class="place">${place}</td>
      <td class="name"><span class="swatch" style="background:${color(r.p)}"></span>${r.p.name}<small>${r.p.org}</small></td>
      <td class="total">${bar}</td>
      ${keys.map((k) => `<td class="${k === metric ? "sel" : ""} ${scores[k][r.p.id] == null ? "muted" : ""}">${pct(scores[k][r.p.id])}</td>`).join("")}
      <td>${r.p.maxLead} Tage</td>
      <td>${r.days.toLocaleString("de-DE")}</td>
    </tr>`;
  });
  $("ranking").innerHTML = html + "</tbody>";
  $("ranking-card").hidden = false;
}

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
  const t = chartTheme();
  const isHit = m.kind === "hit";
  $("lead-title").textContent = isHit ? "Trefferquote „Regen ja/nein“ nach Vorlaufzeit" : `Abweichung der ${m.label} nach Vorlaufzeit`;
  $("lead-sub").textContent = isHit
    ? `Anteil der Tage, an denen richtig vorhergesagt wurde, ob mindestens ${RAIN_MM} mm Regen fällt. Höher ist besser.`
    : `Mittlere absolute Abweichung zwischen Vorhersage und Messung in ${m.unit}. Niedriger ist besser.`;
  const datasets = state.providers.map((p) => lineDataset(p, LEADS.map((k) => (stats[p.id][k].n >= MIN_N_CHART ? +stats[p.id][k].value.toFixed(2) : null)), { n: LEADS.map((k) => stats[p.id][k].n) }));
  const options = baseOptions(isHit ? "Trefferquote in %" : `Ø Abweichung in ${m.unit}`, t);
  options.plugins.tooltip.callbacks = {
    title: (items) => `Vorhersage ${leadLabel(items[0].dataIndex + 1)} im Voraus`,
    label: (item) => ` ${item.dataset.label}: ${fmt(item.raw, m.digits)} ${m.unit}  (${item.dataset.n[item.dataIndex]} Tage)`,
  };
  if (isHit) { options.scales.y.suggestedMax = 100; }
  else { options.scales.y.beginAtZero = true; }
  $("lead-chart").setAttribute("aria-label", $("lead-title").textContent);
  drawChart("lead", "lead-chart", { type: "line", data: { labels: LEADS.map(leadLabel), datasets }, options });
  $("lead-card").hidden = false;
}

function renderMatrix({ m, stats }) {
  const isHit = m.kind === "hit";
  $("table-title").textContent = "Alle Werte im Überblick";
  $("table-sub").textContent = `${isHit ? "Trefferquote in %" : `Ø Abweichung in ${m.unit}`} je Anbieter und Vorlaufzeit, darunter die Zahl der ausgewerteten Tage. Umrandet ist der beste Wert pro Spalte. Dunkler heißt unzuverlässiger.`;

  const all = state.providers.flatMap((p) => LEADS.map((k) => stats[p.id][k])).filter((s) => s.n >= MIN_N_CHART).map((s) => badness(s, m.kind));
  const lo = Math.min(...all), hi = Math.max(...all);
  const step = (b) => (hi === lo ? 3 : Math.min(6, Math.floor(((b - lo) / (hi - lo)) * 7)));
  const best = Object.fromEntries(LEADS.map((k) => [k, bestAt(stats, k, m.kind)?.p.id]));
  const light = !isDark();

  let html = `<thead><tr><th class="row">Anbieter</th>${LEADS.map((k) => `<th>${leadLabel(k)}</th>`).join("")}</tr></thead><tbody>`;
  for (const p of state.providers) {
    html += `<tr><th class="row" title="${p.org}"><span class="swatch" style="background:${color(p)}"></span>${p.name}</th>`;
    for (const k of LEADS) {
      const s = stats[p.id][k];
      if (k > p.maxLead) { html += `<td class="empty" title="${p.name} rechnet nicht so weit">·</td>`; continue; }
      if (s.n < MIN_N_CHART) { html += `<td class="empty" title="Noch zu wenig Daten">–<span class="n">${s.n} T.</span></td>`; continue; }
      const st = step(badness(s, m.kind));
      const bias = s.bias != null ? ` · Tendenz ${s.bias > 0 ? "zu hoch" : "zu niedrig"} um Ø ${fmt(Math.abs(s.bias), m.digits)} ${m.unit}` : "";
      const cls = [best[k] === p.id ? "best" : "", light && st >= 4 ? "dark-cell" : ""].join(" ");
      html += `<td class="${cls}" style="background:var(--heat-${st})" title="${p.name}, ${leadLabel(k)}: ${fmt(s.value, m.digits)} ${m.unit}${bias} (${s.n} Tage)">${fmt(s.value, m.digits)}<span class="n">${s.n} T.</span></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody>`;
  $("matrix").innerHTML = html;
  const legend = `<div class="legend-scale">zuverlässiger ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<span class="box" style="background:var(--heat-${i})"></span>`).join("")} unzuverlässiger</div>`;
  const wrap = $("matrix").parentElement;
  wrap.nextElementSibling?.classList.contains("legend-scale") && wrap.nextElementSibling.remove();
  wrap.insertAdjacentHTML("afterend", legend);
  $("table-card").hidden = false;
}

function renderTrend({ m, pairs }) {
  const lead = Number($("f-trend-lead").value);
  const isHit = m.kind === "hit";
  $("trend-title").textContent = "Verlauf nach Monaten";
  $("trend-sub").textContent = `${isHit ? "Trefferquote" : "Ø Abweichung"} pro Monat für Vorhersagen ${leadLabel(lead)} im Voraus. Monate mit weniger als ${MIN_N_MONTH} Tagen werden ausgelassen.`;

  const months = [...new Set(pairs.map((p) => p.target.slice(0, 7)))].sort();
  const groups = new Map();
  for (const p of pairs) {
    if (p.lead !== lead) continue;
    const key = `${p.provider}|${p.target.slice(0, 7)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const datasets = state.providers
    .filter((p) => p.maxLead >= lead)
    .map((p) => {
      const scores = months.map((mo) => score(groups.get(`${p.id}|${mo}`) || [], m.kind));
      return lineDataset(p, scores.map((s) => (s.n >= MIN_N_MONTH ? +s.value.toFixed(2) : null)), { n: scores.map((s) => s.n), pointRadius: months.length > 24 ? 2 : 4 });
    });
  const labels = months.map((mo) => new Date(mo + "-15").toLocaleDateString("de-DE", { month: "short", year: "2-digit" }));
  const options = baseOptions(isHit ? "Trefferquote in %" : `Ø Abweichung in ${m.unit}`, chartTheme());
  options.plugins.tooltip.callbacks = {
    title: (items) => new Date(months[items[0].dataIndex] + "-15").toLocaleDateString("de-DE", { month: "long", year: "numeric" }),
    label: (item) => ` ${item.dataset.label}: ${fmt(item.raw, m.digits)} ${m.unit}  (${item.dataset.n[item.dataIndex]} Tage)`,
  };
  if (!isHit) options.scales.y.beginAtZero = true;
  $("trend-chart").setAttribute("aria-label", `${$("trend-title").textContent}, ${leadLabel(lead)} im Voraus`);
  drawChart("trend", "trend-chart", { type: "line", data: { labels, datasets }, options });
  $("trend-card").hidden = false;
}

function renderLatest({ m, data, lastObs }) {
  if (!lastObs) { $("latest-card").hidden = true; return; }
  const o = data.obs.get(lastObs);
  const field = m.field;
  const unit = field === "precip" ? "mm" : m.unit === "%" ? "mm" : m.unit;
  const fcs = new Map(data.fc.filter((r) => r.target === lastObs).map((r) => [`${r.provider}|${r.lead}`, r[field]]));
  const label = field === "precip" ? "Niederschlag" : m.label;
  $("latest-title").textContent = `Letzter gemessener Tag: ${fmtDate(lastObs, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
  $("latest-sub").textContent = `${label}: gemessen ${fmt(o?.[field], 1)} ${unit}. Darunter: Was die Anbieter 1 bis 7 Tage vorher für diesen Tag vorhergesagt haben.`;

  let html = `<thead><tr><th class="row">Anbieter</th>${LEADS.map((k) => `<th>${leadLabel(k)} vorher</th>`).join("")}</tr></thead><tbody>`;
  html += `<tr class="obs"><th class="row">Gemessen</th><td colspan="7">${fmt(o?.[field], 1)} ${unit}</td></tr>`;
  for (const p of state.providers) {
    html += `<tr><th class="row"><span class="swatch" style="background:${color(p)}"></span>${p.name}</th>`;
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
