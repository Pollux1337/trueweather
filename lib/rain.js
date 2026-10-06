// Gemeinsame Definitionen für Sammel-Skript (Node) und Webseite (Browser).

export const WINDOW_MONTHS = 24;     // gleitendes Fenster
export const RAIN_DAY_MM = 1.0;      // ab dieser Tagesmenge gilt ein Tag als Regentag
export const RAIN_SLOT_MM = 0.2;     // ab dieser Menge gilt ein 2-Stunden-Abschnitt als nass
export const SLOTS = 12;             // 2-Stunden-Abschnitte pro Tag
export const DAY_LEADS = [1, 2, 3, 4, 5, 6, 7];
export const SLOT_LEADS = [1, 2, 3]; // 2-Stunden-Auswertung nur für kurze Vorlaufzeiten

// Zellen je Anbieter: d1…d7 (ganzer Tag), h1…h3 (2 Stunden)
export const CELLS = [...DAY_LEADS.map((k) => `d${k}`), ...SLOT_LEADS.map((k) => `h${k}`)];
export const cellIndex = (res, lead) => CELLS.indexOf(`${res}${lead}`);

// Zählwerte je Zelle:
//   a  Regen vorhergesagt und gefallen      b  vorhergesagt, aber trocken (Fehlalarm)
//   c  nicht vorhergesagt, aber gefallen    d  trocken vorhergesagt und trocken
//   sAbs  Summe der Mengenabweichungen (mm)
//   oYN/rYN, oA/rA  Paarvergleich: eigene Fehler bzw. mittlerer Fehler aller Anbieter in denselben Abschnitten
export const FIELDS = ["a", "b", "c", "d", "sAbs", "oYN", "rYN", "oA", "rA"];
export const F = Object.fromEntries(FIELDS.map((f, i) => [f, i]));

// Zeiträume der Webseite: Monate relativ zum letzten vollständigen Monat
export const VIEWS = {
  m24:    { label: "Letzte 24 Monate", months: 24 },
  m12:    { label: "Letzte 12 Monate", months: 12 },
  m3:     { label: "Letzte 3 Monate",  months: 3 },
  winter: { label: "Winter (Dez–Feb)",  season: [12, 1, 2] },
  spring: { label: "Frühling (Mär–Mai)", season: [3, 4, 5] },
  summer: { label: "Sommer (Jun–Aug)",  season: [6, 7, 8] },
  autumn: { label: "Herbst (Sep–Nov)",  season: [9, 10, 11] },
};

const pad = (n) => String(n).padStart(2, "0");
export const monthKey = (y, m) => `${y}-${pad(m)}`;
export function addMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return monthKey(Math.floor(t / 12), (t % 12) + 1);
}

// Erster Tag des Fensters: Monatsanfang vor WINDOW_MONTHS Monaten
export function windowStart(now) {
  const cur = monthKey(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return `${addMonths(cur, -WINDOW_MONTHS)}-01`;
}

// Welche Monate gehören zu einer Ansicht? lastMonth = jüngster Monat mit Daten
export function viewMonths(view, lastMonth) {
  const v = VIEWS[view];
  const all = Array.from({ length: WINDOW_MONTHS }, (_, i) => addMonths(lastMonth, -i));
  if (v.months) return all.slice(0, v.months);
  return all.filter((k) => v.season.includes(Number(k.slice(5))));
}

// Kennzahlen aus Zählwerten
export function metrics(c) {
  if (!c) return null;
  const [a, b, cc, d, sAbs, oYN, rYN, oA, rA] = c;
  const n = a + b + cc + d;
  if (!n) return null;
  return {
    n,
    csi: a + b + cc ? (100 * a) / (a + b + cc) : null,  // Treffsicherheit
    pod: a + cc ? (100 * a) / (a + cc) : null,           // Regen erkannt
    far: a + b ? (100 * b) / (a + b) : null,             // Fehlalarme
    mae: sAbs / n,                                       // Ø Abweichung der Menge
    relYN: rYN > 0 ? 100 * (1 - oYN / rYN) : null,       // besser (+) / schlechter (−) als der Durchschnitt
    relA: rA > 0 ? 100 * (1 - oA / rA) : null,
  };
}

export function addInto(target, src) {
  for (let i = 0; i < FIELDS.length; i++) target[i] += src[i] || 0;
  return target;
}
export const emptyCounts = () => FIELDS.map(() => 0);
