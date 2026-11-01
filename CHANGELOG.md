# Changelog

Alle nennenswerten Änderungen an OpenKittens. Das Format orientiert sich an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung an
[Semantic Versioning](https://semver.org/lang/de/).

## [Unveröffentlicht]

### Hinzugefügt

- **Computergegner** in drei Spielstärken (leicht, normal, schlau). Der Host legt
  sie in der Lobby an und stellt jede Stufe einzeln ein; ein Mensch plus ein Bot
  genügt für eine Partie. Bots entscheiden nur mit öffentlich sichtbaren
  Informationen und ihrer eigenen Hand, pausieren ohne Zuschauer und überstehen
  einen Neustart des Servers.
- **Kartenanimationen**: gezogene Karten fliegen vom Stapel und bleiben für den
  Ziehenden kurz groß stehen, für alle anderen fliegt eine verdeckte Karte zum
  jeweiligen Spieler. Ausgespielte Karten fliegen offen zur Ablage, geklaute und
  verschenkte Karten verdeckt zwischen den Spielern, Mischen dreht den Stapel,
  der Ziehen-Button pulsiert, wenn man am Zug ist. `prefers-reduced-motion` wird
  beachtet.
- **Stapelgröße** als Hausregel (klein, mittel, groß). Der Nachziehstapel wächst
  mit der Spielerzahl, statt immer gleich dick zu sein – zu zweit dauert eine
  Partie damit deutlich kürzer. Die Lobby zeigt vorab Kartenzahl und Bomben.

### Geändert

- Der Kartenpool wird jetzt auf eine Zielgröße gemischt statt in festen Mengen;
  Untergrenzen sorgen dafür, dass Nope, Überspringen und Katzenpaare auch in
  kleinen Stapeln vorkommen. Die Zahl der Entschärfungen richtet sich nach der
  Stapelgröße.

## [1.0.0] – 2026-11-01

Erste vollständige Fassung: lauffähig per `docker compose up -d --build`,
spielbar im lokalen Netz ohne Konto.

### Spiel

- Kartenspiel im Stil von *Exploding Kittens* für 2–8 Spieler mit eigenen
  Kartennamen: Explodierendes Kätzchen, Entschärfung, Überspringen, Angriff,
  Mischen, Blick in die Zukunft, Gefallen, Nope und fünf Katzenkarten.
- Katzen-Kombinationen: zwei gleiche klauen zufällig, drei gleiche fordern eine
  angesagte Karte, fünf verschiedene holen eine Karte aus dem Ablagestapel.
- Nope-Fenster mit Gegen-Nope, auch auf die eigene Aktion spielbar.
- Entschärfen mit heimlichem Zurückstecken der Bombe an frei wählbarer Stelle.
- Angriff stapelt Züge, Gefallen lässt das Ziel die Karte aussuchen.
- Hausregeln in der Lobby: Nope-Fenster, Zeit pro Zug, Startkarten, Zusatzbomben.

### Mehrspieler ohne Konto

- Vierstelliger Raumcode plus frei gewählter Name, kein Login, keine Datenbank.
- Lobby mit QR-Code, Beitritts-Link und Kopierbuttons.
- Reconnect über einen im Browser gespeicherten Token – gleiche Hand nach Reload
  oder kurzem Verbindungsverlust.
- Automatischer Zug für offline gegangene Spieler, Zug-Timer für anwesende.
- Host kann Spieler entfernen und nach der Runde direkt neu starten.
- Wer mitten in einer Runde beitritt, schaut zu und spielt ab der nächsten mit.

### Oberfläche

- Mobile-first: große Tippflächen, Aktionsleiste unten, Hoch- und Querformat,
  Safe-Area für Geräte mit Notch; ab 900 px Zwei-Spalten-Layout mit Verlaufsspalte.
- Verlauf als Schublade auf schmalen Bildschirmen.
- Animationen und abschaltbare Soundeffekte für Explosion, Nope, Klauen,
  Entschärfen, Angriff und Sieg.
- Spielerfarben und -symbole, Marker für den Spieler am Zug.
- Barrierefreiheit: Karten als Buttons mit `aria-pressed`, erhaltener Tastaturfokus,
  Live-Region für Ansagen, Escape schließt freiwillige Dialoge.

### Betrieb

- Docker-Image auf Node 22 Alpine, Non-Root, Healthcheck, Standardport 3333.
- Laufende Runden werden gesichert und nach einem Neustart wiederhergestellt
  (Volume `/app/data`, abschaltbar über `PERSIST=0`).
- Socket.IO nur vom selben Ursprung, Obergrenzen für Räume insgesamt und je
  Verbindung, automatisches Aufräumen inaktiver Räume.
- Der Server verschickt nur, was ein Spieler sehen darf: fremde Handkarten, der
  Stapelinhalt und fremde Zukunftsblicke bleiben auf dem Server.

### Tests

- 27 Logiktests inklusive Zufallsspielen, Ende-zu-Ende-Test über Socket.IO,
  18 Browser-Prüfungen mit Playwright.
- GitHub-Action fährt alle Testsuiten plus Docker-Build mit Smoke-Test.

[1.0.0]: https://github.com/geonerd97/OpenKittens/releases/tag/v1.0.0
