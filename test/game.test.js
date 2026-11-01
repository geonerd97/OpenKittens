'use strict';

/**
 * Logik-Tests ohne Netzwerk: die Game-Klasse wird direkt gesteuert.
 * Das Nope-Fenster wird in den Tests sofort aufgelöst (_resolvePending).
 */
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const botBrain = require('../server/bot');

let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

async function runAll() {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}\n    ${err.message}`);
      process.exitCode = 1;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hooks = () => ({ broadcast: () => {}, toPlayer: () => {} });

function makeGame(names) {
  const game = new Game('1234', hooks());
  names.forEach((name, i) => game.addPlayer({ name, token: `t${i}`, socketId: `s${i}` }));
  return game;
}

function startedGame(names) {
  const game = makeGame(names);
  game.start(game.hostId);
  return game;
}

/** Gibt dem Spieler genau diese Karte in die Hand und liefert deren uid. */
function giveCard(game, player, id) {
  const card = { uid: `fix_${id}_${Math.random().toString(36).slice(2)}`, id };
  player.hand.push(card);
  return card.uid;
}

function resolve(game) {
  game._resolvePending();
}

console.log('OpenKittens – Spiellogik');

test('Startaufstellung: Hände, Bomben und Entschärfungen stimmen', () => {
  const game = startedGame(['A', 'B', 'C', 'D']);
  assert.equal(game.phase, 'playing');
  game.players.forEach((p) => {
    assert.equal(p.hand.length, 8, 'jede Hand hat 8 Karten');
    assert.equal(p.hand.filter((c) => c.id === 'defuse').length, 1, 'genau eine Entschärfung je Hand');
  });
  const plan = game.deckPlan(4);
  assert.equal(game.deck.length, plan.deckCards, 'Stapel entspricht der Planung');
  assert.equal(game.deck.filter((c) => c.id === 'bomb').length, 3, 'Spieleranzahl minus 1 Bomben');
  assert.equal(game.deck.filter((c) => c.id === 'defuse').length, plan.extraDefuses, 'übrige Entschärfungen im Stapel');
  const allCards = [...game.deck, ...game.players.flatMap((p) => p.hand)];
  assert.ok(allCards.filter((c) => c.id === 'nope').length >= 2, 'genug Nope-Karten im Spiel');
  game.dispose();
});

test('Der Stapel wächst mit der Spielerzahl und folgt der Hausregel', () => {
  const sizes = {};
  [2, 4, 8].forEach((count) => {
    const game = startedGame(Array.from({ length: count }, (_, i) => `P${i}`));
    sizes[count] = game.deck.length;
    assert.equal(game.deck.length, game.deckPlan(count).deckCards);
    game.dispose();
  });
  assert.ok(sizes[2] < sizes[4] && sizes[4] < sizes[8], `Stapel wächst: ${JSON.stringify(sizes)}`);
  assert.ok(sizes[2] < 30, `zu zweit bleibt es kurz (${sizes[2]} Karten)`);

  const klein = makeGame(['A', 'B', 'C']);
  klein.updateSettings(klein.hostId, { deckSize: 4 });
  klein.start(klein.hostId);
  const gross = makeGame(['A', 'B', 'C']);
  gross.updateSettings(gross.hostId, { deckSize: 9 });
  gross.start(gross.hostId);
  assert.ok(gross.deck.length > klein.deck.length * 1.5,
    `groß ist deutlich dicker als klein (${klein.deck.length} vs. ${gross.deck.length})`);
  const lobby = makeGame(['A', 'B']);
  assert.throws(() => lobby.updateSettings(lobby.hostId, { deckSize: 99 }), /Ungültig/);
  lobby.dispose();
  klein.dispose();
  gross.dispose();
});

test('Auch der kleinste Stapel bleibt spielbar', () => {
  const game = makeGame(['A', 'B']);
  game.updateSettings(game.hostId, { deckSize: 4, startCards: 5 });
  game.start(game.hostId);
  const all = [...game.deck.map((c) => c.id), ...game.players.flatMap((p) => p.hand.map((c) => c.id))];
  const count = (id) => all.filter((x) => x === id).length;
  assert.ok(count('nope') >= 2, 'Nope ist dabei');
  assert.ok(count('skip') >= 2, 'Überspringen ist dabei');
  assert.ok(count('cat_pizza') >= 2, 'Katzenpaare sind möglich');
  assert.equal(count('bomb'), 1);
  game.dispose();
});

test('Nur der Spieler am Zug darf Aktionskarten spielen', () => {
  const game = startedGame(['A', 'B']);
  const other = game.players.find((p) => p.id !== game.currentPlayer.id);
  const uid = giveCard(game, other, 'skip');
  assert.throws(() => game.playCards(other.id, [uid]), /nicht am Zug/);
  game.dispose();
});

test('Überspringen beendet den Zug ohne zu ziehen', () => {
  const game = startedGame(['A', 'B', 'C']);
  const cur = game.currentPlayer;
  const uid = giveCard(game, cur, 'skip');
  const deckBefore = game.deck.length;
  game.playCards(cur.id, [uid]);
  resolve(game);
  assert.equal(game.deck.length, deckBefore, 'keine Karte gezogen');
  assert.notEqual(game.currentPlayer.id, cur.id, 'nächster Spieler ist dran');
  game.dispose();
});

test('Angriff verschiebt zwei Züge auf den nächsten Spieler', () => {
  const game = startedGame(['A', 'B', 'C']);
  const cur = game.currentPlayer;
  const uid = giveCard(game, cur, 'attack');
  game.playCards(cur.id, [uid]);
  resolve(game);
  assert.notEqual(game.currentPlayer.id, cur.id);
  assert.equal(game.currentPlayer.turnsLeft, 2, 'Opfer hat zwei Züge');
  const victim = game.currentPlayer;
  game.deck.push({ uid: 'safe1', id: 'skip' });
  game.draw(victim.id);
  assert.equal(game.currentPlayer.id, victim.id, 'nach dem ersten Zug noch nicht fertig');
  assert.equal(victim.turnsLeft, 1);
  game.deck.push({ uid: 'safe2', id: 'skip' });
  game.draw(victim.id);
  assert.notEqual(game.currentPlayer.id, victim.id, 'nach zwei Zügen weitergegeben');
  game.dispose();
});

test('Nope hebt die Aktion auf, zweites Nope macht sie wieder gültig', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  other.hand = other.hand.filter((c) => c.id !== 'nope');
  const skipUid = giveCard(game, cur, 'skip');
  const nopeUid = giveCard(game, other, 'nope');
  game.playCards(cur.id, [skipUid]);
  game.playNope(other.id);
  assert.equal(other.hand.some((c) => c.uid === nopeUid), false, 'Nope ist abgelegt');
  resolve(game);
  assert.equal(game.currentPlayer.id, cur.id, 'Überspringen wurde aufgehoben, Spieler bleibt am Zug');

  const skip2 = giveCard(game, cur, 'skip');
  giveCard(game, other, 'nope');
  cur.hand = cur.hand.filter((c) => c.id !== 'nope');
  const yope = giveCard(game, cur, 'nope');
  game.playCards(cur.id, [skip2]);
  game.playNope(other.id);
  game.playNope(cur.id);
  assert.equal(cur.hand.some((c) => c.uid === yope), false);
  resolve(game);
  assert.notEqual(game.currentPlayer.id, cur.id, 'Yope macht das Überspringen wieder gültig');
  game.dispose();
});

test('Zwei gleiche Katzen klauen eine Karte', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  other.hand = [{ uid: 'beute', id: 'shuffle' }];
  const a = giveCard(game, cur, 'cat_pizza');
  const b = giveCard(game, cur, 'cat_pizza');
  const before = cur.hand.length;
  game.playCards(cur.id, [a, b], { targetId: other.id });
  resolve(game);
  assert.equal(other.hand.length, 0, 'Opfer hat die Karte verloren');
  assert.equal(cur.hand.length, before - 2 + 1, 'zwei Katzen weg, eine Beute dazu');
  assert.equal(cur.hand.some((c) => c.uid === 'beute'), true);
  game.dispose();
});

test('Unterschiedliche Katzen sind nicht spielbar', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  const a = giveCard(game, cur, 'cat_pizza');
  const b = giveCard(game, cur, 'cat_melon');
  assert.throws(() => game.playCards(cur.id, [a, b], { targetId: other.id }), /nicht spielbar/);
  game.dispose();
});

test('Gefallen fragt das Ziel, welche Karte es abgibt', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  other.hand = [{ uid: 'gabe', id: 'future' }, { uid: 'bleibt', id: 'skip' }];
  const uid = giveCard(game, cur, 'favor');
  game.playCards(cur.id, [uid], { targetId: other.id });
  resolve(game);
  assert.equal(game.prompt.type, 'favor');
  assert.equal(game.prompt.playerId, other.id);
  game.respondPrompt(other.id, { uid: 'gabe' });
  assert.equal(cur.hand.some((c) => c.uid === 'gabe'), true);
  assert.equal(other.hand.length, 1);
  assert.equal(game.currentPlayer.id, cur.id, 'der Zug läuft weiter');
  game.dispose();
});

test('Blick in die Zukunft zeigt genau dem Spieler die obersten drei Karten', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  game.deck.push({ uid: 'x1', id: 'skip' }, { uid: 'x2', id: 'attack' }, { uid: 'x3', id: 'bomb' });
  const uid = giveCard(game, cur, 'future');
  game.playCards(cur.id, [uid]);
  resolve(game);
  assert.deepEqual(game.peeks[cur.id], ['bomb', 'attack', 'skip'], 'oberste Karte zuerst');
  assert.equal(game.viewFor(cur.id).peek.length, 3);
  const other = game.players.find((p) => p.id !== cur.id);
  assert.equal(game.viewFor(other.id).peek, null, 'Mitspieler sehen nichts');
  game.dispose();
});

test('Bombe ziehen: mit Entschärfung zurückstecken, ohne fliegt man raus', () => {
  const game = startedGame(['A', 'B', 'C']);
  const cur = game.currentPlayer;
  assert.equal(cur.hand.filter((c) => c.id === 'defuse').length, 1);
  game.deck.push({ uid: 'boom', id: 'bomb' });
  game.draw(cur.id);
  assert.equal(game.prompt.type, 'defuse', 'Entschärfung wird automatisch eingesetzt');
  assert.equal(cur.hand.filter((c) => c.id === 'defuse').length, 0, 'Entschärfung verbraucht');
  game.respondPrompt(cur.id, { position: 0 });
  assert.equal(game.deck[game.deck.length - 1].id, 'bomb', 'Bombe liegt wieder oben');
  assert.equal(cur.alive, true);
  assert.notEqual(game.currentPlayer.id, cur.id, 'Zug ist beendet');

  const victim = game.currentPlayer;
  victim.hand = victim.hand.filter((c) => c.id !== 'defuse');
  game.draw(victim.id);
  assert.equal(victim.alive, false, 'ohne Entschärfung ausgeschieden');
  assert.equal(victim.hand.length, 0, 'Hand wandert auf den Ablagestapel');
  assert.notEqual(game.currentPlayer.id, victim.id);
  game.dispose();
});

test('Die letzte überlebende Katze gewinnt', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  cur.hand = cur.hand.filter((c) => c.id !== 'defuse');
  game.deck.push({ uid: 'boom', id: 'bomb' });
  game.draw(cur.id);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winnerId, other.id);
  assert.equal(game.viewFor(other.id).winnerName, other.name);
  game.dispose();
});

test('Offene Entscheidungen blockieren andere Aktionen', () => {
  const game = startedGame(['A', 'B', 'C']);
  const cur = game.currentPlayer;
  game.deck.push({ uid: 'boom', id: 'bomb' });
  game.draw(cur.id);
  assert.equal(game.prompt.type, 'defuse');
  assert.throws(() => game.draw(cur.id), /Entscheidung/);
  const uid = giveCard(game, cur, 'skip');
  assert.throws(() => game.playCards(cur.id, [uid]), /Entscheidung/);
  game.dispose();
});

test('Mitspieler, die während des Spiels beitreten, sind Zuschauer', () => {
  const game = startedGame(['A', 'B']);
  const late = game.addPlayer({ name: 'C', token: 'tc', socketId: 'sc' });
  assert.equal(late.spectator, true);
  assert.equal(late.alive, false);
  assert.throws(() => game.playCards(late.id, ['x']), /Zuschauer/);
  game.resetToLobby(game.hostId);
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.find((p) => p.id === late.id).spectator, false);
  game.dispose();
});

test('Zufallsspiel mit 5 Spielern endet mit genau einem Gewinner', () => {
  for (let round = 0; round < 25; round++) {
    const game = startedGame(['A', 'B', 'C', 'D', 'E']);
    let steps = 0;
    while (game.phase === 'playing' && steps++ < 4000) {
      if (game.prompt) {
        const prompt = game.prompt;
        const owner = game.findById(prompt.playerId);
        if (prompt.type === 'defuse') {
          game.respondPrompt(owner.id, { position: Math.floor(Math.random() * (game.deck.length + 1)) });
        } else {
          game.respondPrompt(owner.id, { uid: owner.hand.length ? owner.hand[0].uid : null });
        }
        continue;
      }
      if (game.pending) {
        const candidates = game._nopeCandidates();
        if (candidates.length && Math.random() < 0.3) game.playNope(candidates[0].id);
        else resolve(game);
        continue;
      }
      const cur = game.currentPlayer;
      const playable = cur.hand.filter((c) => ['skip', 'attack', 'shuffle', 'future', 'favor'].includes(c.id));
      const cats = {};
      cur.hand.filter((c) => c.id.startsWith('cat_')).forEach((c) => { (cats[c.id] = cats[c.id] || []).push(c); });
      const pair = Object.values(cats).find((list) => list.length >= 2);
      const others = game.alivePlayers.filter((p) => p.id !== cur.id);
      if (pair && Math.random() < 0.4 && others.length) {
        game.playCards(cur.id, [pair[0].uid, pair[1].uid], { targetId: others[0].id });
      } else if (playable.length && Math.random() < 0.5) {
        const card = playable[Math.floor(Math.random() * playable.length)];
        const opts = card.id === 'favor' ? { targetId: others[0] && others[0].id } : {};
        try { game.playCards(cur.id, [card.uid], opts); } catch { game.draw(cur.id); }
      } else {
        game.draw(cur.id);
      }
    }
    assert.equal(game.phase, 'finished', `Runde ${round} endet (Schritte: ${steps})`);
    assert.equal(game.alivePlayers.length, 1, 'genau ein Überlebender');
    game.dispose();
  }
});



/* ------------------------------------------------------- Erweiterte Regeln */

test('Drei gleiche Katzen fordern gezielt eine Karte an', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  other.hand = [{ uid: 'wunsch', id: 'attack' }, { uid: 'rest', id: 'shuffle' }];
  const uids = ['cat_beard', 'cat_beard', 'cat_beard'].map((id) => giveCard(game, cur, id));
  game.playCards(cur.id, uids, { targetId: other.id, demandCardId: 'attack' });
  resolve(game);
  assert.equal(cur.hand.some((c) => c.uid === 'wunsch'), true, 'geforderte Karte erhalten');
  assert.equal(other.hand.length, 1);

  const futureBefore = cur.hand.filter((c) => c.id === 'future').length;
  const otherBefore = other.hand.length;
  const uids2 = ['cat_melon', 'cat_melon', 'cat_melon'].map((id) => giveCard(game, cur, id));
  game.playCards(cur.id, uids2, { targetId: other.id, demandCardId: 'future' });
  resolve(game);
  assert.equal(cur.hand.filter((c) => c.id === 'future').length, futureBefore, 'nicht vorhandene Karte bringt nichts ein');
  assert.equal(other.hand.length, otherBefore, 'beim Ziel ändert sich nichts');
  game.dispose();
});

test('Drei Katzen ohne Ansage sind ungültig', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  const uids = ['cat_potato', 'cat_potato', 'cat_potato'].map((id) => giveCard(game, cur, id));
  assert.throws(() => game.playCards(cur.id, uids, { targetId: other.id }), /Sag an/);
  game.dispose();
});

test('Fünf verschiedene Katzen holen eine Karte aus dem Ablagestapel', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  game.discard.push('attack', 'shuffle');
  const uids = ['cat_pizza', 'cat_melon', 'cat_beard', 'cat_rainbow', 'cat_potato']
    .map((id) => giveCard(game, cur, id));
  assert.throws(() => game.playCards(cur.id, uids, { discardCardId: 'future' }), /Ablagestapel/);
  game.playCards(cur.id, uids, { discardCardId: 'attack' });
  resolve(game);
  assert.equal(cur.hand.some((c) => c.id === 'attack'), true, 'Karte aus der Ablage geholt');
  assert.equal(game.discard.filter((id) => id === 'attack').length, 0);
  game.dispose();
});

test('Nope auf die eigene Aktion ist erlaubt', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  cur.hand = cur.hand.filter((c) => c.id !== 'nope');
  const skip = giveCard(game, cur, 'skip');
  giveCard(game, cur, 'nope');
  game.playCards(cur.id, [skip]);
  assert.equal(game.viewFor(cur.id).pending.youCanNope, true, 'eigene Aktion darf genopt werden');
  game.playNope(cur.id);
  resolve(game);
  assert.equal(game.currentPlayer.id, cur.id, 'Überspringen wurde aufgehoben');
  game.dispose();
});

test('Host entfernt offline Spieler, verbundene bleiben geschützt', () => {
  const game = startedGame(['A', 'B', 'C']);
  const host = game.findById(game.hostId);
  const victim = game.players.find((p) => p.id !== host.id);
  assert.throws(() => game.kickPlayer(host.id, victim.id), /offline/);
  game.detach(victim.socketId);
  game.kickPlayer(host.id, victim.id);
  assert.equal(victim.alive, false);
  assert.equal(victim.removed, true);
  assert.equal(victim.hand.length, 0, 'Hand landet auf der Ablage');
  assert.throws(() => game.kickPlayer(victim.id, host.id), /Host/);
  game.dispose();
});

test('Kick des letzten Gegners beendet die Runde', () => {
  const game = startedGame(['A', 'B']);
  const host = game.findById(game.hostId);
  const other = game.players.find((p) => p.id !== host.id);
  game.detach(other.socketId);
  game.kickPlayer(host.id, other.id);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winnerId, host.id);
  game.dispose();
});

test('Hausregeln wirken auf Startkarten und Bombenzahl', () => {
  const game = makeGame(['A', 'B', 'C']);
  game.updateSettings(game.hostId, { startCards: 5, extraBombs: 2, nopeSeconds: 3, turnSeconds: 60 });
  assert.deepEqual(game.settings, { nopeSeconds: 3, turnSeconds: 60, startCards: 5, deckSize: 6, extraBombs: 2 });
  assert.throws(() => game.updateSettings(game.hostId, { startCards: 99 }), /Ungültig/);
  const notHost = game.players.find((p) => p.id !== game.hostId);
  assert.throws(() => game.updateSettings(notHost.id, { startCards: 6 }), /Host/);
  game.start(game.hostId);
  game.players.forEach((p) => assert.equal(p.hand.length, 6, '5 Karten + Entschärfung'));
  assert.equal(game.deck.filter((c) => c.id === 'bomb').length, 4, '3 Spieler − 1 + 2 Zusatzbomben');
  assert.throws(() => game.updateSettings(game.hostId, { startCards: 7 }), /Runde/);
  game.dispose();
});

test('Nope-Fenster von 0 Sekunden führt Aktionen sofort aus', async () => {
  const game = makeGame(['A', 'B']);
  game.updateSettings(game.hostId, { nopeSeconds: 0 });
  game.start(game.hostId);
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  giveCard(game, other, 'nope');
  const uid = giveCard(game, cur, 'shuffle');
  game.playCards(cur.id, [uid]);
  await sleep(40);
  assert.equal(game.pending, null, 'Aktion ist ohne Wartezeit aufgelöst');
  game.dispose();
});

test('Zug-Timer zieht nach Ablauf automatisch', async () => {
  const game = startedGame(['A', 'B', 'C']);
  game.settings.turnSeconds = 60;
  game._refreshTurnClock();
  assert.ok(game.turnDeadline > Date.now() + 50000, 'Zug-Uhr läuft');
  const cur = game.currentPlayer;
  game.deck.push({ uid: 'safe', id: 'skip' });
  const handBefore = cur.hand.length;
  game.turnDeadline = Date.now() + 60;
  game._scheduleAuto();
  await sleep(220);
  assert.equal(cur.hand.length, handBefore + 1, 'es wurde automatisch gezogen');
  assert.notEqual(game.currentPlayer.id, cur.id, 'Zug ist weitergegeben');
  game.dispose();
});

test('Zug-Uhr pausiert, solange eine Aktion offen ist', () => {
  const game = startedGame(['A', 'B']);
  game.settings.turnSeconds = 60;
  game._refreshTurnClock();
  const cur = game.currentPlayer;
  const other = game.players.find((p) => p.id !== cur.id);
  other.hand = other.hand.filter((c) => c.id !== 'nope');
  giveCard(game, other, 'nope');
  const uid = giveCard(game, cur, 'shuffle');
  game.playCards(cur.id, [uid]);
  assert.equal(game.turnDeadline, null, 'während des Nope-Fensters keine Zug-Uhr');
  resolve(game);
  assert.ok(game.turnDeadline > Date.now() + 50000, 'danach läuft sie neu');
  game.dispose();
});

test('Momentaufnahme stellt eine laufende Runde wieder her', () => {
  const game = startedGame(['A', 'B', 'C']);
  const cur = game.currentPlayer;
  const uid = giveCard(game, cur, 'future');
  game.playCards(cur.id, [uid]);
  resolve(game);
  const snapshot = JSON.parse(JSON.stringify(game.toJSON()));
  const handSizes = game.players.map((p) => p.hand.length);
  const deckSize = game.deck.length;
  game.dispose();

  const restored = Game.fromJSON(snapshot, { broadcast: () => {}, toPlayer: () => {} });
  assert.equal(restored.phase, 'playing');
  assert.equal(restored.code, '1234');
  assert.deepEqual(restored.players.map((p) => p.hand.length), handSizes);
  assert.equal(restored.deck.length, deckSize);
  assert.equal(restored.players.every((p) => !p.connected), true, 'nach Neustart erst einmal alle offline');
  assert.equal(restored.currentPlayer.id, cur.id, 'der Spieler am Zug bleibt am Zug');
  assert.equal(restored.findByToken(cur.token).id, cur.id, 'Reconnect-Token überlebt');
  restored.dispose();
});

test('Eine gerade entschärfte Bombe geht beim Sichern nicht verloren', () => {
  const game = startedGame(['A', 'B']);
  const cur = game.currentPlayer;
  game.deck.push({ uid: 'boom', id: 'bomb' });
  const bombsBefore = game.deck.filter((c) => c.id === 'bomb').length;
  game.draw(cur.id);
  assert.equal(game.prompt.type, 'defuse');
  const snapshot = game.toJSON();
  assert.equal(snapshot.deck.filter((c) => c.id === 'bomb').length, bombsBefore, 'Bombe liegt wieder im Stapel');
  game.dispose();
});

test('Spieler bekommen unterschiedliche Farben und Symbole', () => {
  const game = startedGame(['A', 'B', 'C', 'D']);
  const view = game.viewFor(game.players[0].id);
  const colors = new Set(view.players.map((p) => p.color));
  assert.equal(colors.size, 4, 'vier verschiedene Farben');
  assert.equal(view.players.every((p) => Boolean(p.emoji)), true);
  game.dispose();
});

/* --------------------------------------------------------- Computergegner */

test('Host fügt Bots hinzu und stellt die Spielstärke ein', () => {
  const game = makeGame(['Mensch', 'Zweiter']);
  const notHost = game.players.find((p) => p.id !== game.hostId);
  assert.throws(() => game.addBot(notHost.id), /Host/);
  const bot = game.addBot(game.hostId, 'smart');
  assert.equal(bot.bot, true);
  assert.equal(bot.level, 'smart');
  assert.equal(bot.connected, true, 'Bots zählen als anwesend');
  assert.equal(game.players.length, 3);
  game.setBotLevel(game.hostId, bot.id, 'easy');
  assert.equal(bot.level, 'easy');
  assert.throws(() => game.setBotLevel(game.hostId, bot.id, 'genial'), /Spielstärke/);
  assert.throws(() => game.setBotLevel(game.hostId, game.hostId, 'easy'), /kein Bot/);
  game.dispose();
});

test('Ein Mensch plus ein Bot reicht zum Start, Bots allein nicht', () => {
  const game = makeGame(['Mensch']);
  assert.throws(() => game.start(game.hostId), /Mitspieler/);
  game.addBot(game.hostId, 'normal');
  game.start(game.hostId);
  assert.equal(game.phase, 'playing');
  assert.equal(game.players.length, 2);
  assert.equal(game.deck.filter((c) => c.id === 'bomb').length, 1);
  game.players.forEach((p) => assert.equal(p.hand.length, 8));
  game.dispose();

  const onlyBots = new Game('9999', { broadcast: () => {}, toPlayer: () => {} });
  const human = onlyBots.addPlayer({ name: 'Mensch', token: 't', socketId: 's' });
  onlyBots.addBot(human.id, 'easy');
  onlyBots.addBot(human.id, 'easy');
  onlyBots.detach('s');
  assert.throws(() => onlyBots.start(onlyBots.hostId), /Host|menschlicher/);
  onlyBots.dispose();
});

test('Der Host bleibt immer ein Mensch', () => {
  const game = makeGame(['Mensch', 'Gast']);
  const guest = game.players.find((p) => p.id !== game.hostId);
  game.addBot(game.hostId, 'normal');
  const host = game.findById(game.hostId);
  game.detach(host.socketId);
  const newHost = game.findById(game.hostId);
  assert.ok(newHost, 'es gibt weiterhin einen Host');
  assert.equal(Boolean(newHost.bot), false, 'kein Bot als Host');
  assert.equal(newHost.id, guest.id);
  game.dispose();
});

test('Bots halten einen Raum nicht künstlich am Leben', () => {
  const game = makeGame(['Mensch']);
  game.addBot(game.hostId, 'normal');
  assert.equal(game.connectedCount, 1, 'nur Menschen zählen');
  game.detach(game.players[0].socketId);
  assert.equal(game.connectedCount, 0);
  game.dispose();
});

test('Bots pausieren, wenn kein Mensch zuschaut', () => {
  const game = makeGame(['Mensch']);
  game.addBot(game.hostId, 'normal');
  game.start(game.hostId);
  game.detach(game.players.find((p) => !p.bot).socketId);
  game._scheduleAuto();
  assert.equal(game._timers.bot, null, 'kein Bot-Timer ohne Publikum');
  game.dispose();
});

test('Bot-Entscheidungen sind regelkonform', () => {
  for (let round = 0; round < 12; round++) {
    const game = makeGame(['Mensch']);
    ['easy', 'normal', 'smart'].forEach((level) => game.addBot(game.hostId, level));
    game.start(game.hostId);
    let steps = 0;
    while (game.phase === 'playing' && steps++ < 2000) {
      if (game.prompt) {
        const owner = game.findById(game.prompt.playerId);
        if (owner.bot) game._botPrompt(owner.id);
        else if (game.prompt.type === 'defuse') game.respondPrompt(owner.id, { position: 0 });
        else game.respondPrompt(owner.id, { uid: owner.hand[0] && owner.hand[0].uid });
        continue;
      }
      if (game.pending) {
        const bot = game._nopeCandidates().find((p) => p.bot);
        if (bot) game._botNope(bot.id);
        else resolve(game);
        continue;
      }
      const cur = game.currentPlayer;
      if (cur.bot) {
        // Entscheidung ohne Sicherheitsnetz anwenden: ein illegaler Zug wirft hier
        const decision = botBrain.decideTurn(game, cur);
        if (decision.type === 'play') game.playCards(cur.id, decision.uids, decision.opts || {});
        else game.draw(cur.id);
      } else {
        game.draw(cur.id);
      }
    }
    assert.equal(game.phase, 'finished', `Runde ${round} läuft zu Ende (Schritte: ${steps})`);
    assert.equal(game.alivePlayers.length, 1);
    game.dispose();
  }
});

test('Bots nutzen ihr Wissen: Nope, Gefallen und Bombenverstecken', () => {
  const game = makeGame(['Mensch']);
  game.addBot(game.hostId, 'smart');
  game.start(game.hostId);
  const bot = game.players.find((p) => p.bot);
  const human = game.players.find((p) => !p.bot);

  // Gefallen: billigste Karte abgeben, Entschärfung behalten
  bot.hand = [{ uid: 'd', id: 'defuse' }, { uid: 'k', id: 'cat_pizza' }, { uid: 'a', id: 'attack' }];
  assert.equal(botBrain.decideFavorCard(game, bot), 'k', 'die Katze geht raus');
  bot.hand = [{ uid: 'd', id: 'defuse' }];
  assert.equal(botBrain.decideFavorCard(game, bot), 'd', 'nur noch die Entschärfung da');

  // Bombe verstecken: ohne weiteren Zug nach oben, mit weiterem Zug nach hinten
  bot.turnsLeft = 1;
  assert.equal(botBrain.decideDefusePosition(game, bot), 0, 'direkt vor die Nase des Nächsten');
  bot.turnsLeft = 2;
  assert.equal(botBrain.decideDefusePosition(game, bot), game.deck.length, 'bei eigenem Folgezug ganz nach hinten');

  // Nope: Aktionen gegen den Bot werden meistens gekontert
  const pendingAgainstBot = { action: { type: 'favor', targetId: bot.id }, byId: human.id, nopeLayers: 0 };
  const pendingElsewhere = { action: { type: 'shuffle' }, byId: human.id, nopeLayers: 0 };
  let against = 0;
  let elsewhere = 0;
  for (let i = 0; i < 400; i++) {
    if (botBrain.decideNope(game, bot, pendingAgainstBot)) against++;
    if (botBrain.decideNope(game, bot, pendingElsewhere)) elsewhere++;
  }
  assert.ok(against > 280, `gegen sich gerichtete Aktionen werden gekontert (${against}/400)`);
  assert.ok(elsewhere < 100, `harmlose Aktionen bleiben meist stehen (${elsewhere}/400)`);
  assert.equal(botBrain.decideNope(game, bot, { action: { type: 'skip' }, byId: bot.id, nopeLayers: 0 }), false,
    'sich selbst nopet der Bot nicht');
  game.dispose();
});

test('Der schlaue Bot zieht bei sicherem Stapel, statt Karten zu verschwenden', () => {
  const game = makeGame(['Mensch']);
  game.addBot(game.hostId, 'smart');
  game.start(game.hostId);
  const bot = game.players.find((p) => p.bot);
  game.currentIndex = game.players.indexOf(bot);
  bot.turnsLeft = 1;
  bot.hand = [{ uid: 's', id: 'skip' }, { uid: 'a', id: 'attack' }];
  game.peeks[bot.id] = ['shuffle', 'skip', 'favor'];
  assert.equal(botBrain.decideTurn(game, bot).type, 'draw', 'oben liegt nichts Gefährliches');
  game.peeks[bot.id] = ['bomb', 'skip', 'favor'];
  const risky = botBrain.decideTurn(game, bot);
  assert.equal(risky.type, 'play', 'bei bekannter Bombe wird reagiert');
  game.dispose();
});

test('Bots überleben eine Momentaufnahme', () => {
  const game = makeGame(['Mensch']);
  game.addBot(game.hostId, 'smart');
  game.start(game.hostId);
  const snapshot = JSON.parse(JSON.stringify(game.toJSON()));
  game.dispose();
  const restored = Game.fromJSON(snapshot, { broadcast: () => {}, toPlayer: () => {} });
  const bot = restored.players.find((p) => p.bot);
  assert.ok(bot, 'Bot ist wieder da');
  assert.equal(bot.level, 'smart');
  assert.equal(bot.connected, true, 'Bots sind nach dem Neustart sofort wieder spielbereit');
  assert.equal(restored.bombsInPlay, 1);
  restored.dispose();
});

runAll().then(() => {
  console.log(`\n${passed} von ${tests.length} Tests erfolgreich${process.exitCode ? ' – mit Fehlern' : ''}.`);
});
