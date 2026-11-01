# 🐱 OpenKittens

Ein Kartenspiel im Stil von *Exploding Kittens* zum Selbsthosten – gedacht für einen
Abend im eigenen WLAN: ein Rechner startet den Server, alle anderen öffnen die Adresse
im Browser und tippen einen **vierstelligen Raumcode** plus ihren Namen ein.
**Kein Konto, keine Registrierung, keine Datenbank, keine Cloud.**

```
┌─────────────┐   WLAN/LAN    ┌──────────────────────┐
│ Handy, Tab, │ ───────────▶  │ Docker-Container     │
│ Laptop …    │  HTTP + WS    │ Node + Socket.IO     │
└─────────────┘               │ Spielstand im RAM    │
                              └──────────────────────┘
```

---

## Schnellstart

Voraussetzung: Docker mit Compose-Plugin (Docker Desktop oder `docker-compose-plugin`).

```bash
git clone <dieses-repo> openkittens
cd openkittens
docker compose up -d --build
```

Danach läuft das Spiel auf **http://localhost:3333**.

### Mitspieler im lokalen Netz

Die Mitspieler brauchen die **IP-Adresse des Rechners**, auf dem der Container läuft:

| System        | Befehl                                        |
| ------------- | --------------------------------------------- |
| Linux         | `hostname -I` oder `ip addr show`             |
| macOS         | `ipconfig getifaddr en0`                      |
| Windows       | `ipconfig` (IPv4-Adresse des WLAN-Adapters)   |

Beispiel: `http://192.168.178.42:3333` im Browser des Handys öffnen.

1. Eine Person klickt **„Neuen Raum erstellen"** und bekommt einen vierstelligen Code (z. B. `4821`).
2. Alle anderen geben Namen + Code ein und klicken **„Raum beitreten"**.
3. Der Host startet die Runde, sobald mindestens zwei Leute da sind (max. 8).

> Firewall: Unter Windows/macOS muss Port 3333 eingehend erlaubt sein, sonst sehen die
> anderen Geräte den Server nicht.

### Stoppen, Logs, Update

```bash
docker compose logs -f      # Logs ansehen
docker compose restart      # Neustart (alle laufenden Runden gehen verloren)
docker compose down         # Stoppen und Container entfernen
docker compose up -d --build   # nach Code-Änderungen neu bauen
```

### Anderer Port

Wenn 3333 schon belegt ist, in `docker-compose.yml` nur die linke Seite ändern:

```yaml
ports:
  - "8080:3333"      # erreichbar unter http://<ip>:8080
```

---

## Spielregeln

Ziel: **Als Letzte(r) übrig bleiben.**

Wenn du am Zug bist, darfst du beliebig viele Karten ausspielen und **musst danach eine
Karte ziehen** – damit endet dein Zug.

| Karte | | Wirkung |
| --- | --- | --- |
| Explodierendes Kätzchen | 💥 | Wer es zieht und keine Entschärfung hat, scheidet aus. Im Spiel sind immer *Spielerzahl − 1* Bomben. |
| Entschärfung | 🧯 | Wird automatisch eingesetzt, wenn du eine Bombe ziehst. Danach steckst du die Bombe heimlich an eine beliebige Stelle im Stapel zurück. |
| Überspringen | 🏃 | Zug beenden, ohne zu ziehen. |
| Angriff | ⚔️ | Dein Zug endet sofort, der Nächste muss **zwei** Züge machen (stapelt sich). |
| Mischen | 🔀 | Nachziehstapel neu mischen. |
| Blick in die Zukunft | 🔮 | Du siehst heimlich die obersten drei Karten. |
| Gefallen | 🙏 | Ein Mitspieler deiner Wahl gibt dir eine Karte – er sucht sie aus. |
| Nope | 🚫 | Hebt die zuletzt gespielte Aktion auf, auch außerhalb deines Zuges. Ein zweites Nope hebt das Nope wieder auf. |
| Katzenkarten | 🍕🍉🧔🌈🥔 | Allein wirkungslos. **Zwei gleiche** klauen einem Mitspieler eine zufällige Karte. |

**Nope-Fenster:** Nach jeder Aktionskarte läuft unten ein Balken mit ca. 6 Sekunden.
Wer eine Nope-Karte hat, kann in dieser Zeit „Nope!" oder „Durchlassen" klicken.
Haben alle durchgelassen (oder hat niemand ein Nope), wird die Aktion sofort ausgeführt.

**Start:** Jeder bekommt 7 zufällige Karten + 1 Entschärfung, dann kommen die restlichen
Entschärfungen und die Bomben in den Stapel.

---

## Praktisches

* **Reconnect:** Der Browser merkt sich pro Raum einen Token. Wer die Seite neu lädt oder
  kurz das WLAN verliert, landet mit derselben Hand wieder im Spiel.
* **Offline-Spieler:** Ist jemand länger weg, zieht der Server nach 20 Sekunden
  automatisch für ihn, damit die Runde weiterläuft.
* **Später dazugekommen?** Wer mitten in einer Runde beitritt, schaut zu und ist in der
  nächsten Runde dabei.
* **Neue Runde:** Nach dem Sieg klickt der Host auf „Neue Runde" – der Raumcode bleibt gleich.
* **Räume** liegen nur im Arbeitsspeicher und werden nach 3 Stunden ohne Verbindung
  aufgeräumt (`ROOM_TTL_MINUTES`). Ein Neustart des Containers beendet alle Runden.

### Konfiguration (Umgebungsvariablen)

| Variable            | Standard | Bedeutung                                   |
| ------------------- | -------- | ------------------------------------------- |
| `PORT`              | `3333`   | Port im Container                           |
| `HOST`              | `0.0.0.0`| Listen-Adresse                              |
| `ROOM_TTL_MINUTES`  | `180`    | Aufräumen leerer Räume nach x Minuten        |

Zusätzlich gibt es `GET /health` für Monitoring und den Compose-Healthcheck.

---

## Entwicklung ohne Docker

```bash
npm install
npm start          # http://localhost:3333
npm run dev        # mit automatischem Neustart (node --watch)
npm test           # Spiellogik (Deck, Nope, Angriff, Entschärfen, Zufallsspiele)
npm run test:e2e   # echte Socket.IO-Runde mit drei simulierten Clients
```

### Aufbau

```
server/cards.js   Kartendefinitionen und Deckzusammenstellung
server/game.js    komplette Spiellogik (Züge, Nope-Fenster, Timer, Sichtbarkeiten)
server/index.js   Express + Socket.IO, Raumverwaltung, Aufräum-Job
public/           Oberfläche (reines HTML/CSS/JS, kein Build-Schritt)
test/             Logik- und Ende-zu-Ende-Tests
```

Der Server ist die einzige Wahrheit: Clients bekommen nur, was sie sehen dürfen –
fremde Handkarten, der Stapelinhalt und der Blick in die Zukunft anderer Spieler
werden nie übertragen.

---

## Rechtliches

OpenKittens ist eine eigenständige Umsetzung einer bekannten Spielmechanik mit eigenen
Kartennamen und eigener Grafik. Es ist **kein** offizielles Produkt und steht in keiner
Verbindung zu den Herausgebern von *Exploding Kittens*. Nur für den privaten Gebrauch
im eigenen Netzwerk gedacht.
