'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const { Game, GameError, MIN_PLAYERS, MAX_PLAYERS } = require('./game');
const { CARDS } = require('./cards');

const PORT = Number(process.env.PORT) || 3333;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MINUTES || 180) * 60 * 1000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 100);
const MAX_ROOMS_PER_SOCKET = Number(process.env.MAX_ROOMS_PER_SOCKET || 5);
const PERSIST = process.env.PERSIST !== '0';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');

const app = express();
const server = http.createServer(app);
// Kein offenes CORS: Verbindungen kommen vom selben Ursprung wie die Seite.
const io = new Server(server);

/** @type {Map<string, Game>} */
const rooms = new Map();

/* ----------------------------------------------------------------- Räume */

function roomHooks(code) {
  return {
    broadcast: () => broadcast(code),
    onChange: () => scheduleSave(),
    toPlayer: (playerId, event, payload) => {
      const game = rooms.get(code);
      if (!game) return;
      const player = game.findById(playerId);
      if (player && player.socketId) io.to(player.socketId).emit(event, payload);
    },
    fx: (payload) => io.to(code).emit('fx', payload)
  };
}

function makeCode() {
  for (let i = 0; i < 500; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(code)) return code;
  }
  throw new GameError('Keine freien Raumcodes mehr.');
}

function createRoom() {
  if (rooms.size >= MAX_ROOMS) throw new GameError('Der Server ist gerade voll. Bitte später erneut versuchen.');
  const code = makeCode();
  const game = new Game(code, roomHooks(code));
  rooms.set(code, game);
  scheduleSave();
  return game;
}

function broadcast(code) {
  const game = rooms.get(code);
  if (!game) return;
  for (const player of game.players) {
    if (player.socketId) io.to(player.socketId).emit('state', game.viewFor(player.id));
  }
}

/* ------------------------------------------------------------- Persistenz */

let saveTimer = null;
let saving = false;

function scheduleSave() {
  if (!PERSIST || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 2000);
  saveTimer.unref();
}

function saveState() {
  if (!PERSIST || saving) return;
  saving = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      version: 1,
      savedAt: Date.now(),
      rooms: [...rooms.values()].filter((g) => g.players.length > 0).map((g) => g.toJSON())
    };
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.warn('[openkittens] Spielstand konnte nicht gesichert werden:', err.message);
  } finally {
    saving = false;
  }
}

function loadState() {
  if (!PERSIST) return;
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return; // noch nichts gesichert
  }
  try {
    const data = JSON.parse(raw);
    const age = Date.now() - (data.savedAt || 0);
    if (age > ROOM_TTL_MS) {
      console.log('[openkittens] Gesicherter Spielstand ist zu alt und wird verworfen.');
      return;
    }
    for (const entry of data.rooms || []) {
      if (!entry || !entry.code || rooms.has(entry.code)) continue;
      rooms.set(entry.code, Game.fromJSON(entry, roomHooks(entry.code)));
    }
    if (rooms.size) console.log(`[openkittens] ${rooms.size} Raum/Räume nach Neustart wiederhergestellt.`);
  } catch (err) {
    console.warn('[openkittens] Spielstand unlesbar, starte leer:', err.message);
  }
}

/* -------------------------------------------------------------- HTTP-Teil */

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

app.get('/api/cards', (_req, res) => res.json(CARDS));

app.get('/api/room/:code', (req, res) => {
  const game = rooms.get(String(req.params.code));
  if (!game) return res.status(404).json({ ok: false, error: 'Raum nicht gefunden.' });
  res.json({ ok: true, code: game.code, phase: game.phase, players: game.players.length });
});

/* ------------------------------------------------------------------ Socket.IO */

function handler(socket, fn) {
  return (payload = {}, ack) => {
    try {
      const result = fn(payload) || {};
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof GameError ? err.message : 'Unerwarteter Fehler.';
      if (!(err instanceof GameError)) console.error('[openkittens]', err);
      if (typeof ack === 'function') ack({ ok: false, error: message });
      else socket.emit('toast', message);
    }
  };
}

io.on('connection', (socket) => {
  socket.data.roomsCreated = 0;

  const context = () => {
    const game = rooms.get(socket.data.code);
    if (!game) throw new GameError('Raum nicht gefunden – bitte neu beitreten.');
    const player = game.findById(socket.data.playerId);
    if (!player) throw new GameError('Spieler nicht gefunden – bitte neu beitreten.');
    return { game, player };
  };

  const enter = (game, { name, token }) => {
    let player = token ? game.findByToken(token) : null;
    if (player) {
      if (player.socketId && player.socketId !== socket.id) io.to(player.socketId).emit('kicked');
      game.attach(player, socket.id);
      if (name && game.phase === 'lobby') {
        const clean = String(name).trim().slice(0, 16);
        if (clean) player.name = clean;
      }
    } else {
      player = game.addPlayer({ name, token: token || crypto.randomUUID(), socketId: socket.id });
    }
    socket.data.code = game.code;
    socket.data.playerId = player.id;
    socket.join(game.code);
    broadcast(game.code);
    scheduleSave();
    return { code: game.code, token: player.token, playerId: player.id, name: player.name };
  };

  socket.on('createRoom', handler(socket, ({ name, token }) => {
    if (socket.data.roomsCreated >= MAX_ROOMS_PER_SOCKET) {
      throw new GameError('Du hast zu viele Räume erstellt. Lade die Seite neu.');
    }
    socket.data.roomsCreated += 1;
    return enter(createRoom(), { name, token });
  }));

  socket.on('joinRoom', handler(socket, ({ code, name, token }) => {
    const clean = String(code || '').replace(/\D/g, '');
    if (clean.length !== 4) throw new GameError('Bitte einen vierstelligen Code eingeben.');
    const game = rooms.get(clean);
    if (!game) throw new GameError('Diesen Raum gibt es nicht (mehr).');
    return enter(game, { name, token });
  }));

  socket.on('startGame', handler(socket, () => {
    const { game, player } = context();
    game.start(player.id);
  }));

  socket.on('updateSettings', handler(socket, (patch) => {
    const { game, player } = context();
    game.updateSettings(player.id, patch);
  }));

  socket.on('kickPlayer', handler(socket, ({ playerId }) => {
    const { game, player } = context();
    const removed = game.kickPlayer(player.id, playerId);
    if (removed && removed.socketId) io.to(removed.socketId).emit('kicked', 'Der Host hat dich aus dem Raum entfernt.');
  }));

  socket.on('playCards', handler(socket, ({ uids, targetId, demandCardId, discardCardId }) => {
    const { game, player } = context();
    game.playCards(player.id, uids, { targetId, demandCardId, discardCardId });
  }));

  socket.on('drawCard', handler(socket, () => {
    const { game, player } = context();
    game.draw(player.id);
  }));

  socket.on('nope', handler(socket, () => {
    const { game, player } = context();
    game.playNope(player.id);
  }));

  socket.on('passNope', handler(socket, () => {
    const { game, player } = context();
    game.passNope(player.id);
  }));

  socket.on('respondPrompt', handler(socket, (data) => {
    const { game, player } = context();
    game.respondPrompt(player.id, data);
  }));

  socket.on('clearPeek', handler(socket, () => {
    const { game, player } = context();
    game.clearPeek(player.id);
  }));

  socket.on('backToLobby', handler(socket, () => {
    const { game, player } = context();
    game.resetToLobby(player.id);
  }));

  socket.on('leaveRoom', handler(socket, () => {
    const game = rooms.get(socket.data.code);
    if (game) {
      game.detach(socket.id);
      broadcast(game.code);
      scheduleSave();
    }
    socket.data.code = null;
    socket.data.playerId = null;
  }));

  socket.on('disconnect', () => {
    const game = rooms.get(socket.data.code);
    if (!game) return;
    if (!game.players.some((p) => p.socketId === socket.id)) return;
    game.detach(socket.id);
    broadcast(game.code);
    scheduleSave();
  });
});

/* -------------------------------------------------------------- Aufräumen */

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [code, game] of rooms) {
    if (game.connectedCount === 0 && now - game.updatedAt > ROOM_TTL_MS) {
      game.dispose();
      rooms.delete(code);
      removed++;
      console.log(`[openkittens] Raum ${code} verworfen (inaktiv).`);
    }
  }
  if (removed) scheduleSave();
}, 60 * 1000);
cleanupTimer.unref();

const periodicSave = setInterval(() => saveState(), 60 * 1000);
periodicSave.unref();

loadState();

server.listen(PORT, HOST, () => {
  console.log(`[openkittens] läuft auf http://${HOST}:${PORT} (${MIN_PLAYERS}-${MAX_PLAYERS} Spieler pro Raum)`);
  if (PERSIST) console.log(`[openkittens] Spielstände: ${STATE_FILE}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[openkittens] fährt herunter …');
  saveState();
  for (const game of rooms.values()) game.dispose();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server, rooms, saveState, loadState };
