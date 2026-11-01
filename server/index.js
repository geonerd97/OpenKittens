'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const { Game, GameError, MIN_PLAYERS, MAX_PLAYERS } = require('./game');
const { CARDS } = require('./cards');

const PORT = Number(process.env.PORT) || 3333;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MINUTES || 180) * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/** @type {Map<string, Game>} */
const rooms = new Map();

function makeCode() {
  for (let i = 0; i < 500; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(code)) return code;
  }
  throw new GameError('Keine freien Raumcodes mehr.');
}

function createRoom() {
  const code = makeCode();
  const game = new Game(code, {
    broadcast: () => broadcast(code),
    toPlayer: (playerId, event, payload) => {
      const g = rooms.get(code);
      if (!g) return;
      const p = g.findById(playerId);
      if (p && p.socketId) io.to(p.socketId).emit(event, payload);
    }
  });
  rooms.set(code, game);
  return game;
}

function broadcast(code) {
  const game = rooms.get(code);
  if (!game) return;
  for (const player of game.players) {
    if (player.socketId) io.to(player.socketId).emit('state', game.viewFor(player.id));
  }
}

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
    return { code: game.code, token: player.token, playerId: player.id, name: player.name };
  };

  socket.on('createRoom', handler(socket, ({ name, token }) => enter(createRoom(), { name, token })));

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

  socket.on('playCards', handler(socket, ({ uids, targetId }) => {
    const { game, player } = context();
    game.playCards(player.id, uids, { targetId });
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
    }
    socket.data.code = null;
    socket.data.playerId = null;
  }));

  socket.on('disconnect', () => {
    const game = rooms.get(socket.data.code);
    if (!game) return;
    const player = game.players.find((p) => p.socketId === socket.id);
    if (!player) return;
    game.detach(socket.id);
    broadcast(game.code);
  });
});

/* -------------------------------------------------------------- Aufräumen */

setInterval(() => {
  const now = Date.now();
  for (const [code, game] of rooms) {
    if (game.connectedCount === 0 && now - game.updatedAt > ROOM_TTL_MS) {
      game.dispose();
      rooms.delete(code);
      console.log(`[openkittens] Raum ${code} verworfen (inaktiv).`);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`[openkittens] läuft auf http://${HOST}:${PORT} (${MIN_PLAYERS}-${MAX_PLAYERS} Spieler pro Raum)`);
});

function shutdown() {
  console.log('[openkittens] fährt herunter …');
  for (const game of rooms.values()) game.dispose();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server, rooms };
