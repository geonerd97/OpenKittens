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

/** Grundmengen des Aktionsstapels (ohne Bomben und Entschärfungen). */
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

/**
 * Baut den Kartenpool für eine bestimmte Spielerzahl.
 * Ab 6 Spielern wird der Aktionsstapel verdoppelt, damit genug Karten da sind.
 */
function buildPool(playerCount) {
  const factor = playerCount > 5 ? 2 : 1;
  const pool = [];
  for (const [id, count] of Object.entries(BASE_COUNTS)) {
    for (let i = 0; i < count * factor; i++) pool.push(id);
  }
  return pool;
}

function defuseCount(playerCount) {
  return playerCount > 5 ? 10 : 6;
}

module.exports = { CARDS, CAT_IDS, buildPool, defuseCount };
