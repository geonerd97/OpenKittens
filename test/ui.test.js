'use strict';

/**
 * Oberflächen-Test mit einem echten Browser (Playwright).
 * Startet den Server im selben Prozess, spielt typische Situationen durch und
 * prüft dabei Layout (auch auf Handy-Breite), Dialoge und Konsolenfehler.
 *
 *   npm run test:ui
 */
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

process.env.PORT = process.env.UI_PORT || '4188';
process.env.PERSIST = '0';
const { server, rooms } = require('../server/index');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const SHOTS = process.env.UI_SHOT_DIR || path.join(__dirname, '..', 'screenshots');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let passed = 0;
let browser;

function step(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

let injected = 0;
const give = (player, id) => {
  const card = { uid: `ui${++injected}`, id };
  player.hand.push(card);
  return card;
};

async function newPage(name, viewport = { width: 1280, height: 860 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(BASE);
  return page;
}

async function shot(page, file) {
  if (!process.env.UI_SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, file) });
}

async function main() {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  console.log('OpenKittens – Oberfläche');

  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
  } catch {
    browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: '/opt/pw-browsers/chromium' });
  }

  /* ------------------------------------------------------- Start und Lobby */
  const a = await newPage('Host');
  await a.fill('#input-name', 'Mia');
  await a.click('#btn-create');
  await a.waitForSelector('#screen-lobby.active');
  const code = (await a.textContent('#lobby-code')).trim();
  assert.match(code, /^\d{4}$/);
  step(`Raum ${code} erstellt`);

  assert.ok(await a.isVisible('#qr svg'), 'QR-Code wird gezeichnet');
  assert.match(await a.textContent('#join-url'), new RegExp(`#${code}$`), 'Beitritts-Link zeigt den Code');
  step('QR-Code und Beitritts-Link in der Lobby');

  const b = await newPage('Gast');
  await b.fill('#input-name', 'Ben');
  await b.fill('#input-code', code);
  await b.click('#btn-join');
  await b.waitForSelector('#screen-lobby.active');
  await wait(200);
  assert.equal((await b.$$('#lobby-players li')).length, 2);
  assert.equal(await b.isDisabled('#settings .opt'), true, 'Gäste können die Regeln nicht ändern');
  step('Zweiter Spieler in der Lobby');

  // Hausregeln setzen: kurzes Nope-Fenster, damit der Test flott bleibt
  await a.click('#settings .setting:nth-child(1) .opt:nth-child(2)'); // Nope-Fenster 3 s
  await a.click('#settings .setting:nth-child(4) .opt:nth-child(1)'); // Standard-Bomben
  await wait(200);
  assert.equal(rooms.get(code).settings.nopeSeconds, 3);
  assert.equal(await a.getAttribute('#settings .setting:nth-child(1) .opt:nth-child(2)', 'aria-pressed'), 'true');
  step('Host ändert die Hausregeln');

  // Dritter Spieler, der gleich wieder entfernt wird
  const c = await newPage('Dritter');
  await c.fill('#input-name', 'Lio');
  await c.fill('#input-code', code);
  await c.click('#btn-join');
  await c.waitForSelector('#screen-lobby.active');
  await wait(200);
  assert.equal((await a.$$('#lobby-players li')).length, 3);
  await a.click('#lobby-players li:last-child button[aria-label="Lio entfernen"]');
  await wait(300);
  assert.equal((await a.$$('#lobby-players li')).length, 2, 'Host hat Lio entfernt');
  await c.close();
  step('Host entfernt einen Spieler aus der Lobby');

  await shot(a, 'lobby.png');

  /* ----------------------------------------------------------- Spielstart */
  await a.click('#btn-start');
  await a.waitForSelector('#screen-game.active');
  await b.waitForSelector('#screen-game.active');
  await wait(300);
  const game = rooms.get(code);
  const pageOf = (player) => (player.name === 'Mia' ? a : b);
  const otherOf = (player) => game.players.find((p) => p.id !== player.id);
  step('Runde gestartet, beide sehen das Spielbrett');

  /* ----------------------------------------------------- Barrierefreiheit */
  assert.equal(await a.getAttribute('#live', 'aria-live'), 'polite', 'Live-Region für Ansagen vorhanden');
  const firstCard = a.locator('#hand .card').first();
  assert.equal(await firstCard.evaluate((el) => el.tagName), 'BUTTON', 'Handkarten sind Buttons');
  assert.equal(await firstCard.getAttribute('aria-pressed'), 'false');
  await firstCard.focus();
  await a.keyboard.press('Enter');
  await wait(200);
  assert.equal(await a.locator('#hand .card[aria-pressed="true"]').count(), 1, 'Karte per Tastatur ausgewählt');
  await a.keyboard.press('Enter');
  await wait(200);
  assert.equal(await a.locator('#hand .card[aria-pressed="true"]').count(), 0, 'Auswahl per Tastatur aufgehoben');
  await a.click('#btn-rules');
  await wait(250);
  assert.equal(await a.isVisible('#modal'), true);
  await a.keyboard.press('Escape');
  await wait(250);
  assert.equal(await a.isVisible('#modal'), false, 'Escape schließt freiwillige Dialoge');
  step('Tastaturbedienung, Live-Region und Escape');

  const playSelected = async (page) => { await page.click('#btn-play'); };
  /** Nope-Fenster abwarten: durchlassen, wenn möglich, sonst auslaufen lassen. */
  const resolveNope = async (page) => {
    await wait(300);
    if (await page.isVisible('#nope-bar') && await page.isEnabled('#btn-pass')) await page.click('#btn-pass');
    await page.waitForSelector('#nope-bar.hidden', { state: 'attached', timeout: 8000 });
    await wait(200);
  };
  const selectCard = async (page, cardName) => {
    await page.click(`#hand .card:has(.cname:text-is("${cardName}"))`);
  };

  /* -------------------------------------------- Nope-Fenster und Zukunft */
  let cur = game.currentPlayer;
  let opp = otherOf(cur);
  opp.hand = opp.hand.filter((x) => x.id !== 'nope');
  give(opp, 'nope');
  cur.hand = cur.hand.filter((x) => x.id !== 'future');
  give(cur, 'future');
  game.hooks.broadcast();
  await wait(200);
  await selectCard(pageOf(cur), 'Blick in die Zukunft');
  await playSelected(pageOf(cur));
  await wait(300);
  assert.ok(await pageOf(opp).isVisible('#nope-bar'), 'Nope-Leiste erscheint beim Gegner');
  assert.match(await pageOf(opp).textContent('#nope-text'), /Blick in die Zukunft/);
  await shot(pageOf(opp), 'nope.png');
  await pageOf(opp).click('#btn-pass');
  await wait(400);
  assert.equal(await pageOf(cur).textContent('#modal-title'), '🔮 Blick in die Zukunft');
  assert.equal((await pageOf(cur).$$('#modal-body .card')).length, 3);
  await pageOf(cur).click('#modal-foot .btn');
  await wait(200);
  step('Nope-Fenster, Durchlassen und Zukunftsblick');

  /* ------------------------------------------- Drei gleiche Katzen fordern */
  opp.hand = [{ uid: 'beute', id: 'attack' }];
  ['cat_beard', 'cat_beard', 'cat_beard'].forEach((id) => give(cur, id));
  game.hooks.broadcast();
  await wait(200);
  for (let i = 0; i < 3; i++) {
    await pageOf(cur).click(`#hand .card:has(.cname:text-is("Bartkatze")) >> nth=${i}`);
  }
  assert.match(await pageOf(cur).textContent('#hand-title'), /Drei gleiche Katzen/);
  await playSelected(pageOf(cur));
  await wait(250);
  assert.match(await pageOf(cur).textContent('#modal-title'), /gegen wen/);
  await pageOf(cur).click('#modal-body .choice');
  await wait(250);
  assert.match(await pageOf(cur).textContent('#modal-title'), /Welche Karte forderst du/);
  await shot(pageOf(cur), 'demand.png');
  await pageOf(cur).click('#modal-body .card:has(.cname:text-is("Angriff"))');
  await wait(300);
  await resolveNope(pageOf(opp));
  assert.equal(cur.hand.some((x) => x.uid === 'beute'), true, 'geforderte Karte ist angekommen');
  step('Drei gleiche Katzen fordern gezielt eine Karte');

  /* --------------------------------- Fünf verschiedene Katzen aus der Ablage */
  game.discard.push('shuffle');
  ['cat_pizza', 'cat_melon', 'cat_beard', 'cat_rainbow', 'cat_potato'].forEach((id) => give(cur, id));
  game.hooks.broadcast();
  await wait(200);
  for (const name of ['Pizzakatze', 'Melonenkatze', 'Bartkatze', 'Regenbogenkatze', 'Kartoffelkatze']) {
    await pageOf(cur).click(`#hand .card:has(.cname:text-is("${name}")) >> nth=0`);
  }
  assert.match(await pageOf(cur).textContent('#hand-title'), /Fünf verschiedene Katzen/);
  await playSelected(pageOf(cur));
  await wait(250);
  assert.match(await pageOf(cur).textContent('#modal-title'), /Welche Karte holst du/);
  await pageOf(cur).click('#modal-body .card:has(.cname:text-is("Mischen"))');
  await wait(300);
  await resolveNope(pageOf(opp));
  assert.equal(cur.hand.some((x) => x.id === 'shuffle'), true, 'Karte aus der Ablage geholt');
  step('Fünf verschiedene Katzen holen aus dem Ablagestapel');

  /* ------------------------------------------------- Bombe und Entschärfung */
  cur = game.currentPlayer;
  if (!cur.hand.some((x) => x.id === 'defuse')) give(cur, 'defuse');
  game.deck.push({ uid: 'boom', id: 'bomb' });
  game.hooks.broadcast();
  await wait(200);
  await pageOf(cur).click('#btn-draw');
  await wait(500);
  assert.match(await pageOf(cur).textContent('#modal-title'), /Bombe entschärft/);
  await shot(pageOf(cur), 'defuse.png');
  await pageOf(cur).click('#modal-foot .btn.primary');
  await wait(300);
  assert.equal(game.deck.some((x) => x.id === 'bomb'), true, 'Bombe liegt wieder im Stapel');
  step('Bombe ziehen, entschärfen und zurückstecken');

  /* ------------------------------------------------------------ Verlauf */
  await a.setViewportSize({ width: 390, height: 780 });
  await wait(450);
  assert.equal(await a.isVisible('#log-panel'), false, 'Verlauf ist auf dem Handy eingeklappt');
  await a.click('#btn-log');
  await wait(350);
  assert.equal(await a.isVisible('#log-panel'), true, 'Verlauf lässt sich aufklappen');
  assert.ok((await a.$$('#log li')).length > 3, 'Verlauf hat Einträge');
  await shot(a, 'mobile-log.png');
  await a.click('#btn-log-close');
  await wait(300);
  step('Verlauf als Schublade auf Handy-Breite');

  /* ------------------------------------------------- Layout auf dem Handy */
  for (const size of [{ width: 360, height: 740 }, { width: 390, height: 844 }, { width: 414, height: 896 }]) {
    await a.setViewportSize(size);
    await wait(250);
    const overflow = await a.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `kein horizontales Scrollen bei ${size.width}px (${overflow}px)`);
    const drawBox = await a.locator('#btn-draw').boundingBox();
    assert.ok(drawBox && drawBox.height >= 44, 'Aktionsbuttons sind groß genug zum Tippen');
    assert.ok(drawBox.y + drawBox.height <= size.height + 1, 'Aktionsleiste liegt im sichtbaren Bereich');
  }
  await shot(a, 'mobile-game.png');
  step('Handy-Layout ohne Überlauf, Buttons erreichbar');

  // Für die Layoutprüfung braucht die Hand ein paar Karten
  const mia = game.players.find((p) => p.name === 'Mia');
  if (mia.hand.length < 6) ['skip', 'attack', 'shuffle', 'future', 'favor', 'nope'].forEach((id) => give(mia, id));
  game.hooks.broadcast();
  await a.waitForSelector('#hand .card');
  const handCard = await a.locator('#hand .card').first().boundingBox();
  assert.ok(handCard.width >= 80 && handCard.height >= 100, 'Handkarten bleiben antippbar');
  step('Handkarten groß genug');

  /* Auswahl der letzten Handkarte darf das Layout nicht verschieben */
  const handCount = (await a.$$('#hand .card')).length;
  if (handCount > 1) {
    await a.click(`#hand .card >> nth=${handCount - 1}`);
    await wait(250);
    const shifted = await a.evaluate(() => {
      const screen = document.getElementById('screen-game');
      const bar = document.querySelector('.action-bar').getBoundingClientRect();
      return { left: screen.scrollLeft, top: screen.scrollTop, barLeft: Math.round(bar.left), barRight: Math.round(bar.right), w: window.innerWidth };
    });
    assert.equal(shifted.left, 0, 'das Spielfeld ist nicht seitlich verschoben');
    assert.equal(shifted.top, 0, 'das Spielfeld ist nicht vertikal verschoben');
    assert.ok(shifted.barLeft >= -1 && shifted.barRight <= shifted.w + 1,
      `Aktionsleiste bleibt im Bild (${shifted.barLeft}…${shifted.barRight} von ${shifted.w})`);
    await a.click(`#hand .card >> nth=${handCount - 1}`);
  }
  step('Kartenauswahl verschiebt das Layout nicht');

  /* --------------------------------------------------------- Spielende */
  await a.setViewportSize({ width: 1280, height: 860 });
  cur = game.currentPlayer;
  opp = otherOf(cur);
  cur.hand = cur.hand.filter((x) => x.id !== 'defuse');
  game.deck = game.deck.filter((x) => x.id !== 'bomb');
  game.deck.push({ uid: 'boom2', id: 'bomb' });
  game.hooks.broadcast();
  await wait(200);
  await pageOf(cur).click('#btn-draw');
  await wait(250);
  assert.match(await pageOf(opp).textContent('#fx-layer .fx-pop'), /explodiert/, 'Explosionseffekt wird angezeigt');
  await wait(600);
  assert.match(await pageOf(opp).textContent('#modal-title'), /gewonnen/);
  assert.equal(await pageOf(cur).textContent('#modal-title'), '💥 Runde beendet');
  await shot(pageOf(opp), 'winner.png');
  step('Explosion beendet die Runde mit Gewinner-Dialog');

  const hostPage = game.hostId === cur.id ? pageOf(cur) : pageOf(opp);
  await hostPage.click('#modal-foot .btn.primary');
  await wait(400);
  assert.ok(await hostPage.isVisible('#screen-lobby.active'), 'Host kommt zurück in die Lobby');
  step('Neue Runde über die Lobby');

  /* ------------------------------------------------------- Solo gegen Bot */
  const solo = await newPage('Solo');
  await solo.fill('#input-name', 'Allein');
  await solo.click('#btn-create');
  await solo.waitForSelector('#screen-lobby.active');
  const soloCode = (await solo.textContent('#lobby-code')).trim();
  assert.equal(await solo.isDisabled('#btn-start'), true, 'allein lässt sich nicht starten');
  await solo.click('#btn-add-bot');
  await wait(300);
  assert.equal((await solo.$$('#lobby-players li')).length, 2, 'Bot sitzt am Tisch');
  await solo.click('#lobby-players li:last-child .bot-levels .opt:last-child'); // schlau
  await wait(250);
  const soloGame = rooms.get(soloCode);
  const botPlayer = soloGame.players.find((p) => p.bot);
  assert.equal(botPlayer.level, 'smart', 'Spielstärke umgestellt');
  assert.equal(await solo.isDisabled('#btn-start'), false, 'mit Bot kann gestartet werden');
  step('Bot in der Lobby hinzufügen und einstellen');

  await solo.click('#btn-start');
  await solo.waitForSelector('#screen-game.active');
  await wait(400);
  await shot(solo, 'solo.png');

  // Mensch zieht einfach immer; der Bot muss von allein spielen
  let botMoves = 0;
  for (let i = 0; i < 60 && botMoves < 3; i++) {
    if (await solo.isVisible('#modal')) {
      const confirm = solo.locator('#modal-foot .btn.primary');
      if (await confirm.count()) await confirm.click();
      else await solo.locator('#modal-body .card').first().click();
      await wait(200);
      continue;
    }
    if (await solo.isVisible('#nope-bar') && await solo.isEnabled('#btn-pass')) {
      await solo.click('#btn-pass');
    } else if (await solo.isEnabled('#btn-draw')) {
      await solo.click('#btn-draw');
    }
    await wait(500);
    botMoves = (await solo.$$eval('#log li', (nodes) => nodes.map((n) => n.textContent)))
      .filter((line) => line.startsWith(botPlayer.name)).length;
    if (soloGame.phase !== 'playing') break;
  }
  assert.ok(botMoves >= 3, `der Bot spielt von allein (${botMoves} Aktionen im Verlauf)`);
  step('Solo-Partie: der Bot zieht und spielt selbstständig');

  assert.deepEqual(errors, [], `Konsolenfehler: ${errors.join(' | ')}`);
  step('Keine Konsolenfehler');

  await browser.close();
  server.close();
  console.log(`\n${passed} Prüfungen erfolgreich.`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nOberflächen-Test fehlgeschlagen:', err.message);
  if (errors.length) console.error('Konsolenfehler:', errors.join(' | '));
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
