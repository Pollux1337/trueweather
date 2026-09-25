// Wetter-Dashboard – Daten von Open-Meteo (kein API-Schlüssel nötig)

const DEFAULT_PLACE = { name: "Berlin", admin1: "Berlin", country: "Deutschland", latitude: 52.52, longitude: 13.41 };
const STORAGE_KEY = "wetter-dashboard:place";

// WMO-Wettercodes → Beschreibung + Symbol
const WEATHER_CODES = {
  0: ["Klar", "☀️"],
  1: ["Überwiegend klar", "🌤️"],
  2: ["Teilweise bewölkt", "⛅"],
  3: ["Bedeckt", "☁️"],
  45: ["Nebel", "🌫️"],
  48: ["Nebel mit Reif", "🌫️"],
  51: ["Leichter Nieselregen", "🌦️"],
  53: ["Nieselregen", "🌦️"],
  55: ["Starker Nieselregen", "🌧️"],
  56: ["Gefrierender Nieselregen", "🌧️"],
  57: ["Starker gefrierender Nieselregen", "🌧️"],
  61: ["Leichter Regen", "🌦️"],
  63: ["Regen", "🌧️"],
  65: ["Starker Regen", "🌧️"],
  66: ["Gefrierender Regen", "🌧️"],
  67: ["Starker gefrierender Regen", "🌧️"],
  71: ["Leichter Schneefall", "🌨️"],
  73: ["Schneefall", "🌨️"],
  75: ["Starker Schneefall", "❄️"],
  77: ["Schneegriesel", "🌨️"],
  80: ["Leichte Regenschauer", "🌦️"],
  81: ["Regenschauer", "🌧️"],
  82: ["Heftige Regenschauer", "⛈️"],
  85: ["Schneeschauer", "🌨️"],
  86: ["Starke Schneeschauer", "❄️"],
  95: ["Gewitter", "⛈️"],
  96: ["Gewitter mit Hagel", "⛈️"],
  99: ["Schweres Gewitter mit Hagel", "⛈️"],
};

const $ = (id) => document.getElementById(id);

function describe(code, isDay = 1) {
  const [text, icon] = WEATHER_CODES[code] || ["Unbekannt", "❔"];
  // Nachts Mond statt Sonne
  if (!isDay && (code === 0 || code === 1)) return [text, "🌙"];
  return [text, icon];
}

const fmtTemp = (t) => `${Math.round(t)}°`;
const WIND_DIRS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
const windDir = (deg) => WIND_DIRS[Math.round(deg / 45) % 8];

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = !text;
}

function placeLabel(p) {
  return [p.name, p.admin1 !== p.name ? p.admin1 : null, p.country].filter(Boolean).join(", ");
}

// ---------- Daten laden ----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchPlaces(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=de&format=json`;
  const data = await fetchJson(url);
  return data.results || [];
}

async function fetchWeather(place) {
  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,is_day,wind_speed_10m,wind_direction_10m,surface_pressure",
    hourly: "temperature_2m,precipitation_probability,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max",
    timezone: "auto",
    forecast_days: 7,
  });
  return fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
}

async function loadPlace(place) {
  setStatus(`Lade Wetter für ${place.name} …`);
  try {
    const data = await fetchWeather(place);
    render(place, data);
    setStatus("");
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(place)); } catch {}
  } catch (err) {
    console.error(err);
    setStatus("Wetterdaten konnten nicht geladen werden. Bitte später erneut versuchen.", true);
  }
}

// ---------- Anzeige ----------

function render(place, data) {
  renderCurrent(place, data);
  renderHourly(data);
  renderDaily(data);
}

function renderCurrent(place, data) {
  const c = data.current;
  const [text, icon] = describe(c.weather_code, c.is_day);
  $("place").textContent = placeLabel(place);
  $("updated").textContent = "Stand: " + new Date(c.time).toLocaleString("de-DE", { weekday: "long", hour: "2-digit", minute: "2-digit" }) + " Uhr (Ortszeit)";
  $("current-icon").textContent = icon;
  $("current-temp").textContent = fmtTemp(c.temperature_2m);
  $("current-desc").textContent = text;
  $("feels").textContent = fmtTemp(c.apparent_temperature);
  $("humidity").textContent = `${c.relative_humidity_2m} %`;
  $("wind").textContent = `${Math.round(c.wind_speed_10m)} km/h ${windDir(c.wind_direction_10m)}`;
  $("precip").textContent = `${c.precipitation.toLocaleString("de-DE")} mm`;
  $("pressure").textContent = `${Math.round(c.surface_pressure)} hPa`;
  $("uv").textContent = data.daily.uv_index_max[0]?.toLocaleString("de-DE", { maximumFractionDigits: 1 }) ?? "–";
  $("current").hidden = false;
}

function renderHourly(data) {
  const h = data.hourly;
  // Ab der aktuellen Stunde die nächsten 24 Werte
  const start = Math.max(0, h.time.findIndex((t) => t >= data.current.time.slice(0, 13)));
  const idx = Array.from({ length: 24 }, (_, i) => start + i).filter((i) => i < h.time.length);
  const temps = idx.map((i) => h.temperature_2m[i]);

  const W = 900, H = 230;
  const pad = { top: 44, right: 16, bottom: 40, left: 16 };
  const iw = W - pad.left - pad.right;
  const chartBottom = H - pad.bottom;
  const tempH = 90;
  const min = Math.min(...temps), max = Math.max(...temps);
  const span = max - min || 1;
  const step = iw / idx.length;
  const x = (k) => pad.left + step * (k + 0.5);
  const y = (t) => pad.top + tempH - ((t - min) / span) * tempH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperaturverlauf und Regenwahrscheinlichkeit der nächsten 24 Stunden">`;
  svg += `<line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${chartBottom}" y2="${chartBottom}"/>`;

  // Regenwahrscheinlichkeit als Balken unten
  const rainMaxH = 40;
  idx.forEach((i, k) => {
    const p = h.precipitation_probability[i] ?? 0;
    const bh = (p / 100) * rainMaxH;
    if (bh > 0) svg += `<rect class="bar" x="${x(k) - step * 0.3}" y="${chartBottom - bh}" width="${step * 0.6}" height="${bh}" rx="2"><title>${p} % Regen</title></rect>`;
  });

  // Temperaturlinie mit Fläche
  const pts = temps.map((t, k) => `${x(k)},${y(t)}`);
  svg += `<path class="area" d="M${x(0)},${chartBottom - rainMaxH - 4} L${pts.join(" L")} L${x(temps.length - 1)},${chartBottom - rainMaxH - 4} Z"/>`;
  svg += `<path class="line" d="M${pts.join(" L")}"/>`;

  idx.forEach((i, k) => {
    const hour = h.time[i].slice(11, 13);
    if (k % 2 === 0) {
      svg += `<text class="temp-label" x="${x(k)}" y="${y(temps[k]) - 10}" text-anchor="middle">${fmtTemp(temps[k])}</text>`;
      svg += `<text x="${x(k)}" y="${H - 22}" text-anchor="middle">${hour} Uhr</text>`;
      svg += `<text x="${x(k)}" y="${H - 6}" text-anchor="middle">${h.precipitation_probability[i] ?? 0} %</text>`;
    }
  });

  svg += `</svg>`;
  $("hourly-chart").innerHTML = svg;
  $("hourly").hidden = false;
}

function renderDaily(data) {
  const d = data.daily;
  const weekMin = Math.min(...d.temperature_2m_min);
  const weekMax = Math.max(...d.temperature_2m_max);
  const span = weekMax - weekMin || 1;

  $("daily-list").innerHTML = d.time.map((day, i) => {
    const [text, icon] = describe(d.weather_code[i]);
    const date = new Date(day + "T12:00");
    const label = i === 0 ? "Heute" : date.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" });
    const lo = d.temperature_2m_min[i], hi = d.temperature_2m_max[i];
    const left = ((lo - weekMin) / span) * 100;
    const width = Math.max(((hi - lo) / span) * 100, 3);
    return `<li>
      <span>${label}</span>
      <span class="icon" title="${text}">${icon}</span>
      <div class="range">
        <span>${fmtTemp(lo)}</span>
        <div class="range-track"><div class="range-fill" style="left:${left}%;width:${width}%"></div></div>
        <span>${fmtTemp(hi)}</span>
      </div>
      <span class="rain" title="Regenwahrscheinlichkeit">💧 ${d.precipitation_probability_max[i] ?? 0} %</span>
    </li>`;
  }).join("");
  $("daily").hidden = false;
}

// ---------- Suche ----------

const input = $("search-input");
const list = $("suggestions");
let results = [];
let active = -1;
let debounce;

function showSuggestions(items) {
  results = items;
  active = -1;
  if (!items.length) { list.hidden = true; return; }
  list.innerHTML = items.map((p, i) => `<li data-i="${i}">${placeLabel(p)}</li>`).join("");
  list.hidden = false;
}

function choose(i) {
  const place = results[i];
  if (!place) return;
  list.hidden = true;
  input.value = "";
  loadPlace(place);
}

input.addEventListener("input", () => {
  clearTimeout(debounce);
  const q = input.value.trim();
  if (q.length < 2) { list.hidden = true; return; }
  debounce = setTimeout(async () => {
    try { showSuggestions(await searchPlaces(q)); } catch { list.hidden = true; }
  }, 300);
});

input.addEventListener("keydown", (e) => {
  if (list.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
    [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
  } else if (e.key === "Escape") {
    list.hidden = true;
  }
});

list.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li");
  if (li) choose(Number(li.dataset.i));
});

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!list.hidden && active >= 0) return choose(active);
  const q = input.value.trim();
  if (!q) return;
  try {
    const found = await searchPlaces(q);
    if (found.length) { results = found; choose(0); }
    else setStatus(`Kein Ort mit dem Namen „${q}“ gefunden.`, true);
  } catch {
    setStatus("Die Ortssuche ist gerade nicht erreichbar.", true);
  }
});

input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));

$("locate-btn").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("Dein Browser unterstützt keine Standortabfrage.", true);
  setStatus("Ermittle Standort …");
  navigator.geolocation.getCurrentPosition(
    (pos) => loadPlace({ name: "Mein Standort", country: "", latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
    () => setStatus("Standort konnte nicht ermittelt werden.", true)
  );
});

// ---------- Start ----------

let saved = null;
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch {}
loadPlace(saved || DEFAULT_PLACE);
