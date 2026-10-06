# Regen-Check

**Wie zuverlässig sagen Wetterdienste Regen voraus?** Ausgewertet an 445 DWD-Niederschlagsstationen, gleichmäßig über Deutschland verteilt (etwa alle 28 km), jeden Tag neu.

Live: https://pollux1337.github.io/trueweather/

## Was gemessen wird

- **Regen ja/nein** und **Regenmenge**
- **2-Stunden-Abschnitte** für Vorhersagen 1–3 Tage im Voraus, **ganze Tage** für 1–7 Tage
- **Gleitendes 24-Monats-Fenster:** Ältere Monate fallen automatisch heraus.

Ein 2-Stunden-Abschnitt gilt ab 0,2 mm als nass, ein Tag ab 1 mm. Kennzahlen:

| Kennzahl | Bedeutung |
|---|---|
| Treffsicherheit | Treffer ÷ (Treffer + Fehlalarme + verpasster Regen). Trockene Abschnitte, die richtig vorhergesagt wurden, zählen nicht, sonst lägen alle Dienste über 90 %. |
| Regen erkannt | Anteil der Regenfälle, die vorhergesagt wurden |
| Fehlalarme | Anteil der Regenvorhersagen, bei denen es trocken blieb |
| Ø Abweichung | mittlere Abweichung der Regenmenge in mm |
| Vergleich zum Durchschnitt | **Paarvergleich:** eigene Fehler gegenüber dem mittleren Fehler aller Dienste in genau denselben Abschnitten. Fair auch für Dienste mit kurzer Datenreihe oder kürzerer Reichweite. |

## Wetterdienste

| Dienst | Quelle | Vorlauf | Daten |
|---|---|---|---|
| DWD ICON, ECMWF IFS, NOAA GFS, UK Met Office, GEM Kanada | Open-Meteo Previous Runs | 1–7 Tage (ICON, UKMO 1–6) | Archiv, 24 Monate |
| Météo-France | Open-Meteo Previous Runs | 1–3 Tage | Archiv, 24 Monate |
| DWD MOSMIX | Bright Sky, nächster MOSMIX-Punkt im Umkreis von 15 km | 1–7 Tage | täglich gesammelt seit Okt. 2026 |
| MET Norway (yr) | api.met.no | 1–7 Tage, stündlich nur ~2,5 Tage | täglich gesammelt seit Okt. 2026 |

**Messwerte:** stündlicher Niederschlag der DWD-Stationen über [Bright Sky](https://brightsky.dev), ohne Ersatzwerte von Nachbarstationen. Ein Tag wird erst ausgewertet, wenn er 10 Tage zurückliegt, damit der DWD fehlende Werte nachliefern kann.

## Ablauf

GitHub Actions (`.github/workflows/collect.yml`) läuft zweimal täglich:

- **05:15 UTC:** MOSMIX und MET Norway sammeln, neue Tage auswerten, Archiv importieren
- **17:15 UTC:** nur auswerten und Archiv importieren

Das Auswerten geschieht in Blöcken von mindestens 7 Tagen, das spart Abfragen. Das Archiv wird rückwärts gefüllt, die jüngsten Monate zuerst und die Stationen gestreut über Deutschland. Jeder Lauf nutzt höchstens 4.500 Open-Meteo-Einheiten, so bleiben Stunden- und Tageslimit eingehalten.

**Speicher:** Statt Rohdaten werden Monatszähler je Station, Dienst und Vorlauf gespeichert (`state/acc/<Station>.json`). Der Datenstand liegt auf dem Zweig **`daten`**. Er wird bei jedem Lauf ersetzt, damit der Git-Verlauf nicht wächst. Eine Sicherungskopie liegt 14 Tage als Actions-Artefakt.

## Aufbau

```
index.html, regen.js, regen.css   Webseite „Regen-Check“
lib/rain.js                       Definitionen und Kennzahlen (Browser und Node)
config/stations.json              445 Stationen (erzeugt von collector/select-stations.mjs)
config/providers.json             Wetterdienste
collector/collect.mjs             Sammeln, Auswerten, Archiv-Import
collector/sources.mjs             Abfragen: Bright Sky, Open-Meteo, MET Norway
collector/core.mjs                Stunden → Tage/2-Stunden-Abschnitte, Zähler
collector/build-site.mjs          baut _site/ mit vorberechneten Daten je Zeitraum
collector/select-stations.mjs     wählt gleichmäßig verteilte Stationen
wetter.html                       einfache Seite „Aktuelles Wetter“
```

## Lokal ausprobieren

```bash
npm run evaluate -- --budget 500
```

Wertet mit kleinem Budget aus. Die Daten landen in `state/`.

```bash
npm run build
```

Baut die Seite nach `_site/`.

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Danach http://localhost:8000/_site/ öffnen.

## Quellen & Lizenzen

[Deutscher Wetterdienst](https://www.dwd.de) (Open Data) über [Bright Sky](https://brightsky.dev) · [Open-Meteo](https://open-meteo.com) (CC BY 4.0) · [MET Norway](https://api.met.no) (CC BY 4.0) · Ländergrenzen [deutschlandGeoJSON](https://github.com/isellsoap/deutschlandGeoJSON) (Unlicense)
