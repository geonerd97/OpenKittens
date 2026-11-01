'use strict';

/**
 * Ende-zu-Ende-Test über die echte Socket.IO-Schnittstelle:
 * Server starten, drei Clients beitreten lassen, eine komplette Runde
 * automatisch durchspielen und prüfen, dass es genau einen Gewinner gibt.
 *
 *   npm run test:e2e
 */
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

process.env.PORT = process.env.E2E_PORT || '4123';
process.env.PERSIST = '0';
const { server } = require('../server/index');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const ask = (socket, event, payload = {}) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

async function main() {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  console.log('OpenKittens – Ende-zu-Ende');

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  const page = await fetch(`${BASE}/`).then((r) => r.text());
  assert.match(page, /OpenKittens/, 'Startseite wird ausgeliefert');
  console.log('  ✓ HTTP: /health und Startseite');

  const sockets = [];
  const states = {};
  const names = ['Mia', 'Ben', 'Lio'];
  let code = null;

  for (const name of names) {
    const socket = await connect();
    sockets.push(socket);
    socket.on('state', (v) => { states[socket.id] = v; });
    const res = code
      ? await ask(socket, 'joinRoom', { code, name })
      : await ask(socket, 'createRoom', { name });
    assert.equal(res.ok, true, res.error || 'Beitritt erfolgreich');
    code = res.code;
    socket.data = { playerId: res.playerId, token: res.token, name };
  }
  assert.match(code, /^\d{4}$/, 'vierstelliger Raumcode');
  console.log(`  ✓ Raum ${code}: drei Spieler ohne Account beigetreten`);

  await wait(150);
  assert.equal(states[sockets[0].id].players.length, 3);
  assert.equal(states[sockets[0].id].phase, 'lobby');

  const notHost = await ask(sockets[1], 'startGame');
  assert.equal(notHost.ok, false, 'nur der Host darf starten');
  console.log('  ✓ Lobby: nur der Host kann starten');

  const falsch = await ask(sockets[0], 'joinRoom', { code: '0000', name: 'X' });
  assert.equal(falsch.ok, false);
  console.log('  ✓ Unbekannter Raumcode wird abgelehnt');

  assert.equal((await ask(sockets[0], 'startGame')).ok, true);
  await wait(150);
  assert.equal(states[sockets[0].id].phase, 'playing');
  states[sockets[0].id].players.forEach((p) => assert.equal(p.handCount, 8));
  console.log('  ✓ Spielstart: je 8 Karten');

  // Reconnect mit demselben Token behält Hand und Platz
  const re = await connect();
  const reRes = await ask(re, 'joinRoom', { code, token: sockets[1].data.token, name: 'Ben' });
  assert.equal(reRes.ok, true);
  assert.equal(reRes.playerId, sockets[1].data.playerId, 'gleicher Spieler nach Reconnect');
  re.disconnect();
  await wait(100);
  // ursprüngliche Verbindung wieder an denselben Spieler binden
  const back = await ask(sockets[1], 'joinRoom', { code, token: sockets[1].data.token, name: 'Ben' });
  assert.equal(back.playerId, sockets[1].data.playerId);
  await wait(150);
  assert.equal(states[sockets[1].id].players.every((p) => p.connected), true, 'alle wieder online');
  console.log('  ✓ Reconnect über gespeicherten Token');

  // Runde automatisch durchspielen
  const byPlayer = new Map(sockets.map((s) => [s.data.playerId, s]));
  let steps = 0;
  while (steps++ < 900) {
    await wait(25);
    const v = states[sockets[0].id];
    if (!v) continue;
    if (v.phase === 'finished') break;

    for (const socket of sockets) {
      const mine = states[socket.id];
      if (!mine) continue;
      if (mine.prompt && mine.prompt.type === 'defuse') {
        await ask(socket, 'respondPrompt', { position: Math.floor(Math.random() * 3) });
      } else if (mine.prompt && mine.prompt.type === 'favor') {
        await ask(socket, 'respondPrompt', { uid: mine.you.hand[0] && mine.you.hand[0].uid });
      } else if (mine.peek) {
        await ask(socket, 'clearPeek');
      } else if (mine.pending && mine.pending.youCanNope) {
        await ask(socket, Math.random() < 0.25 ? 'nope' : 'passNope');
      }
    }

    const fresh = states[sockets[0].id];
    if (fresh.phase !== 'playing' || fresh.pending || fresh.promptInfo) continue;
    const socket = byPlayer.get(fresh.currentId);
    if (!socket) continue;
    const mine = states[socket.id];
    if (!mine || !mine.you || !mine.you.isCurrent) continue;

    const hand = mine.you.hand;
    const cats = {};
    hand.filter((c) => c.id.startsWith('cat_')).forEach((c) => { (cats[c.id] = cats[c.id] || []).push(c); });
    const pair = Object.values(cats).find((l) => l.length >= 2);
    const others = mine.players.filter((p) => p.alive && !p.spectator && p.id !== mine.youId);
    const action = hand.find((c) => ['skip', 'attack', 'shuffle', 'future'].includes(c.id));
    const favor = hand.find((c) => c.id === 'favor');

    if (pair && others.length && Math.random() < 0.35) {
      await ask(socket, 'playCards', { uids: [pair[0].uid, pair[1].uid], targetId: others[0].id });
    } else if (favor && others.length && Math.random() < 0.3) {
      await ask(socket, 'playCards', { uids: [favor.uid], targetId: others[0].id });
    } else if (action && Math.random() < 0.45) {
      await ask(socket, 'playCards', { uids: [action.uid] });
    } else {
      await ask(socket, 'drawCard');
    }
  }

  const final = states[sockets[0].id];
  assert.equal(final.phase, 'finished', `Runde beendet (Schritte: ${steps})`);
  const alive = final.players.filter((p) => p.alive && !p.spectator);
  assert.equal(alive.length, 1, 'genau ein Gewinner');
  assert.equal(final.winnerId, alive[0].id);
  console.log(`  ✓ Komplette Runde gespielt – Gewinner: ${final.winnerName}`);

  // Zurück in die Lobby und neue Runde
  assert.equal((await ask(sockets[0], 'backToLobby')).ok, true);
  await wait(150);
  assert.equal(states[sockets[0].id].phase, 'lobby');
  assert.equal((await ask(sockets[0], 'startGame')).ok, true);
  await wait(150);
  assert.equal(states[sockets[0].id].phase, 'playing');
  assert.equal(states[sockets[0].id].round, 2);
  console.log('  ✓ Neue Runde im selben Raum');

  sockets.forEach((s) => s.disconnect());
  await wait(100);
  console.log('\nEnde-zu-Ende-Test erfolgreich.');
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nEnde-zu-Ende-Test fehlgeschlagen:', err.message);
  process.exit(1);
});
