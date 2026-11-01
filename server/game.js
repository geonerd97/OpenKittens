'use strict';

const { CARDS, buildPool, defuseCount } = require('./cards');
const bots = require('./bot');

const PROMPT_TIMEOUT_MS = 30000;
const OFFLINE_AUTOPLAY_MS = 20000;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const LOG_LIMIT = 60;

/** Farbe und Symbol je Sitzplatz – damit sich Spieler schnell unterscheiden lassen. */
const AVATARS = [
  { color: '#ff7a59', emoji: '🐱' },
  { color: '#60a5fa', emoji: '🐈' },
  { color: '#4ade80', emoji: '🐸' },
  { color: '#fbbf24', emoji: '🦁' },
  { color: '#c084fc', emoji: '🐯' },
  { color: '#f472b6', emoji: '🐰' },
  { color: '#38bdf8', emoji: '🦊' },
  { color: '#a3e635', emoji: '🐢' }
];

const DEFAULT_SETTINGS = {
  nopeSeconds: 6,   // 0 = Aktionen sofort ausführen
  turnSeconds: 0,   // 0 = kein Zeitlimit pro Zug
  startCards: 7,    // Handkarten zu Beginn (ohne Entschärfung)
  extraBombs: 0     // zusätzliche Bomben über "Spielerzahl − 1" hinaus
};

const SETTING_RANGES = {
  nopeSeconds: [0, 3, 6, 10],
  turnSeconds: [0, 30, 60, 90, 120],
  startCards: [5, 6, 7, 8, 9, 10],
  extraBombs: [0, 1, 2, 3]
};

let uidCounter = 0;
const nextUid = () => `k${(++uidCounter).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

class GameError extends Error {}

/**
 * Eine Spielrunde in einem Raum. Der Zustand liegt im Speicher und wird vom
 * Server regelmäßig als Momentaufnahme gesichert (siehe toJSON/fromJSON).
 */
class Game {
  /**
   * @param {string} code vierstelliger Raumcode
   * @param {{broadcast: Function, toPlayer: Function, fx?: Function, onChange?: Function}} hooks
   */
  constructor(code, hooks) {
    this.code = code;
    this.hooks = Object.assign({ fx: () => {}, onChange: () => {} }, hooks);
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | playing | finished
    this.settings = { ...DEFAULT_SETTINGS };
    this.deck = [];
    this.discard = [];
    this.currentIndex = 0;
    this.pending = null;
    this.prompt = null;
    this.peeks = {};
    this.log = [];
    this.winnerId = null;
    this.lastPlay = null;
    this.round = 0;
    this.bombsInPlay = 0;
    this.turnDeadline = null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this._timers = { nope: null, prompt: null, auto: null, bot: null };
  }

  /* ------------------------------------------------------------------ Spieler */

  findByToken(token) {
    return this.players.find((p) => p.token === token) || null;
  }

  findById(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  get alivePlayers() {
    return this.players.filter((p) => p.alive && !p.spectator);
  }

  /** Verbundene Menschen – Bots halten einen Raum nicht am Leben. */
  get connectedCount() {
    return this.players.filter((p) => p.connected && !p.bot).length;
  }

  get humans() {
    return this.players.filter((p) => !p.bot);
  }

  _reassignHost() {
    if (this.hostId && this.findById(this.hostId) && !this.findById(this.hostId).bot) return;
    const next = this.players.find((p) => !p.bot && p.connected) || this.players.find((p) => !p.bot);
    this.hostId = next ? next.id : null;
  }

  _freeAvatar() {
    const used = new Set(this.players.map((p) => p.avatar));
    for (let i = 0; i < AVATARS.length; i++) if (!used.has(i)) return i;
    return this.players.length % AVATARS.length;
  }

  addPlayer({ name, token, socketId }) {
    const clean = String(name || '').trim().slice(0, 16) || 'Katze';
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`Dieser Raum ist voll (max. ${MAX_PLAYERS} Spieler).`);
    const taken = this.players.some((p) => p.name.toLowerCase() === clean.toLowerCase());
    const player = {
      id: nextUid(),
      token,
      name: taken ? `${clean}#${this.players.length + 1}` : clean,
      avatar: this._freeAvatar(),
      socketId: socketId || null,
      connected: Boolean(socketId),
      hand: [],
      alive: this.phase === 'lobby',
      spectator: this.phase !== 'lobby',
      turnsLeft: 0
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    this._log(player.spectator
      ? `${player.name} schaut zu und ist in der nächsten Runde dabei.`
      : `${player.name} ist dem Raum beigetreten.`);
    this._touch();
    return player;
  }

  attach(player, socketId) {
    player.socketId = socketId;
    player.connected = true;
    this._touch();
    this._scheduleAuto();
  }

  detach(socketId) {
    const player = this.players.find((p) => p.socketId === socketId);
    if (!player) return null;
    player.socketId = null;
    player.connected = false;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((p) => p.id !== player.id);
      this._log(`${player.name} hat den Raum verlassen.`);
    } else {
      this._log(`${player.name} ist offline – Züge werden automatisch gespielt.`);
    }
    if (this.hostId === player.id) this._reassignHost();
    this._touch();
    this._scheduleAuto();
    return player;
  }

  /* ----------------------------------------------------------------- Bots */

  addBot(hostId, level = 'normal') {
    if (hostId !== this.hostId) throw new GameError('Nur der Host kann Bots hinzufügen.');
    if (this.phase === 'playing') throw new GameError('Bots lassen sich nur zwischen den Runden hinzufügen.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`Mehr als ${MAX_PLAYERS} Spieler gehen nicht.`);
    const lvl = bots.LEVELS.includes(level) ? level : 'normal';
    const bot = {
      id: nextUid(),
      token: `bot:${nextUid()}`,
      name: bots.freeName(this),
      avatar: this._freeAvatar(),
      socketId: null,
      connected: true,
      bot: true,
      level: lvl,
      hand: [],
      alive: true,
      spectator: false,
      turnsLeft: 0
    };
    this.players.push(bot);
    this._log(`${bot.name} (Bot, ${bots.LEVEL_NAMES[lvl]}) spielt mit.`);
    this._afterChange();
    return bot;
  }

  setBotLevel(hostId, botId, level) {
    if (hostId !== this.hostId) throw new GameError('Nur der Host kann Bots einstellen.');
    if (this.phase === 'playing') throw new GameError('Während einer Runde lässt sich das nicht ändern.');
    const bot = this.findById(botId);
    if (!bot || !bot.bot) throw new GameError('Das ist kein Bot.');
    if (!bots.LEVELS.includes(level)) throw new GameError('Unbekannte Spielstärke.');
    bot.level = level;
    this._log(`${bot.name} spielt jetzt ${bots.LEVEL_NAMES[level]}.`);
    this._afterChange();
    return bot;
  }

  /**
   * Host entfernt einen Spieler. In der Lobby jederzeit, im laufenden Spiel nur
   * jemanden, der offline ist – sonst ließe sich das zum Rauswerfen missbrauchen.
   */
  kickPlayer(hostId, targetId) {
    if (hostId !== this.hostId) throw new GameError('Nur der Host kann Spieler entfernen.');
    const target = this.findById(targetId);
    if (!target) throw new GameError('Spieler nicht gefunden.');
    if (target.id === hostId) throw new GameError('Du kannst dich nicht selbst entfernen.');

    if (this.phase === 'lobby') {
      this.players = this.players.filter((p) => p.id !== targetId);
      this._log(`${target.name} wurde aus dem Raum entfernt.`);
      this._afterChange();
      return target;
    }
    if (target.connected && !target.bot) throw new GameError('Im laufenden Spiel lassen sich nur offline Spieler entfernen.');
    if (!target.alive) throw new GameError('Dieser Spieler ist bereits draußen.');

    const wasCurrent = this.currentPlayer && this.currentPlayer.id === target.id;
    target.alive = false;
    target.removed = true;
    target.turnsLeft = 0;
    target.hand.forEach((c) => this.discard.push(c.id));
    target.hand = [];
    this._log(`${target.name} wurde vom Host aus der Runde genommen.`);
    if (this.prompt && this.prompt.playerId === target.id) {
      clearTimeout(this._timers.prompt);
      this.prompt = null;
    }
    if (!this._checkWinner()) {
      if (wasCurrent) this._advanceTurn(1);
      else this._afterChange();
    }
    return target;
  }

  /* ---------------------------------------------------------- Einstellungen */

  updateSettings(playerId, patch = {}) {
    if (playerId !== this.hostId) throw new GameError('Nur der Host kann die Einstellungen ändern.');
    if (this.phase === 'playing') throw new GameError('Während einer Runde lassen sich die Regeln nicht ändern.');
    for (const [key, allowed] of Object.entries(SETTING_RANGES)) {
      if (!(key in patch)) continue;
      const value = Number(patch[key]);
      if (!allowed.includes(value)) throw new GameError(`Ungültiger Wert für ${key}.`);
      this.settings[key] = value;
    }
    this._log('Der Host hat die Hausregeln angepasst.');
    this._afterChange();
    return this.settings;
  }

  /* -------------------------------------------------------------------- Start */

  start(playerId) {
    if (playerId !== this.hostId) throw new GameError('Nur der Host kann das Spiel starten.');
    if (this.phase === 'playing') throw new GameError('Das Spiel läuft bereits.');
    const participants = this.players.filter((p) => p.connected);
    if (!participants.some((p) => !p.bot)) throw new GameError('Mindestens ein menschlicher Spieler wird benötigt.');
    if (participants.length < MIN_PLAYERS) throw new GameError('Mindestens zwei Mitspieler werden benötigt – Bots zählen mit.');

    this._clearTimers();
    this.players = participants;
    this._reassignHost();

    const count = this.players.length;
    const { startCards, extraBombs } = this.settings;
    const pool = shuffle(buildPool(count));
    const needed = count * startCards;
    if (pool.length < needed + 4) throw new GameError('Zu viele Startkarten für diese Spielerzahl.');

    this.players.forEach((p) => {
      p.hand = [{ uid: nextUid(), id: 'defuse' }];
      for (let i = 0; i < startCards; i++) p.hand.push({ uid: nextUid(), id: pool.pop() });
      p.alive = true;
      p.spectator = false;
      p.removed = false;
      p.turnsLeft = 0;
    });

    const rest = pool;
    const extraDefuses = Math.max(0, defuseCount(count) - count);
    for (let i = 0; i < extraDefuses; i++) rest.push('defuse');
    const bombs = Math.max(1, count - 1 + extraBombs);
    this.bombsInPlay = bombs;
    for (let i = 0; i < bombs; i++) rest.push('bomb');

    this.deck = shuffle(rest).map((id) => ({ uid: nextUid(), id }));
    this.discard = [];
    this.pending = null;
    this.prompt = null;
    this.peeks = {};
    this.winnerId = null;
    this.lastPlay = null;
    this.phase = 'playing';
    this.round += 1;
    this.currentIndex = Math.floor(Math.random() * this.players.length);
    this.players[this.currentIndex].turnsLeft = 1;
    this.log = [];
    this._log(`Runde ${this.round} startet mit ${count} Spielern – ${bombs} ${bombs === 1 ? 'Bombe' : 'Bomben'} im Stapel.`);
    this._log(`${this.currentPlayer.name} beginnt.`);
    this._refreshTurnClock();
    this._afterChange();
  }

  resetToLobby(playerId) {
    if (playerId !== this.hostId) throw new GameError('Nur der Host kann zurück in die Lobby.');
    this._clearTimers();
    this.phase = 'lobby';
    this.players = this.players.filter((p) => p.connected);
    this.players.forEach((p) => {
      p.hand = [];
      p.alive = true;
      p.spectator = false;
      p.removed = false;
      p.turnsLeft = 0;
    });
    this._reassignHost();
    this.deck = [];
    this.discard = [];
    this.pending = null;
    this.prompt = null;
    this.peeks = {};
    this.winnerId = null;
    this.lastPlay = null;
    this.turnDeadline = null;
    this._log('Zurück in der Lobby. Der Host kann eine neue Runde starten.');
    this._afterChange();
  }

  get currentPlayer() {
    return this.players[this.currentIndex] || null;
  }

  /* ------------------------------------------------------------- Karten spielen */

  playCards(playerId, uids, opts = {}) {
    const player = this._requirePlayer(playerId);
    if (this.phase !== 'playing') throw new GameError('Das Spiel läuft gerade nicht.');
    if (!Array.isArray(uids) || uids.length === 0) throw new GameError('Keine Karte ausgewählt.');
    if (this.pending) throw new GameError('Warte, bis die aktuelle Aktion aufgelöst ist.');
    if (this.prompt) throw new GameError('Warte, bis die offene Entscheidung getroffen ist.');
    if (this.currentPlayer.id !== playerId) throw new GameError('Du bist nicht am Zug.');
    if (new Set(uids).size !== uids.length) throw new GameError('Ungültige Auswahl.');

    const cards = uids.map((uid) => {
      const card = player.hand.find((c) => c.uid === uid);
      if (!card) throw new GameError('Diese Karte hast du nicht.');
      return card;
    });

    const ids = cards.map((c) => c.id);
    const allCats = ids.every((id) => CARDS[id].kind === 'cat');
    const allSame = ids.every((id) => id === ids[0]);
    let action;

    if (cards.length === 1) {
      const id = ids[0];
      const info = CARDS[id];
      if (info.kind === 'bomb' || info.kind === 'defuse') throw new GameError('Diese Karte kann man nicht einfach ausspielen.');
      if (info.kind === 'nope') throw new GameError('Nope kannst du nur als Antwort auf eine Aktion spielen.');
      if (info.kind === 'cat') throw new GameError('Einzelne Katzenkarten haben keine Wirkung.');
      action = { type: id };
      if (info.target) action.targetId = this._requireTarget(playerId, opts.targetId);
    } else if (cards.length === 2 && allCats && allSame) {
      action = { type: 'steal', catId: ids[0], targetId: this._requireTarget(playerId, opts.targetId) };
    } else if (cards.length === 3 && allCats && allSame) {
      const wanted = String(opts.demandCardId || '');
      if (!CARDS[wanted] || wanted === 'bomb') throw new GameError('Sag an, welche Karte du haben willst.');
      action = { type: 'demand', catId: ids[0], targetId: this._requireTarget(playerId, opts.targetId), demandCardId: wanted };
    } else if (cards.length === 5 && allCats && new Set(ids).size === 5) {
      const wanted = String(opts.discardCardId || '');
      if (!this.discard.includes(wanted)) throw new GameError('Diese Karte liegt nicht im Ablagestapel.');
      action = { type: 'fromDiscard', discardCardId: wanted };
    } else {
      throw new GameError('Diese Kombination ist nicht spielbar.');
    }

    cards.forEach((card) => {
      player.hand = player.hand.filter((c) => c.uid !== card.uid);
      this.discard.push(card.id);
    });

    const label = this._actionLabel(action);
    const targetName = action.targetId && this.findById(action.targetId) ? this.findById(action.targetId).name : null;
    this._log(`${player.name} spielt ${label}${targetName ? ` gegen ${targetName}` : ''}.`);
    this.lastPlay = { cardId: this._actionCardId(action), playerName: player.name };
    this.turnDeadline = null;

    this.pending = {
      action,
      byId: playerId,
      lastActorId: playerId,
      nopeLayers: 0,
      passes: [],
      deadline: Date.now() + this._nopeWindowMs()
    };
    this._armPending();
    this._afterChange();
  }

  _nopeWindowMs() {
    return Math.max(0, Number(this.settings.nopeSeconds) || 0) * 1000;
  }

  _actionLabel(action) {
    switch (action.type) {
      case 'steal': return `zwei ${CARDS[action.catId].name}n`;
      case 'demand': return `drei ${CARDS[action.catId].name}n`;
      case 'fromDiscard': return 'fünf verschiedene Katzen';
      default: return CARDS[action.type].name;
    }
  }

  _actionCardId(action) {
    if (action.type === 'steal' || action.type === 'demand') return action.catId;
    if (action.type === 'fromDiscard') return 'cat_rainbow';
    return action.type;
  }

  playNope(playerId) {
    const player = this._requirePlayer(playerId);
    if (!this.pending) throw new GameError('Gerade gibt es keine Aktion zum Nopen.');
    const card = player.hand.find((c) => c.id === 'nope');
    if (!card) throw new GameError('Du hast keine Nope-Karte.');
    player.hand = player.hand.filter((c) => c.uid !== card.uid);
    this.discard.push('nope');
    this.pending.nopeLayers += 1;
    this.pending.lastActorId = playerId;
    this.pending.passes = [];
    this.pending.deadline = Date.now() + Math.max(this._nopeWindowMs(), 2500);
    this.lastPlay = { cardId: 'nope', playerName: player.name };
    this._log(`${player.name} spielt Nope! (${this.pending.nopeLayers}×)`);
    this.hooks.fx({ type: 'nope', name: player.name, layers: this.pending.nopeLayers });
    this._armPending();
    this._afterChange();
  }

  passNope(playerId) {
    const player = this._requirePlayer(playerId);
    if (!this.pending) return;
    if (!this.pending.passes.includes(player.id)) this.pending.passes.push(player.id);
    if (this._nopeCandidates().length === 0) this._resolvePending();
    else this._afterChange();
  }

  /** Wer darf überhaupt ein Nope spielen – auch auf die eigene Karte. */
  _canNope(player) {
    return Boolean(this.pending) && player.alive && !player.spectator
      && player.hand.some((c) => c.id === 'nope');
  }

  /** Auf wen wartet das Nope-Fenster noch? */
  _nopeCandidates() {
    if (!this.pending) return [];
    return this.players.filter((p) =>
      p.alive && !p.spectator && p.connected &&
      p.id !== this.pending.lastActorId &&
      !this.pending.passes.includes(p.id) &&
      p.hand.some((c) => c.id === 'nope'));
  }

  _armPending() {
    clearTimeout(this._timers.nope);
    this._timers.nope = null;
    if (!this.pending) return;
    if (this._nopeCandidates().length === 0) {
      const delay = this._nopeWindowMs() === 0 ? 0 : 600;
      this.pending.deadline = Date.now() + delay;
      this._timers.nope = setTimeout(() => this._resolvePending(), delay);
      return;
    }
    this._timers.nope = setTimeout(() => this._resolvePending(), Math.max(0, this.pending.deadline - Date.now()));
  }

  _resolvePending() {
    clearTimeout(this._timers.nope);
    this._timers.nope = null;
    const pending = this.pending;
    this.pending = null;
    if (!pending || this.phase !== 'playing') return;

    if (pending.nopeLayers % 2 === 1) {
      this._log('Die Aktion wurde aufgehoben.');
      this._refreshTurnClock();
      this._afterChange();
      return;
    }
    this._applyAction(pending);
  }

  _applyAction(pending) {
    const player = this.findById(pending.byId);
    const { action } = pending;
    if (!player || !player.alive) {
      this._refreshTurnClock();
      this._afterChange();
      return;
    }

    switch (action.type) {
      case 'skip':
        this._log(`${player.name} überspringt das Ziehen.`);
        this._endTurn();
        break;

      case 'attack': {
        const remaining = Math.max(0, player.turnsLeft - 1);
        player.turnsLeft = 0;
        const next = this._advanceTurn(remaining + 2);
        if (next) {
          this._log(`${next.name} muss jetzt ${next.turnsLeft} Züge machen.`);
          this.hooks.fx({ type: 'attack', name: next.name });
        }
        break;
      }

      case 'shuffle':
        shuffle(this.deck);
        this.peeks = {};
        this._log('Der Stapel wurde gemischt.');
        this._finishAction();
        break;

      case 'future': {
        this.peeks[player.id] = this.deck.slice(-3).reverse().map((c) => c.id);
        this._log(`${player.name} schaut in die Zukunft.`);
        this._finishAction();
        break;
      }

      case 'favor': {
        const target = this.findById(action.targetId);
        if (!target || !target.alive) { this._finishAction(); break; }
        if (target.hand.length === 0) {
          this._log(`${target.name} hat keine Karten – der Gefallen verfällt.`);
          this._finishAction();
          break;
        }
        this._setPrompt({ type: 'favor', playerId: target.id, requesterId: player.id });
        break;
      }

      case 'steal': {
        const target = this.findById(action.targetId);
        if (!target || !target.alive) { this._finishAction(); break; }
        if (target.hand.length === 0) {
          this._log(`${target.name} hat keine Karten – nichts zu klauen.`);
          this._finishAction();
          break;
        }
        const card = pick(target.hand);
        target.hand = target.hand.filter((c) => c.uid !== card.uid);
        player.hand.push(card);
        this._log(`${player.name} klaut ${target.name} eine Karte.`);
        this.hooks.fx({ type: 'steal', name: player.name, victim: target.name });
        this.hooks.toPlayer(player.id, 'toast', `Du hast ${CARDS[card.id].name} von ${target.name} geklaut.`);
        this.hooks.toPlayer(target.id, 'toast', `${player.name} hat dir ${CARDS[card.id].name} geklaut.`);
        this._finishAction();
        break;
      }

      case 'demand': {
        const target = this.findById(action.targetId);
        if (!target || !target.alive) { this._finishAction(); break; }
        const wanted = CARDS[action.demandCardId];
        const card = target.hand.find((c) => c.id === action.demandCardId);
        if (card) {
          target.hand = target.hand.filter((c) => c.uid !== card.uid);
          player.hand.push(card);
          this._log(`${player.name} fordert ${wanted.name} von ${target.name} – und bekommt sie.`);
          this.hooks.fx({ type: 'steal', name: player.name, victim: target.name });
          this.hooks.toPlayer(target.id, 'toast', `${player.name} hat dir ${wanted.name} abgenommen.`);
        } else {
          this._log(`${target.name} hat keine ${wanted.name} – die Forderung läuft ins Leere.`);
        }
        this._finishAction();
        break;
      }

      case 'fromDiscard': {
        const idx = this.discard.lastIndexOf(action.discardCardId);
        if (idx === -1) {
          this._log('Die gewünschte Karte liegt nicht mehr im Ablagestapel.');
        } else {
          this.discard.splice(idx, 1);
          player.hand.push({ uid: nextUid(), id: action.discardCardId });
          this._log(`${player.name} holt ${CARDS[action.discardCardId].name} aus dem Ablagestapel.`);
        }
        this._finishAction();
        break;
      }

      default:
        this._finishAction();
    }
  }

  /** Aktion erledigt, der Zug läuft weiter – Zug-Uhr neu starten. */
  _finishAction() {
    this._refreshTurnClock();
    this._afterChange();
  }

  /* ---------------------------------------------------------------- Nachziehen */

  draw(playerId) {
    const player = this._requirePlayer(playerId);
    if (this.phase !== 'playing') throw new GameError('Das Spiel läuft gerade nicht.');
    if (this.pending) throw new GameError('Warte, bis die aktuelle Aktion aufgelöst ist.');
    if (this.prompt) throw new GameError('Warte, bis die offene Entscheidung getroffen ist.');
    if (this.currentPlayer.id !== playerId) throw new GameError('Du bist nicht am Zug.');
    this._drawFor(player);
  }

  _drawFor(player) {
    if (this.deck.length === 0) this._refillDeck();
    const card = this.deck.pop();
    delete this.peeks[player.id];

    if (!card) {
      this._log('Der Stapel ist leer – der Zug endet.');
      this._endTurn();
      return;
    }

    if (card.id === 'bomb') {
      const defuse = player.hand.find((c) => c.id === 'defuse');
      this._log(`${player.name} zieht ein Explodierendes Kätzchen!`);
      this.lastPlay = { cardId: 'bomb', playerName: player.name };
      if (defuse) {
        player.hand = player.hand.filter((c) => c.uid !== defuse.uid);
        this.discard.push('defuse');
        this._log(`${player.name} entschärft die Bombe und steckt sie zurück.`);
        this.hooks.fx({ type: 'defuse', name: player.name });
        this._setPrompt({ type: 'defuse', playerId: player.id, bomb: card });
        return;
      }
      this.discard.push('bomb');
      player.alive = false;
      player.turnsLeft = 0;
      player.hand.forEach((c) => this.discard.push(c.id));
      player.hand = [];
      this._log(`💥 ${player.name} ist ausgeschieden.`);
      this.hooks.fx({ type: 'bomb', name: player.name });
      if (!this._checkWinner()) this._advanceTurn(1);
      return;
    }

    player.hand.push(card);
    this.hooks.toPlayer(player.id, 'toast', `Du hast ${CARDS[card.id].name} gezogen.`);
    this._log(`${player.name} zieht eine Karte.`);
    this._endTurn();
  }

  _refillDeck() {
    if (this.discard.length === 0) return;
    this._log('Der Nachziehstapel wird aus dem Ablagestapel neu gemischt.');
    this.deck = shuffle(this.discard.filter((id) => id !== 'bomb')).map((id) => ({ uid: nextUid(), id }));
    this.discard = [];
  }

  /* ------------------------------------------------------------ Entscheidungen */

  _setPrompt(prompt) {
    this.prompt = { ...prompt, deadline: Date.now() + PROMPT_TIMEOUT_MS };
    this.turnDeadline = null;
    clearTimeout(this._timers.prompt);
    this._timers.prompt = setTimeout(() => this._autoPrompt(), PROMPT_TIMEOUT_MS);
    this._afterChange();
  }

  _autoPrompt() {
    const prompt = this.prompt;
    if (!prompt) return;
    if (prompt.type === 'defuse') {
      this.respondPrompt(prompt.playerId, { position: Math.floor(Math.random() * (this.deck.length + 1)) }, true);
    } else if (prompt.type === 'favor') {
      const target = this.findById(prompt.playerId);
      const card = target && target.hand.length ? pick(target.hand) : null;
      if (card) this.respondPrompt(prompt.playerId, { uid: card.uid }, true);
      else { this.prompt = null; this._finishAction(); }
    }
  }

  respondPrompt(playerId, data = {}, auto = false) {
    const prompt = this.prompt;
    if (!prompt) throw new GameError('Es gibt gerade keine Entscheidung zu treffen.');
    if (prompt.playerId !== playerId) throw new GameError('Diese Entscheidung ist nicht für dich.');
    clearTimeout(this._timers.prompt);
    this._timers.prompt = null;
    const player = this.findById(playerId);

    if (prompt.type === 'defuse') {
      const max = this.deck.length;
      let position = Number.isFinite(Number(data.position)) ? Math.round(Number(data.position)) : 0;
      position = Math.min(Math.max(position, 0), max);
      this.deck.splice(max - position, 0, prompt.bomb);
      this.prompt = null;
      this._log(`${player.name} versteckt die Bombe im Stapel${auto ? ' (automatisch)' : ''}.`);
      this.hooks.toPlayer(playerId, 'toast', position === 0
        ? 'Die Bombe liegt jetzt ganz oben.'
        : `Die Bombe liegt an Position ${position + 1} von oben.`);
      this._endTurn();
      return;
    }

    if (prompt.type === 'favor') {
      const requester = this.findById(prompt.requesterId);
      const card = player.hand.find((c) => c.uid === data.uid) || (player.hand.length ? pick(player.hand) : null);
      this.prompt = null;
      if (card && requester && requester.alive) {
        player.hand = player.hand.filter((c) => c.uid !== card.uid);
        requester.hand.push(card);
        this._log(`${player.name} gibt ${requester.name} eine Karte${auto ? ' (automatisch)' : ''}.`);
        this.hooks.toPlayer(requester.id, 'toast', `${player.name} gibt dir ${CARDS[card.id].name}.`);
      }
      this._finishAction();
      return;
    }

    this.prompt = null;
    this._finishAction();
  }

  clearPeek(playerId) {
    delete this.peeks[playerId];
    this._afterChange();
  }

  /* -------------------------------------------------------------------- Züge */

  _endTurn() {
    const player = this.currentPlayer;
    if (!player) return;
    player.turnsLeft = Math.max(0, player.turnsLeft - 1);
    if (player.alive && player.turnsLeft > 0) {
      this._log(`${player.name} hat noch ${player.turnsLeft} Zug${player.turnsLeft > 1 ? 'e' : ''}.`);
      this._refreshTurnClock();
      this._afterChange();
      return;
    }
    this._advanceTurn(1);
  }

  _advanceTurn(turns) {
    if (this._checkWinner()) return null;
    const total = this.players.length;
    for (let step = 1; step <= total; step++) {
      const idx = (this.currentIndex + step) % total;
      const candidate = this.players[idx];
      if (candidate.alive && !candidate.spectator) {
        this.currentIndex = idx;
        candidate.turnsLeft = turns;
        delete this.peeks[candidate.id];
        this._log(`${candidate.name} ist am Zug.`);
        this._refreshTurnClock();
        this._afterChange();
        return candidate;
      }
    }
    this._afterChange();
    return null;
  }

  _refreshTurnClock() {
    const seconds = Number(this.settings.turnSeconds) || 0;
    this.turnDeadline = (seconds > 0 && this.phase === 'playing' && !this.pending && !this.prompt)
      ? Date.now() + seconds * 1000
      : null;
  }

  _checkWinner() {
    if (this.phase !== 'playing') return false;
    const alive = this.alivePlayers;
    if (alive.length <= 1) {
      this.phase = 'finished';
      this.winnerId = alive.length ? alive[0].id : null;
      this._clearTimers();
      this.pending = null;
      this.prompt = null;
      this.peeks = {};
      this.turnDeadline = null;
      this._log(this.winnerId
        ? `🏆 ${this.findById(this.winnerId).name} gewinnt die Runde!`
        : 'Runde beendet – kein Gewinner.');
      if (this.winnerId) this.hooks.fx({ type: 'win', name: this.findById(this.winnerId).name });
      this._afterChange();
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------- Automatik & Timer */

  _afterChange() {
    this._touch();
    this._scheduleAuto();
    this.hooks.broadcast();
    this.hooks.onChange();
  }

  _scheduleAuto() {
    clearTimeout(this._timers.auto);
    clearTimeout(this._timers.bot);
    this._timers.auto = null;
    this._timers.bot = null;
    if (this.phase !== 'playing') return;

    // Ohne Zuschauer spielen die Bots nicht weiter
    const humansWatching = this.players.some((p) => !p.bot && p.connected);

    if (this.prompt) {
      const owner = this.findById(this.prompt.playerId);
      if (owner && owner.bot && humansWatching) {
        this._timers.bot = setTimeout(() => this._botPrompt(owner.id), bots.thinkingTime(owner.level, 'prompt'));
      } else if (owner && !owner.connected) {
        this._timers.auto = setTimeout(() => this._autoPrompt(), 2000);
      }
      return;
    }
    if (this.pending) {
      const bot = this._nopeCandidates().find((p) => p.bot);
      if (bot && humansWatching) {
        this._timers.bot = setTimeout(() => this._botNope(bot.id), bots.thinkingTime(bot.level, 'nope'));
      }
      return;
    }

    const player = this.currentPlayer;
    if (!player || !player.alive) return;

    if (player.bot) {
      if (humansWatching) {
        this._timers.bot = setTimeout(() => this._botTurn(player.id), bots.thinkingTime(player.level, 'turn'));
      }
      return;
    }

    let delay = null;
    let reason = '';
    if (!player.connected) {
      delay = OFFLINE_AUTOPLAY_MS;
      reason = 'ist offline';
    } else if (this.turnDeadline) {
      delay = Math.max(0, this.turnDeadline - Date.now());
      reason = 'hat die Zugzeit überschritten';
    }
    if (delay === null) return;

    this._timers.auto = setTimeout(() => {
      const cur = this.currentPlayer;
      if (this.phase !== 'playing' || !cur || this.pending || this.prompt || cur.id !== player.id) return;
      this._log(`${cur.name} ${reason} – es wird automatisch gezogen.`);
      this._drawFor(cur);
    }, delay);
  }

  /* ------------------------------------------------------------- Bot-Züge */

  _botTurn(botId) {
    const bot = this.findById(botId);
    if (this.phase !== 'playing' || this.pending || this.prompt) return;
    if (!bot || !bot.bot || !bot.alive || this.currentPlayer.id !== botId) return;
    let decision;
    try {
      decision = bots.decideTurn(this, bot);
    } catch (err) {
      decision = { type: 'draw' };
    }
    try {
      if (decision && decision.type === 'play') this.playCards(botId, decision.uids, decision.opts || {});
      else this.draw(botId);
    } catch (err) {
      // Lieber ziehen als die Runde blockieren
      try { this.draw(botId); } catch { /* Zug ist bereits vorbei */ }
    }
  }

  _botNope(botId) {
    const bot = this.findById(botId);
    if (!this.pending || !bot || !bot.bot) return;
    if (!this._nopeCandidates().some((p) => p.id === botId)) return;
    let wantsNope = false;
    try {
      wantsNope = bots.decideNope(this, bot, this.pending);
    } catch { wantsNope = false; }
    try {
      if (wantsNope) this.playNope(botId);
      else this.passNope(botId);
    } catch { /* Fenster ist schon zu */ }
  }

  _botPrompt(botId) {
    const bot = this.findById(botId);
    if (!this.prompt || !bot || !bot.bot || this.prompt.playerId !== botId) return;
    try {
      if (this.prompt.type === 'defuse') {
        this.respondPrompt(botId, { position: bots.decideDefusePosition(this, bot) });
      } else if (this.prompt.type === 'favor') {
        this.respondPrompt(botId, { uid: bots.decideFavorCard(this, bot) });
      }
    } catch { /* Entscheidung ist schon gefallen */ }
  }

  _clearTimers() {
    Object.keys(this._timers).forEach((key) => {
      clearTimeout(this._timers[key]);
      this._timers[key] = null;
    });
  }

  dispose() {
    this._clearTimers();
  }

  /* ------------------------------------------------------------------ Helpers */

  _requirePlayer(playerId) {
    const player = this.findById(playerId);
    if (!player) throw new GameError('Spieler nicht gefunden.');
    if (player.spectator) throw new GameError('Du bist Zuschauer und in der nächsten Runde dabei.');
    if (!player.alive) throw new GameError('Du bist in dieser Runde ausgeschieden.');
    return player;
  }

  _requireTarget(playerId, targetId) {
    const target = this.findById(targetId);
    if (!target || !target.alive || target.spectator || target.id === playerId) {
      throw new GameError('Wähle einen gültigen Mitspieler.');
    }
    return target.id;
  }

  _log(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > LOG_LIMIT) this.log = this.log.slice(-LOG_LIMIT);
  }

  _touch() {
    this.updatedAt = Date.now();
  }

  /* ------------------------------------------------------------- Serialisierung */

  viewFor(playerId) {
    const me = this.findById(playerId);
    const current = this.currentPlayer;
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      youId: playerId,
      settings: { ...this.settings },
      settingRanges: SETTING_RANGES,
      botLevels: bots.LEVELS,
      botLevelNames: bots.LEVEL_NAMES,
      currentId: this.phase === 'playing' && current ? current.id : null,
      turnDeadline: this.turnDeadline,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discardTop: this.discard.slice(-1)[0] || null,
      discardPile: this.discard.slice(),
      lastPlay: this.lastPlay,
      winnerId: this.winnerId,
      winnerName: this.winnerId && this.findById(this.winnerId) ? this.findById(this.winnerId).name : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: AVATARS[p.avatar % AVATARS.length].color,
        emoji: AVATARS[p.avatar % AVATARS.length].emoji,
        handCount: p.hand.length,
        alive: p.alive,
        spectator: p.spectator,
        removed: Boolean(p.removed),
        connected: p.connected,
        bot: Boolean(p.bot),
        level: p.bot ? p.level : null,
        isHost: p.id === this.hostId,
        turnsLeft: p.turnsLeft,
        hasNope: this.phase === 'playing' && p.hand.some((c) => c.id === 'nope') && p.id === playerId
      })),
      you: me ? {
        id: me.id,
        name: me.name,
        color: AVATARS[me.avatar % AVATARS.length].color,
        emoji: AVATARS[me.avatar % AVATARS.length].emoji,
        alive: me.alive,
        spectator: me.spectator,
        isHost: me.id === this.hostId,
        isCurrent: Boolean(current && current.id === me.id && this.phase === 'playing'),
        turnsLeft: me.turnsLeft,
        hand: me.hand.map((c) => ({ uid: c.uid, id: c.id }))
      } : null,
      peek: me ? this.peeks[me.id] || null : null,
      pending: this.pending ? {
        label: this._actionLabel(this.pending.action),
        cardId: this._actionCardId(this.pending.action),
        byName: this.findById(this.pending.byId) ? this.findById(this.pending.byId).name : '?',
        targetName: this.pending.action.targetId && this.findById(this.pending.action.targetId)
          ? this.findById(this.pending.action.targetId).name : null,
        detail: this.pending.action.type === 'demand' ? CARDS[this.pending.action.demandCardId].name
          : (this.pending.action.type === 'fromDiscard' ? CARDS[this.pending.action.discardCardId].name : null),
        nopeLayers: this.pending.nopeLayers,
        cancelled: this.pending.nopeLayers % 2 === 1,
        deadline: this.pending.deadline,
        windowMs: Math.max(this._nopeWindowMs(), 2500),
        youCanNope: Boolean(me && this._canNope(me)),
        waitingFor: this._nopeCandidates().map((p) => p.name)
      } : null,
      prompt: this.prompt && me && this.prompt.playerId === me.id ? {
        type: this.prompt.type,
        deadline: this.prompt.deadline,
        deckSize: this.prompt.type === 'defuse' ? this.deck.length : undefined,
        requesterName: this.prompt.requesterId && this.findById(this.prompt.requesterId)
          ? this.findById(this.prompt.requesterId).name : null
      } : null,
      promptInfo: this.prompt ? {
        type: this.prompt.type,
        playerName: this.findById(this.prompt.playerId) ? this.findById(this.prompt.playerId).name : '?'
      } : null,
      log: this.log.slice(-30)
    };
  }

  /** Momentaufnahme für die Wiederherstellung nach einem Neustart. */
  toJSON() {
    const snapshot = {
      code: this.code,
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      settings: this.settings,
      bombsInPlay: this.bombsInPlay,
      deck: this.deck,
      discard: this.discard,
      currentIndex: this.currentIndex,
      winnerId: this.winnerId,
      lastPlay: this.lastPlay,
      log: this.log.slice(-20),
      peeks: this.peeks,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      players: this.players.map((p) => ({
        id: p.id, token: p.token, name: p.name, avatar: p.avatar, hand: p.hand,
        bot: Boolean(p.bot), level: p.level || null,
        alive: p.alive, spectator: p.spectator, removed: Boolean(p.removed), turnsLeft: p.turnsLeft
      }))
    };
    // Eine Bombe, die gerade entschärft wird, darf nicht verloren gehen.
    if (this.prompt && this.prompt.type === 'defuse' && this.prompt.bomb) {
      snapshot.deck = snapshot.deck.concat([this.prompt.bomb]);
    }
    return snapshot;
  }

  static fromJSON(data, hooks) {
    const game = new Game(data.code, hooks);
    game.phase = data.phase === 'playing' ? 'playing' : data.phase;
    game.round = data.round || 0;
    game.hostId = data.hostId || null;
    game.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    game.bombsInPlay = data.bombsInPlay || 0;
    game.deck = Array.isArray(data.deck) ? data.deck : [];
    game.discard = Array.isArray(data.discard) ? data.discard : [];
    game.currentIndex = data.currentIndex || 0;
    game.winnerId = data.winnerId || null;
    game.lastPlay = data.lastPlay || null;
    game.log = Array.isArray(data.log) ? data.log : [];
    game.peeks = data.peeks || {};
    game.createdAt = data.createdAt || Date.now();
    game.updatedAt = data.updatedAt || Date.now();
    game.players = (data.players || []).map((p) => ({
      id: p.id,
      token: p.token,
      name: p.name,
      avatar: typeof p.avatar === 'number' ? p.avatar : 0,
      socketId: null,
      connected: Boolean(p.bot),
      bot: Boolean(p.bot),
      level: p.level || null,
      hand: Array.isArray(p.hand) ? p.hand : [],
      alive: Boolean(p.alive),
      spectator: Boolean(p.spectator),
      removed: Boolean(p.removed),
      turnsLeft: p.turnsLeft || 0
    }));
    if (game.currentIndex >= game.players.length) game.currentIndex = 0;
    if (game.phase === 'playing') game._log('Der Server wurde neu gestartet – offene Aktionen wurden verworfen.');
    return game;
  }
}

module.exports = {
  Game, GameError, MIN_PLAYERS, MAX_PLAYERS,
  DEFAULT_SETTINGS, SETTING_RANGES, AVATARS, BOT_LEVELS: bots.LEVELS
};
