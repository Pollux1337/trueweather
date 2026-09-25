# Wetter-Dashboard & Vorhersage-Check

Zwei Seiten, ohne Build-Schritt und ohne API-Schlüssel:

- **`index.html` – Aktuelles Wetter:** aktuelle Werte, 24-Stunden-Verlauf, 7-Tage-Vorhersage, Ortssuche.
- **`zuverlaessigkeit.html` – Vorhersage-Check:** Wie genau sind Vorhersagen 1 bis 7 Tage im Voraus? Acht Anbieter werden täglich mit den Messwerten einer DWD-Station verglichen.

## Anbieter

| ID | Anbieter | Quelle | Vorlaufzeit | Daten seit |
|---|---|---|---|---|
| `icon` | DWD ICON | Open-Meteo Previous Runs | 1–6 Tage | 2024 |
| `ecmwf` | ECMWF IFS | Open-Meteo Previous Runs | 1–7 Tage | 2024 |
| `gfs` | NOAA GFS | Open-Meteo Previous Runs | 1–7 Tage | 2024 |
| `arpege` | Météo-France | Open-Meteo Previous Runs | 1–3 Tage | 2024 |
| `ukmo` | UK Met Office | Open-Meteo Previous Runs | 1–6 Tage | Herbst 2024 |
| `gem` | GEM Kanada | Open-Meteo Previous Runs | 1–7 Tage | 2024 |
| `mosmix` | DWD MOSMIX | Bright Sky, täglich gesammelt | 1–7 Tage | Projektstart |
| `metno` | MET Norway (yr) | api.met.no, täglich gesammelt | 1–7 Tage | Projektstart |

**Orte:** die 16 Landeshauptstädte und zusätzlich Lübeck (`config/locations.json`). Das Dashboard zeigt jeden Ort einzeln und „Alle Orte (gemittelt)“. Im gemittelten Ranking wird jeder Ort einzeln bewertet und dann gemittelt, sodass jeder Ort gleich viel zählt. Mainz nutzt die Station Geisenheim und Wiesbaden die Station Frankfurt/Main, weil es in beiden Städten keine vollständige DWD-Station gibt.

**Messwerte:** DWD-Station je Ort über [Bright Sky](https://brightsky.dev). Ein Tag wird erst ausgewertet, wenn mindestens 22 Stundenwerte vorliegen. Der DWD liefert die Werte mit 1–3 Tagen Verzögerung vollständig nach.

**Tageswerte:** Höchst- und Tiefsttemperatur, Niederschlagssumme und stärkster Stundenmittelwind, jeweils für 0–24 Uhr Ortszeit. Ein Regentag hat mindestens 1 mm Niederschlag.

## Aufbau

```
config/locations.json     Orte (neuer Ort = neuer Eintrag, inkl. DWD-Stations-ID)
config/providers.json     Anbieter und ihre Reichweite
collector/                Sammel-Skript (Node.js, keine Abhängigkeiten)
data/<ort>/observations.csv   Messwerte pro Tag
data/<ort>/forecasts.csv      Vorhersagen: Zieltag, Anbieter, Vorlaufzeit, Werte
data/status.json          Ergebnis des letzten Sammellaufs
.github/workflows/collect.yml täglicher Lauf auf GitHub + Veröffentlichung
```

## Lokal benutzen

```bash
npm run collect
```

Das Skript sammelt die aktuellen Vorhersagen und zieht die letzten 14 Tage nach. Danach setzt es den **Archiv-Import** fort: Messwerte und das Open-Meteo-Archiv werden je Ort rückwärts bis 2024-01-01 eingelesen, in 92-Tage-Stücken und reihum über alle Orte. Der Fortschritt steht in `data/archive-progress.json`.

Open-Meteo erlaubt 10.000 Einheiten pro Tag, der komplette Import für 16 Orte braucht etwa 15.000. Jeder Lauf nutzt deshalb höchstens ein Budget (Standard 6000, änderbar mit `--budget 8000`). Ist das Limit erreicht, hört er sauber auf und macht beim nächsten Lauf weiter.

Dashboard lokal ansehen:

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Dann http://localhost:8000 öffnen. Die Seite muss über einen Webserver laufen, als Datei geöffnet kann sie die CSV-Dateien nicht laden.

## Einen Ort hinzufügen

1. Die nächste DWD-Station suchen: `https://api.brightsky.dev/sources?lat=<lat>&lon=<lon>` und einen Eintrag mit `observation_type: historical` wählen.
2. Den Ort in `config/locations.json` eintragen, mit den Koordinaten der Station.
3. Fertig: Der nächste Lauf sammelt die aktuellen Daten, der Archiv-Import holt die Vergangenheit nach.

## Auf GitHub

Der Workflow läuft täglich um 05:15 UTC. Er speichert die neuen Daten im Repository und veröffentlicht beide Seiten über GitHub Pages. Unter *Actions → Wetterdaten sammeln → Run workflow* lässt er sich auch von Hand starten.

## Datenquellen & Lizenzen

- [Open-Meteo](https://open-meteo.com): CC BY 4.0, kostenlos für nicht-kommerzielle Nutzung
- [Bright Sky](https://brightsky.dev) / [Deutscher Wetterdienst](https://www.dwd.de): DWD-Open-Data
- [MET Norway](https://api.met.no): CC BY 4.0
