'use strict';

const { CARDS, buildPool, defuseCount } = require('./cards');

const NOPE_WINDOW_MS = 6000;
const PROMPT_TIMEOUT_MS = 30000;
const AUTOPLAY_DELAY_MS = 20000;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const LOG_LIMIT = 60;

let uidCounter = 0;
const nextUid = () => `k${(++uidCounter).toString(36)}`;

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
 * Eine Spielrunde in einem Raum. Der komplette Zustand liegt im Speicher;
 * es gibt keine Datenbank und keine Accounts.
 */
class Game {
  /**
   * @param {string} code vierstelliger Raumcode
   * @param {{broadcast: Function, toPlayer: Function}} hooks
   */
  constructor(code, hooks) {
    this.code = code;
    this.hooks = hooks;
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | playing | finished
    this.deck = [];
    this.discard = [];
    this.currentIndex = 0;
    this.pending = null;
    this.prompt = null;
    this.peeks = {}; // playerId -> [cardId]
    this.log = [];
    this.winnerId = null;
    this.lastPlay = null;
    this.round = 0;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this._timers = { nope: null, prompt: null, auto: null };
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

  addPlayer({ name, token, socketId }) {
    const clean = String(name || '').trim().slice(0, 16) || 'Katze';
    if (this.players.length >= MAX_PLAYERS) throw new GameError('Dieser Raum ist voll (max. 8 Spieler).');
    const taken = this.players.some((p) => p.name.toLowerCase() === clean.toLowerCase());
    const player = {
      id: nextUid(),
      token,
      name: taken ? `${clean}#${this.players.length + 1}` : clean,
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
      this._log(`${player.name} ist offline – Züge werden nach kurzer Wartezeit automatisch gespielt.`);
    }
    if (this.hostId === player.id) {
      const next = this.players.find((p) => p.connected) || this.players[0];
      this.hostId = next ? next.id : null;
    }
    this._touch();
    return player;
  }

  get connectedCount() {
    return this.players.filter((p) => p.connected).length;
  }

  /* -------------------------------------------------------------------- Start */

  start(playerId) {
    if (playerId !== this.hostId) throw new GameError('Nur der Host kann das Spiel starten.');
    if (this.phase === 'playing') throw new GameError('Das Spiel läuft bereits.');
    const participants = this.players.filter((p) => p.connected);
    if (participants.length < MIN_PLAYERS) throw new GameError('Mindestens zwei Spieler werden benötigt.');

    this._clearTimers();
    this.players = participants;
    if (!this.players.some((p) => p.id === this.hostId)) this.hostId = this.players[0].id;

    const count = this.players.length;
    const pool = shuffle(buildPool(count));

    this.players.forEach((p) => {
      p.hand = [{ uid: nextUid(), id: 'defuse' }];
      for (let i = 0; i < 7; i++) p.hand.push({ uid: nextUid(), id: pool.pop() });
      p.alive = true;
      p.spectator = false;
      p.turnsLeft = 0;
    });

    const rest = pool;
    const extraDefuses = defuseCount(count) - count;
    for (let i = 0; i < extraDefuses; i++) rest.push('defuse');
    for (let i = 0; i < count - 1; i++) rest.push('bomb');

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
    const bombs = count - 1;
    this._log(`Runde ${this.round} startet mit ${count} Spielern – ${bombs} ${bombs === 1 ? 'Bombe' : 'Bomben'} im Stapel.`);
    this._log(`${this.currentPlayer.name} beginnt.`);
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
      p.turnsLeft = 0;
    });
    if (!this.players.some((p) => p.id === this.hostId) && this.players.length) this.hostId = this.players[0].id;
    this.deck = [];
    this.discard = [];
    this.pending = null;
    this.prompt = null;
    this.peeks = {};
    this.winnerId = null;
    this.lastPlay = null;
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

    const cards = uids.map((uid) => {
      const card = player.hand.find((c) => c.uid === uid);
      if (!card) throw new GameError('Diese Karte hast du nicht.');
      return card;
    });
    if (new Set(uids).size !== uids.length) throw new GameError('Ungültige Auswahl.');

    const ids = cards.map((c) => c.id);
    let action;

    if (cards.length === 1) {
      const id = ids[0];
      const info = CARDS[id];
      if (info.kind === 'bomb' || info.kind === 'defuse') throw new GameError('Diese Karte kann man nicht einfach ausspielen.');
      if (info.kind === 'nope') throw new GameError('Nope kannst du nur als Antwort auf eine Aktion spielen.');
      if (info.kind === 'cat') throw new GameError('Katzenkarten funktionieren nur als Paar.');
      action = { type: id };
      if (info.target) {
        action.targetId = this._requireTarget(playerId, opts.targetId);
      }
    } else if (cards.length === 2 && CARDS[ids[0]].kind === 'cat' && ids[0] === ids[1]) {
      action = { type: 'steal', catId: ids[0], targetId: this._requireTarget(playerId, opts.targetId) };
    } else {
      throw new GameError('Diese Kombination ist nicht spielbar (einzelne Aktionskarte oder zwei gleiche Katzen).');
    }

    cards.forEach((card) => {
      player.hand = player.hand.filter((c) => c.uid !== card.uid);
      this.discard.push(card.id);
    });

    const label = action.type === 'steal'
      ? `zwei ${CARDS[action.catId].name}n`
      : CARDS[action.type].name;
    const targetName = action.targetId ? this.findById(action.targetId).name : null;
    this._log(`${player.name} spielt ${label}${targetName ? ` gegen ${targetName}` : ''}.`);
    this.lastPlay = { cardId: action.type === 'steal' ? action.catId : action.type, playerName: player.name };

    this.pending = {
      action,
      byId: playerId,
      lastActorId: playerId,
      nopeLayers: 0,
      passes: [],
      deadline: Date.now() + NOPE_WINDOW_MS
    };
    this._armPending();
    this._afterChange();
  }

  playNope(playerId) {
    const player = this._requirePlayer(playerId);
    if (!this.pending) throw new GameError('Gerade gibt es keine Aktion zum Nopen.');
    if (!this._canNope(player)) throw new GameError('Du kannst diese Aktion nicht nopen.');
    const card = player.hand.find((c) => c.id === 'nope');
    player.hand = player.hand.filter((c) => c.uid !== card.uid);
    this.discard.push('nope');
    this.pending.nopeLayers += 1;
    this.pending.lastActorId = playerId;
    this.pending.passes = [];
    this.pending.deadline = Date.now() + NOPE_WINDOW_MS;
    this.lastPlay = { cardId: 'nope', playerName: player.name };
    this._log(`${player.name} spielt Nope! (${this.pending.nopeLayers}x)`);
    this._armPending();
    this._afterChange();
  }

  passNope(playerId) {
    const player = this._requirePlayer(playerId);
    if (!this.pending) return;
    if (!this.pending.passes.includes(player.id)) this.pending.passes.push(player.id);
    if (this._nopeCandidates().length === 0) {
      this._resolvePending();
    } else {
      this._afterChange();
    }
  }

  _canNope(player) {
    return this._nopeCandidates().some((p) => p.id === player.id);
  }

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
      this.pending.deadline = Date.now() + 700;
      this._timers.nope = setTimeout(() => this._resolvePending(), 700);
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
      this._afterChange();
      return;
    }
    this._applyAction(pending);
  }

  _applyAction(pending) {
    const player = this.findById(pending.byId);
    const { action } = pending;
    if (!player || !player.alive) {
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
        if (next) this._log(`${next.name} muss jetzt ${next.turnsLeft} Züge machen.`);
        break;
      }

      case 'shuffle':
        shuffle(this.deck);
        this.peeks = {};
        this._log('Der Stapel wurde gemischt.');
        this._afterChange();
        break;

      case 'future': {
        const top = this.deck.slice(-3).reverse().map((c) => c.id);
        this.peeks[player.id] = top;
        this._log(`${player.name} schaut in die Zukunft.`);
        this._afterChange();
        break;
      }

      case 'favor': {
        const target = this.findById(action.targetId);
        if (!target || !target.alive) { this._afterChange(); break; }
        if (target.hand.length === 0) {
          this._log(`${target.name} hat keine Karten – der Gefallen verfällt.`);
          this._afterChange();
          break;
        }
        this._setPrompt({ type: 'favor', playerId: target.id, requesterId: player.id });
        break;
      }

      case 'steal': {
        const target = this.findById(action.targetId);
        if (!target || !target.alive) { this._afterChange(); break; }
        if (target.hand.length === 0) {
          this._log(`${target.name} hat keine Karten – nichts zu klauen.`);
          this._afterChange();
          break;
        }
        const card = pick(target.hand);
        target.hand = target.hand.filter((c) => c.uid !== card.uid);
        player.hand.push(card);
        this._log(`${player.name} klaut ${target.name} eine Karte.`);
        this.hooks.toPlayer(player.id, 'toast', `Du hast ${CARDS[card.id].name} von ${target.name} geklaut.`);
        this.hooks.toPlayer(target.id, 'toast', `${player.name} hat dir ${CARDS[card.id].name} geklaut.`);
        this._afterChange();
        break;
      }

      default:
        this._afterChange();
    }
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
        this._setPrompt({ type: 'defuse', playerId: player.id, bomb: card, deckSize: this.deck.length });
        return;
      }
      this.discard.push('bomb');
      player.alive = false;
      player.turnsLeft = 0;
      player.hand.forEach((c) => this.discard.push(c.id));
      player.hand = [];
      this._log(`💥 ${player.name} ist ausgeschieden.`);
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
    clearTimeout(this._timers.prompt);
    this._timers.prompt = setTimeout(() => this._autoPrompt(), PROMPT_TIMEOUT_MS);
    this._afterChange();
  }

  _autoPrompt() {
    const prompt = this.prompt;
    if (!prompt) return;
    if (prompt.type === 'defuse') {
      this.respondPrompt(prompt.playerId, { position: Math.floor(Math.random() * (prompt.deckSize + 1)) }, true);
    } else if (prompt.type === 'favor') {
      const target = this.findById(prompt.playerId);
      const card = target && target.hand.length ? pick(target.hand) : null;
      if (card) this.respondPrompt(prompt.playerId, { uid: card.uid }, true);
      else { this.prompt = null; this._afterChange(); }
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
      this._afterChange();
      return;
    }

    this.prompt = null;
    this._afterChange();
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
      this._afterChange();
      return;
    }
    this._advanceTurn(1);
  }

  /** Gibt den Zug an den nächsten lebenden Spieler weiter. */
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
        this._afterChange();
        return candidate;
      }
    }
    this._afterChange();
    return null;
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
      this._log(this.winnerId
        ? `🏆 ${this.findById(this.winnerId).name} gewinnt die Runde!`
        : 'Runde beendet – kein Gewinner.');
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
  }

  _scheduleAuto() {
    clearTimeout(this._timers.auto);
    this._timers.auto = null;
    if (this.phase !== 'playing') return;

    if (this.prompt) {
      const owner = this.findById(this.prompt.playerId);
      if (owner && !owner.connected) this._timers.auto = setTimeout(() => this._autoPrompt(), 2000);
      return;
    }
    if (this.pending) return;

    const player = this.currentPlayer;
    if (player && player.alive && !player.connected) {
      this._timers.auto = setTimeout(() => {
        const cur = this.currentPlayer;
        if (this.phase === 'playing' && cur && !cur.connected && !this.pending && !this.prompt) {
          this._log(`${cur.name} ist offline – es wird automatisch gezogen.`);
          this._drawFor(cur);
        }
      }, AUTOPLAY_DELAY_MS);
    }
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
      currentId: this.phase === 'playing' && current ? current.id : null,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discardTop: this.discard.slice(-1)[0] || null,
      lastPlay: this.lastPlay,
      winnerId: this.winnerId,
      winnerName: this.winnerId && this.findById(this.winnerId) ? this.findById(this.winnerId).name : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        alive: p.alive,
        spectator: p.spectator,
        connected: p.connected,
        isHost: p.id === this.hostId,
        turnsLeft: p.turnsLeft
      })),
      you: me ? {
        id: me.id,
        name: me.name,
        alive: me.alive,
        spectator: me.spectator,
        isHost: me.id === this.hostId,
        isCurrent: Boolean(current && current.id === me.id && this.phase === 'playing'),
        turnsLeft: me.turnsLeft,
        hand: me.hand.map((c) => ({ uid: c.uid, id: c.id }))
      } : null,
      peek: me ? this.peeks[me.id] || null : null,
      pending: this.pending ? {
        label: this.pending.action.type === 'steal'
          ? `${CARDS[this.pending.action.catId].name}-Paar`
          : CARDS[this.pending.action.type].name,
        cardId: this.pending.action.type === 'steal' ? this.pending.action.catId : this.pending.action.type,
        byName: this.findById(this.pending.byId) ? this.findById(this.pending.byId).name : '?',
        targetName: this.pending.action.targetId && this.findById(this.pending.action.targetId)
          ? this.findById(this.pending.action.targetId).name : null,
        nopeLayers: this.pending.nopeLayers,
        cancelled: this.pending.nopeLayers % 2 === 1,
        deadline: this.pending.deadline,
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
      log: this.log.slice(-25)
    };
  }
}

module.exports = { Game, GameError, MIN_PLAYERS, MAX_PLAYERS };
