'use strict';

/**
 * Kartendefinitionen für OpenKittens.
 * kind: 'bomb' | 'defuse' | 'action' | 'nope' | 'cat'
 * target: true -> beim Ausspielen muss ein Mitspieler gewählt werden
 */
const CARDS = {
  bomb:    { name: 'Explodierendes Kätzchen', emoji: '💥', kind: 'bomb',   color: '#ff5f56',
             text: 'Wer sie zieht und nicht entschärfen kann, fliegt raus.' },
  defuse:  { name: 'Entschärfung',            emoji: '🧯', kind: 'defuse', color: '#4ade80',
             text: 'Rettet dich vor einer Bombe. Du steckst sie heimlich zurück in den Stapel.' },
  skip:    { name: 'Überspringen',            emoji: '🏃', kind: 'action', color: '#60a5fa',
             text: 'Beendet deinen Zug, ohne eine Karte zu ziehen.' },
  attack:  { name: 'Angriff',                 emoji: '⚔️', kind: 'action', color: '#fb923c',
             text: 'Dein Zug endet sofort. Der nächste Spieler muss zwei Züge machen.' },
  shuffle: { name: 'Mischen',                 emoji: '🔀', kind: 'action', color: '#a78bfa',
             text: 'Mischt den Nachziehstapel neu durch.' },
  future:  { name: 'Blick in die Zukunft',    emoji: '🔮', kind: 'action', color: '#38bdf8',
             text: 'Du siehst heimlich die obersten drei Karten des Stapels.' },
  favor:   { name: 'Gefallen',                emoji: '🙏', kind: 'action', color: '#fbbf24', target: true,
             text: 'Ein Mitspieler muss dir eine Karte seiner Wahl geben.' },
  nope:    { name: 'Nope',                    emoji: '🚫', kind: 'nope',   color: '#f472b6',
             text: 'Hebt die zuletzt gespielte Aktion auf – jederzeit spielbar, auch außerhalb deines Zuges.' },

  cat_pizza:   { name: 'Pizzakatze',      emoji: '🍕', kind: 'cat', color: '#fca5a5', text: 'Sammelkarte. Zwei gleiche Katzen = Karte klauen.' },
  cat_melon:   { name: 'Melonenkatze',    emoji: '🍉', kind: 'cat', color: '#86efac', text: 'Sammelkarte. Zwei gleiche Katzen = Karte klauen.' },
  cat_beard:   { name: 'Bartkatze',       emoji: '🧔', kind: 'cat', color: '#fdba74', text: 'Sammelkarte. Zwei gleiche Katzen = Karte klauen.' },
  cat_rainbow: { name: 'Regenbogenkatze', emoji: '🌈', kind: 'cat', color: '#c4b5fd', text: 'Sammelkarte. Zwei gleiche Katzen = Karte klauen.' },
  cat_potato:  { name: 'Kartoffelkatze',  emoji: '🥔', kind: 'cat', color: '#fde68a', text: 'Sammelkarte. Zwei gleiche Katzen = Karte klauen.' }
};

const CAT_IDS = Object.keys(CARDS).filter((id) => CARDS[id].kind === 'cat');

/** Mischungsverhältnis des Aktionsstapels (ohne Bomben und Entschärfungen). */
const BASE_COUNTS = {
  skip: 4,
  attack: 4,
  shuffle: 4,
  future: 5,
  nope: 5,
  favor: 4,
  cat_pizza: 4,
  cat_melon: 4,
  cat_beard: 4,
  cat_rainbow: 4,
  cat_potato: 4
};

/** Untergrenzen, damit auch ein kleiner Stapel spielbar bleibt. */
const MIN_COUNTS = {
  skip: 2,
  attack: 2,
  shuffle: 1,
  future: 2,
  nope: 2,
  favor: 1,
  cat_pizza: 2,
  cat_melon: 2,
  cat_beard: 2,
  cat_rainbow: 2,
  cat_potato: 2
};

const BASE_TOTAL = Object.values(BASE_COUNTS).reduce((a, b) => a + b, 0);
const MIN_TOTAL = Object.values(MIN_COUNTS).reduce((a, b) => a + b, 0);

/**
 * Baut einen Aktionsstapel mit genau `total` Karten im üblichen Mischungs-
 * verhältnis. Kleine Stapel behalten die Untergrenzen aus MIN_COUNTS, damit
 * Nope, Überspringen und Katzenpaare nicht verschwinden.
 */
function buildPool(total) {
  const size = Math.max(MIN_TOTAL, Math.round(total));
  const factor = size / BASE_TOTAL;
  const counts = {};
  for (const [id, base] of Object.entries(BASE_COUNTS)) {
    counts[id] = Math.max(MIN_COUNTS[id], Math.round(base * factor));
  }

  const ids = Object.keys(counts);
  const weight = (id) => BASE_COUNTS[id];
  let sum = ids.reduce((acc, id) => acc + counts[id], 0);

  // Auf die Zielgröße bringen: zuerst dort kürzen bzw. aufstocken,
  // wo der größte Abstand zum Sollverhältnis besteht.
  while (sum > size) {
    const candidates = ids.filter((id) => counts[id] > MIN_COUNTS[id]);
    if (!candidates.length) break;
    const id = candidates.reduce((best, cur) =>
      (counts[cur] / weight(cur) > counts[best] / weight(best) ? cur : best), candidates[0]);
    counts[id] -= 1;
    sum -= 1;
  }
  while (sum < size) {
    const id = ids.reduce((best, cur) =>
      (counts[cur] / weight(cur) < counts[best] / weight(best) ? cur : best), ids[0]);
    counts[id] += 1;
    sum += 1;
  }

  const pool = [];
  for (const [id, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) pool.push(id);
  }
  return pool;
}

/**
 * Entschärfungen insgesamt: eine je Spieler plus ein paar im Stapel,
 * abhängig davon, wie viele Karten überhaupt im Spiel sind.
 */
function defuseCount(playerCount, deckRest) {
  const extra = Math.max(1, Math.round((deckRest || 0) / 12));
  return playerCount + extra;
}

module.exports = { CARDS, CAT_IDS, BASE_COUNTS, MIN_COUNTS, MIN_TOTAL, buildPool, defuseCount };
