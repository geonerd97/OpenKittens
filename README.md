# 🐱 OpenKittens

Ein Kartenspiel im Stil von *Exploding Kittens* zum Selbsthosten – gedacht für einen
Abend im eigenen WLAN: ein Rechner startet den Server, alle anderen öffnen die Adresse
im Browser (oder scannen den QR-Code) und tippen einen **vierstelligen Raumcode** plus
ihren Namen ein. **Kein Konto, keine Registrierung, keine Cloud.**

```
┌─────────────┐   WLAN/LAN    ┌──────────────────────┐
│ Handy, Tab, │ ───────────▶  │ Docker-Container     │
│ Laptop …    │  HTTP + WS    │ Node + Socket.IO     │
└─────────────┘               │ Spielstand im RAM    │
                              └──────────────────────┘
```

Die Oberfläche ist für Handys gebaut (große Tippflächen, Hochkant und Quer, Verlauf als
Schublade) und wächst auf größeren Bildschirmen zum Zwei-Spalten-Layout.

---

## Schnellstart

Voraussetzung: Docker mit Compose-Plugin (Docker Desktop oder `docker-compose-plugin`).

```bash
git clone https://github.com/geonerd97/OpenKittens.git
cd OpenKittens
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

1. Eine Person klickt **„Neuen Raum erstellen"** und bekommt einen vierstelligen Code.
2. In der Lobby steht ein **QR-Code** mit genau diesem Beitritts-Link – einmal scannen,
   fertig. Alternativ: Adresse aufrufen, Name und Code eintippen.
3. Der Host stellt bei Bedarf die Hausregeln ein und startet ab zwei Spielern (max. 8).

> Firewall: Unter Windows/macOS muss Port 3333 eingehend erlaubt sein, sonst sehen die
> anderen Geräte den Server nicht.

### Stoppen, Logs, Update

```bash
docker compose logs -f         # Logs ansehen
docker compose restart         # Neustart (laufende Runden werden wiederhergestellt)
docker compose down            # Stoppen und Container entfernen
docker compose down -v         # zusätzlich gespeicherte Spielstände löschen
docker compose up -d --build   # nach Code-Änderungen neu bauen
```

### Anderer Port

Wenn 3333 schon belegt ist, in `docker-compose.yml` nur die linke Seite ändern:

```yaml
ports:
  - "8080:3333"      # erreichbar unter http://<ip>:8080
```

---

## Auf dem Raspberry Pi

Läuft auf jedem Pi – das Node-Image gibt es für `arm64` (Pi 3/4/5 mit 64-Bit-System),
`armv7` (32-Bit-System) und `armv6` (Pi Zero/1). Welche Architektur dein Pi fährt,
zeigt `uname -m`.

### Mit Docker (empfohlen)

```bash
# 1. Docker einmalig installieren
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# danach einmal ab- und wieder anmelden (oder: newgrp docker)

# 2. Spiel holen und starten
git clone https://github.com/geonerd97/OpenKittens.git
cd OpenKittens
docker compose up -d --build
```

Der erste Build dauert auf einem Pi je nach Modell zwei bis zehn Minuten, danach
startet der Container in Sekunden. Durch `restart: unless-stopped` kommt er nach
einem Stromausfall oder Neustart des Pi von allein wieder hoch.

```bash
hostname -I            # IP-Adresse des Pi herausfinden
docker compose logs -f # Logs
docker compose ps      # läuft es?
```

Aufrufen lässt sich das Spiel dann unter `http://<ip-des-pi>:3333` – und auf den
meisten Geräten auch unter `http://raspberrypi.local:3333`, solange der Pi seinen
Standardnamen hat (Avahi/Bonjour ist auf Raspberry Pi OS vorinstalliert).

**Update:**

```bash
cd OpenKittens && git pull && docker compose up -d --build
```

### Ohne Docker (schlanker, startet schneller)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/geonerd97/OpenKittens.git
cd OpenKittens
npm ci --omit=dev

sudo cp deploy/openkittens.service /etc/systemd/system/
sudo nano /etc/systemd/system/openkittens.service   # Benutzer und Pfade prüfen
sudo systemctl daemon-reload
sudo systemctl enable --now openkittens
systemctl status openkittens
```

Die mitgelieferte Unit liegt unter `deploy/openkittens.service` und ist auf den
Benutzer `pi` und `/home/pi/OpenKittens` eingestellt – beides gegebenenfalls anpassen.
Logs kommen mit `journalctl -u openkittens -f`.

### Gut zu wissen

* **Speicherbedarf** liegt im Betrieb bei ungefähr 70 MB, das Spiel läuft also auch
  auf einem Pi Zero 2 W problemlos.
* **Firewall:** Raspberry Pi OS hat standardmäßig keine aktive Firewall. Falls du
  `ufw` nutzt: `sudo ufw allow 3333/tcp`.
* **Fester Platz im Netz:** Eine feste IP oder ein DHCP-Reservierungseintrag im Router
  spart das Suchen vor jeder Spielrunde.

---

## Spielregeln

Ziel: **Als Letzte(r) übrig bleiben.**

Wenn du am Zug bist, darfst du beliebig viele Karten ausspielen und **musst danach eine
Karte ziehen** – damit endet dein Zug.

| Karte | | Wirkung |
| --- | --- | --- |
| Explodierendes Kätzchen | 💥 | Wer es zieht und keine Entschärfung hat, scheidet aus. Standard: *Spielerzahl − 1* Bomben. |
| Entschärfung | 🧯 | Wird automatisch eingesetzt, wenn du eine Bombe ziehst. Danach steckst du die Bombe heimlich an eine beliebige Stelle im Stapel zurück. |
| Überspringen | 🏃 | Zug beenden, ohne zu ziehen. |
| Angriff | ⚔️ | Dein Zug endet sofort, der Nächste muss **zwei** Züge machen (stapelt sich). |
| Mischen | 🔀 | Nachziehstapel neu mischen. |
| Blick in die Zukunft | 🔮 | Du siehst heimlich die obersten drei Karten. |
| Gefallen | 🙏 | Ein Mitspieler deiner Wahl gibt dir eine Karte – er sucht sie aus. |
| Nope | 🚫 | Hebt die zuletzt gespielte Aktion auf, auch außerhalb deines Zuges und auch auf eigene Karten. Ein zweites Nope hebt das Nope wieder auf. |
| Katzenkarten | 🍕🍉🧔🌈🥔 | Allein wirkungslos, aber in Kombination stark (siehe unten). |

**Katzen-Kombinationen**

| Auswahl | Wirkung |
| --- | --- |
| zwei gleiche | zufällige Karte eines Mitspielers klauen |
| drei gleiche | Karte **ansagen** – hat der Mitspieler sie, muss er sie herausgeben |
| fünf verschiedene | beliebige Karte aus dem **Ablagestapel** nehmen |

**Nope-Fenster:** Nach jeder Aktionskarte läuft unten ein Balken (einstellbar, Standard
6 Sekunden). Wer eine Nope-Karte hat, kann in dieser Zeit „Nope!" oder „Durchlassen"
klicken. Haben alle durchgelassen oder hat niemand ein Nope, wird sofort ausgeführt.

**Start:** Jeder bekommt 7 zufällige Karten (einstellbar) plus 1 Entschärfung, dann
kommen die restlichen Entschärfungen und die Bomben in den Stapel.

---

## Allein gegen Computergegner

In der Lobby legt der Host mit **🤖 Bot hinzufügen** beliebig viele Bots an (bis
insgesamt 8 Spieler). Ein Mensch und ein Bot reichen zum Starten – ganz allein geht
es nicht, Bots spielen nur, solange jemand zuschaut.

| Stufe | Verhalten |
| --- | --- |
| leicht | zieht meistens einfach, spielt Karten eher zufällig, nopet selten |
| normal | weicht Bomben mit Überspringen und Angriff aus, klaut mit Katzenpaaren, nopet Aktionen, die gegen ihn gehen |
| schlau | nutzt den Blick in die Zukunft, zieht bei sicherem Stapel statt Karten zu verschwenden, fordert gezielt Entschärfungen, versteckt die entschärfte Bombe direkt vor dem nächsten Spieler und kontert Angriffe auf sich |

Die Stufe lässt sich je Bot einzeln umstellen, auch zwischen zwei Runden. Bots
entscheiden nur mit dem, was auch ein Mensch am Tisch wüsste: eigene Hand, Stapel-
und Ablagegröße, Kartenzahl der anderen und der eigene Zukunftsblick – sie schauen
nie in den Nachziehstapel oder in fremde Hände.

---

## Hausregeln (Lobby, nur Host)

| Einstellung | Auswahl | Bedeutung |
| --- | --- | --- |
| Nope-Fenster | sofort / 3 / 6 / 10 s | Bedenkzeit für Nope-Karten |
| Zeit pro Zug | ohne Limit / 30 / 60 / 90 / 120 s | danach zieht der Server automatisch |
| Startkarten | 5 – 10 | Handkarten zu Beginn, zusätzlich zur Entschärfung |
| Stapelgröße | klein / mittel / groß | wie dick der Nachziehstapel wird – er wächst mit der Spielerzahl mit |
| Zusatzbomben | Standard / +1 / +2 / +3 | mehr Bomben als „Spielerzahl − 1" |

Der Nachziehstapel richtet sich nach der Runde: zu zweit sind es bei „mittel" rund
20 Karten, zu viert rund 35, zu acht rund 65. Die Lobby zeigt vor dem Start, wie
viele Karten und Bomben es werden. Für eine schnelle Partie „klein" wählen, für
einen langen Abend „groß".

---

## Praktisches

* **Reconnect:** Der Browser merkt sich pro Raum einen Token. Wer die Seite neu lädt oder
  kurz das WLAN verliert, landet mit derselben Hand wieder im Spiel.
* **Offline-Spieler:** Ist jemand länger weg, zieht der Server nach 20 Sekunden
  automatisch für ihn. Der Host kann offline Spieler zusätzlich aus der Runde nehmen
  (in der Lobby jeden, im laufenden Spiel nur offline Spieler).
* **Später dazugekommen?** Wer mitten in einer Runde beitritt, schaut zu und ist in der
  nächsten Runde dabei.
* **Neustart:** Laufende Runden werden alle paar Sekunden gesichert und nach einem
  Container-Neustart wiederhergestellt (offene Nope-Fenster verfallen dabei).
* **Kartenstapel:** Gleiche Karten liegen in der Hand als ein Stapel mit Anzahl
  (`×3`). Jeder Tipp nimmt eine Karte mehr aus dem Stapel in die Auswahl, ein
  weiterer Tipp legt alle zurück – für Katzenpaare und Dreier reicht also mehrfaches
  Antippen derselben Karte.
* **Animationen:** Deine gezogene Karte fliegt vom Stapel hoch, bleibt kurz groß
  stehen, damit du sie lesen kannst, und wandert dann in die Hand – die Mitspieler
  sehen nur eine verdeckte Karte zu dir fliegen. Ausgespielte Karten fliegen offen
  zur Ablage, geklaute und geschenkte Karten verdeckt von Spieler zu Spieler,
  Mischen dreht den Stapel. Wer `prefers-reduced-motion` eingestellt hat, bekommt
  stattdessen schlichte Hinweise.
* **Ton und Effekte:** Explosion, Nope, Klauen und Sieg haben kurze Soundeffekte –
  abschaltbar über 🔊 in der Kopfleiste, die Einstellung bleibt im Browser gespeichert.
* **Bedienung ohne Maus:** Karten lassen sich per Tab und Enter auswählen, Dialoge mit
  Escape schließen; Zugwechsel und Effekte werden für Screenreader angesagt.
* **Räume** liegen im Arbeitsspeicher und werden nach 3 Stunden ohne Verbindung
  aufgeräumt (`ROOM_TTL_MINUTES`).

### Konfiguration (Umgebungsvariablen)

| Variable              | Standard     | Bedeutung                                        |
| --------------------- | ------------ | ------------------------------------------------ |
| `PORT`                | `3333`       | Port im Container                                |
| `HOST`                | `0.0.0.0`    | Listen-Adresse                                   |
| `ROOM_TTL_MINUTES`    | `180`        | Aufräumen leerer Räume nach x Minuten             |
| `PERSIST`             | `1`          | `0` schaltet das Sichern der Spielstände ab       |
| `DATA_DIR`            | `/app/data`  | Ablage für `rooms.json`                          |
| `MAX_ROOMS`           | `100`        | Obergrenze gleichzeitiger Räume                  |
| `MAX_ROOMS_PER_SOCKET`| `5`          | wie viele Räume eine Verbindung anlegen darf     |

Zusätzlich gibt es `GET /health` für Monitoring und den Compose-Healthcheck.

---

## Entwicklung ohne Docker

```bash
npm install
npm start           # http://localhost:3333
npm run dev         # mit automatischem Neustart (node --watch)

npm test            # Spiellogik (Deck, Nope, Kombis, Timer, Momentaufnahme)
npm run test:e2e    # echte Socket.IO-Runde mit drei simulierten Clients
npm run test:ui     # Browser-Test mit Playwright (Lobby, Dialoge, Handy-Layout)
npm run test:all    # alles nacheinander
```

Für `test:ui` einmalig den Browser holen: `npx playwright install chromium`.
Mit `UI_SHOTS=1 npm run test:ui` landen Screenshots in `screenshots/`.

### Aufbau

```
server/cards.js   Kartendefinitionen und Deckzusammenstellung
server/bot.js     Entscheidungen der Computergegner (drei Spielstärken)
server/game.js    Spiellogik: Züge, Nope-Fenster, Kombis, Timer, Sichtbarkeiten
server/index.js   Express + Socket.IO, Raumverwaltung, Persistenz, Aufräum-Job
public/           Oberfläche (HTML/CSS/JS ohne Build-Schritt)
public/vendor/    qrcode-generator (MIT) für den QR-Code in der Lobby
deploy/           systemd-Unit für den Betrieb ohne Docker
test/             Logik-, Netzwerk- und Oberflächentests
.github/workflows CI: Tests plus Docker-Build mit Smoke-Test
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
