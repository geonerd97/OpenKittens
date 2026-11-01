'use strict';

/**
 * Computergegner.
 *
 * Die Bots entscheiden ausschließlich mit Informationen, die auch ein Mensch am
 * Tisch hätte: eigene Handkarten, Stapelgrößen, der offene Ablagestapel, die
 * Kartenzahl der Mitspieler und ein eigener "Blick in die Zukunft". Der Inhalt
 * des Nachziehstapels und fremde Hände werden nie ausgelesen.
 */

const { CARDS, CAT_IDS } = require('./cards');

const LEVELS = ['easy', 'normal', 'smart'];
const LEVEL_NAMES = { easy: 'leicht', normal: 'normal', smart: 'schlau' };

const BOT_NAMES = ['Minka', 'Tiger', 'Fussel', 'Nala', 'Rocky', 'Schnurri', 'Mauzi', 'Panther'];

/** Von "kann ich gut abgeben" bis "behalte ich auf jeden Fall". */
const VALUE_ORDER = [...CAT_IDS, 'shuffle', 'future', 'favor', 'skip', 'attack', 'nope', 'defuse'];

const rnd = (n = 1) => Math.random() * n;
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function freeName(game) {
  const used = new Set(game.players.map((p) => p.name));
  const free = BOT_NAMES.filter((n) => !used.has(n));
  return free.length ? pick(free) : `Bot ${game.players.length + 1}`;
}

/** Bedenkzeit, damit Menschen dem Spiel folgen können. */
function thinkingTime(level, kind) {
  const base = { easy: 700, normal: 1000, smart: 1300 }[level] || 1000;
  if (kind === 'nope') return 500 + rnd(1200);
  if (kind === 'prompt') return base * 0.7 + rnd(400);
  return base + rnd(600);
}

/** Wie wahrscheinlich ist die nächste gezogene Karte eine Bombe? */
function bombRisk(game) {
  if (!game.deck.length) return 0;
  const exploded = game.discard.filter((id) => id === 'bomb').length;
  const left = Math.max(0, (game.bombsInPlay || 0) - exploded);
  return Math.min(1, left / game.deck.length);
}

function handGroups(hand) {
  const groups = {};
  hand.forEach((card) => { (groups[card.id] = groups[card.id] || []).push(card); });
  return groups;
}

function opponents(game, bot) {
  return game.alivePlayers.filter((p) => p.id !== bot.id);
}

function richestOpponent(game, bot) {
  const list = opponents(game, bot).filter((p) => p.hand.length > 0);
  if (!list.length) return null;
  return list.reduce((best, p) => (p.hand.length > best.hand.length ? p : best), list[0]);
}

function firstOf(groups, ids) {
  for (const id of ids) if (groups[id] && groups[id].length) return groups[id][0];
  return null;
}

/**
 * Entscheidung für den eigenen Zug.
 * @returns {{type:'draw'} | {type:'play', uids:string[], opts:object}}
 */
function decideTurn(game, bot) {
  const level = LEVELS.includes(bot.level) ? bot.level : 'normal';
  const groups = handGroups(bot.hand);
  const risk = bombRisk(game);
  const peek = game.peeks[bot.id] || null;
  const knowsTop = Boolean(peek && peek.length);
  const topIsBomb = knowsTop && peek[0] === 'bomb';
  const hasDefuse = Boolean(groups.defuse && groups.defuse.length);
  const foes = opponents(game, bot);
  const target = richestOpponent(game, bot);
  const draw = { type: 'draw' };
  const play = (cards, opts = {}) => ({ type: 'play', uids: cards.map((c) => c.uid), opts });

  /* ------------------------------------------------------------------ leicht */
  if (level === 'easy') {
    if (topIsBomb && groups.skip) return play([groups.skip[0]]);
    if (chance(0.3)) {
      const single = firstOf(groups, ['skip', 'attack', 'shuffle', 'future']);
      if (single) return play([single]);
      const pair = CAT_IDS.map((id) => groups[id]).find((g) => g && g.length >= 2);
      if (pair && target) return play(pair.slice(0, 2), { targetId: target.id });
    }
    return draw;
  }

  /* ---------------------------------------------- schlau: Wissen ausnutzen */
  if (level === 'smart' && knowsTop && !topIsBomb) {
    // Oberste Karte ist sicher – nichts verschwenden, einfach ziehen.
    return draw;
  }

  /* --------------------------------------------------- Gefahr oben im Stapel */
  const danger = topIsBomb || (!knowsTop && risk >= (level === 'smart' ? 0.28 : 0.34));
  if (danger) {
    // Mit Entschärfung in der Hand ist eine bekannte Bombe sogar eine Waffe:
    // ziehen, entschärfen und direkt vor die Nase des Nächsten legen.
    const weaponize = level === 'smart' && topIsBomb && hasDefuse && bot.turnsLeft <= 1 && chance(0.6);
    if (!weaponize) {
      if (groups.attack && foes.length) return play([groups.attack[0]]);
      if (groups.skip) return play([groups.skip[0]]);
      if (groups.shuffle) return play([groups.shuffle[0]]);
      if (!hasDefuse && groups.favor && target) return play([groups.favor[0]], { targetId: target.id });
    }
  }

  /* ------------------------------------------------------- Katzen-Kombinationen */
  const fiveDifferent = CAT_IDS.filter((id) => groups[id] && groups[id].length).slice(0, 5);
  if (fiveDifferent.length === 5 && game.discard.length) {
    const wish = ['defuse', 'nope', 'attack', 'skip'].find((id) => game.discard.includes(id));
    if (wish && (level === 'smart' || chance(0.7))) {
      return play(fiveDifferent.map((id) => groups[id][0]), { discardCardId: wish });
    }
  }

  const triple = CAT_IDS.map((id) => groups[id]).find((g) => g && g.length >= 3);
  if (triple && target && (level === 'smart' || chance(0.8))) {
    const wish = level === 'smart'
      ? (hasDefuse ? 'nope' : 'defuse')
      : pick(['defuse', 'nope', 'skip', 'attack']);
    return play(triple.slice(0, 3), { targetId: target.id, demandCardId: wish });
  }

  const pair = CAT_IDS.map((id) => groups[id]).find((g) => g && g.length >= 2);
  if (pair && target && chance(level === 'smart' ? 0.75 : 0.55)) {
    return play(pair.slice(0, 2), { targetId: target.id });
  }

  /* ------------------------------------------------------------ Vorbereitung */
  if (groups.future && !knowsTop && risk >= (level === 'smart' ? 0.15 : 0.25)) {
    return play([groups.future[0]]);
  }
  if (!hasDefuse && groups.favor && target && chance(level === 'smart' ? 0.6 : 0.35)) {
    return play([groups.favor[0]], { targetId: target.id });
  }
  if (level === 'smart' && !hasDefuse && risk >= 0.4 && groups.shuffle) {
    return play([groups.shuffle[0]]);
  }

  return draw;
}

/** Soll der Bot die laufende Aktion nopen? */
function decideNope(game, bot, pending) {
  const level = LEVELS.includes(bot.level) ? bot.level : 'normal';
  if (level === 'easy') return chance(0.12);

  const action = pending.action;
  const againstMe = action.targetId === bot.id;
  const byMe = pending.byId === bot.id;
  if (byMe) return false;

  // Ein Angriff trifft den nächsten lebenden Spieler – bin das ich?
  let attackHitsMe = false;
  if (action.type === 'attack') {
    const total = game.players.length;
    for (let step = 1; step <= total; step++) {
      const candidate = game.players[(game.currentIndex + step) % total];
      if (candidate.alive && !candidate.spectator) { attackHitsMe = candidate.id === bot.id; break; }
    }
  }

  if (againstMe) return chance(level === 'smart' ? 0.85 : 0.6);
  if (attackHitsMe) return chance(level === 'smart' ? 0.8 : 0.55);
  if (pending.nopeLayers % 2 === 1 && level === 'smart') return chance(0.3); // eigenes Nope retten
  if (action.type === 'fromDiscard' && action.discardCardId === 'defuse') return chance(0.5);
  return chance(level === 'smart' ? 0.12 : 0.08);
}

/** Welche Karte gibt der Bot bei "Gefallen" ab? */
function decideFavorCard(game, bot) {
  if (!bot.hand.length) return null;
  const level = LEVELS.includes(bot.level) ? bot.level : 'normal';
  if (level === 'easy') return pick(bot.hand).uid;
  const sorted = [...bot.hand].sort((a, b) => VALUE_ORDER.indexOf(a.id) - VALUE_ORDER.indexOf(b.id));
  // Entschärfung nur abgeben, wenn gar nichts anderes da ist
  const keeper = sorted.find((c) => c.id !== 'defuse') || sorted[0];
  return keeper.uid;
}

/** Wohin steckt der Bot die entschärfte Bombe zurück? */
function decideDefusePosition(game, bot) {
  const level = LEVELS.includes(bot.level) ? bot.level : 'normal';
  const max = game.deck.length;
  if (level === 'easy') return Math.floor(rnd(max + 1));
  // Noch ein eigener Zug? Dann die Bombe weit weg legen, sonst dem Nächsten vorlegen.
  if (bot.turnsLeft > 1) return level === 'smart' ? max : Math.min(max, Math.floor(max / 2) + 1);
  if (level === 'smart') return 0;
  return Math.min(max, Math.floor(rnd(2)));
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  freeName,
  thinkingTime,
  bombRisk,
  decideTurn,
  decideNope,
  decideFavorCard,
  decideDefusePosition
};
