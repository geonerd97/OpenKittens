/* OpenKittens – Client */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });

  let CARDS = {};
  let view = null;
  let selection = new Set();
  let modalMode = null;     // target | demand | discardPick | defuse | favor | peek | over | rules | discardView
  let pendingPlay = null;   // { uids, kind, targetId }
  let nopeTimer = null;
  let clockTimer = null;
  let lastQrCode = null;
  let lastAnnounce = '';
  let lastTurnId = null;
  let lastFocus = null;

  const SORT_ORDER = ['defuse', 'nope', 'skip', 'attack', 'shuffle', 'future', 'favor',
    'cat_pizza', 'cat_melon', 'cat_beard', 'cat_rainbow', 'cat_potato', 'bomb'];

  const SETTING_DEFS = [
    { key: 'nopeSeconds', label: 'Nope-Fenster', hint: 'Bedenkzeit für Nope-Karten', fmt: (v) => (v === 0 ? 'sofort' : `${v} s`) },
    { key: 'turnSeconds', label: 'Zeit pro Zug', hint: 'danach wird automatisch gezogen', fmt: (v) => (v === 0 ? 'ohne Limit' : `${v} s`) },
    { key: 'startCards', label: 'Startkarten', hint: 'zusätzlich zur Entschärfung', fmt: (v) => `${v}` },
    { key: 'extraBombs', label: 'Zusatzbomben', hint: 'über Spielerzahl − 1 hinaus', fmt: (v) => (v === 0 ? 'Standard' : `+${v}`) }
  ];

  const store = {
    get name() { return localStorage.getItem('ok:name') || ''; },
    set name(v) { try { localStorage.setItem('ok:name', v); } catch {} },
    token(code) { try { return localStorage.getItem(`ok:token:${code}`); } catch { return null; } },
    setToken(code, token) { try { localStorage.setItem(`ok:token:${code}`, token); } catch {} },
    get lastCode() { return localStorage.getItem('ok:lastCode') || ''; },
    set lastCode(v) { try { localStorage.setItem('ok:lastCode', v || ''); } catch {} },
    get sound() { return localStorage.getItem('ok:sound') !== '0'; },
    set sound(v) { try { localStorage.setItem('ok:sound', v ? '1' : '0'); } catch {} }
  };

  /* ------------------------------------------------------------------- Ton */

  const Sound = {
    ctx: null,
    get on() { return store.sound; },
    ensure() {
      if (!this.on) return null;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      } catch { return null; }
    },
    tone(freq, start, dur, type = 'sine', gain = 0.09, slideTo = null) {
      const ctx = this.ctx;
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const vol = ctx.createGain();
      osc.type = type;
      const t0 = ctx.currentTime + start;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
      vol.gain.setValueAtTime(0.0001, t0);
      vol.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      vol.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(vol).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    },
    noise(start, dur, gain = 0.12) {
      const ctx = this.ctx;
      if (!ctx) return;
      const frames = Math.floor(ctx.sampleRate * dur);
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = ctx.createBufferSource();
      const vol = ctx.createGain();
      vol.gain.value = gain;
      src.buffer = buffer;
      src.connect(vol).connect(ctx.destination);
      src.start(ctx.currentTime + start);
    },
    play(name) {
      if (!this.ensure()) return;
      switch (name) {
        case 'draw': this.tone(620, 0, 0.1, 'sine'); break;
        case 'play': this.tone(420, 0, 0.08, 'triangle'); break;
        case 'turn': this.tone(520, 0, 0.12, 'sine'); this.tone(780, 0.1, 0.16, 'sine'); break;
        case 'nope': this.tone(300, 0, 0.12, 'square', 0.08); this.tone(190, 0.1, 0.2, 'square', 0.08); break;
        case 'steal': this.tone(300, 0, 0.22, 'triangle', 0.08, 900); break;
        case 'defuse': this.tone(500, 0, 0.1, 'sine'); this.tone(760, 0.09, 0.18, 'sine'); break;
        case 'attack': this.tone(220, 0, 0.18, 'sawtooth', 0.07, 420); break;
        case 'bomb': this.noise(0, 0.5, 0.16); this.tone(160, 0, 0.5, 'sawtooth', 0.11, 40); break;
        case 'win': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.11, 0.2, 'sine', 0.08)); break;
        default: break;
      }
    }
  };

  /* --------------------------------------------------------------- Werkzeug */

  function toast(message, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function announce(text) {
    if (!text || text === lastAnnounce) return;
    lastAnnounce = text;
    $('live').textContent = text;
  }

  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `screen-${name}`);
  }

  function cardInfo(id) {
    return CARDS[id] || { name: id, emoji: '🂠', text: '', color: '#555', kind: 'action' };
  }

  /** Karte als Button (auswählbar) oder als reine Anzeige. */
  function cardEl(id, { pressed = false, compact = false, onClick = null, label = null } = {}) {
    const info = cardInfo(id);
    const el = document.createElement(onClick ? 'button' : 'div');
    el.className = `card${compact ? ' compact' : ''}`;
    if (onClick) {
      el.type = 'button';
      el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      el.addEventListener('click', onClick);
    }
    el.innerHTML = '<span class="cemoji" aria-hidden="true"></span><span class="cname"></span><span class="ctext"></span><span class="cbar"></span>';
    el.querySelector('.cemoji').textContent = info.emoji;
    el.querySelector('.cname').textContent = label || info.name;
    el.querySelector('.ctext').textContent = info.text || '';
    el.querySelector('.cbar').style.background = info.color;
    return el;
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function avatarEl(player, size = 32) {
    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.width = av.style.height = `${size}px`;
    av.style.borderColor = player.color;
    av.textContent = player.bot ? '🤖' : (player.connected ? player.emoji : '💤');
    return av;
  }

  function emit(event, payload = {}) {
    socket.emit(event, payload, (res) => {
      if (res && res.ok === false) toast(res.error || 'Das hat nicht funktioniert.', true);
    });
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* Fallback unten */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  /* ---------------------------------------------------------------- Modal */

  function closeModal(refocus = true) {
    modalMode = null;
    pendingPlay = null;
    $('modal').classList.add('hidden');
    if (refocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  function openModal({ title, text, body = [], foot = [], mode }) {
    if (!modalMode) lastFocus = document.activeElement;
    modalMode = mode;
    $('modal-title').textContent = title;
    $('modal-text').textContent = text || '';
    const bodyEl = $('modal-body');
    const footEl = $('modal-foot');
    bodyEl.innerHTML = '';
    footEl.innerHTML = '';
    body.forEach((n) => bodyEl.appendChild(n));
    foot.forEach((n) => footEl.appendChild(n));
    $('modal').classList.remove('hidden');
    const first = $('modal').querySelector('button, input, [tabindex]');
    if (first) setTimeout(() => first.focus(), 30);
  }

  const MANDATORY = new Set(['defuse', 'favor']);

  $('modal').addEventListener('click', (e) => {
    if (e.target !== $('modal') || MANDATORY.has(modalMode)) return;
    closeModal();
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('log-panel').classList.contains('open')) { $('log-panel').classList.remove('open'); return; }
    if (modalMode && !MANDATORY.has(modalMode)) { closeModal(); render(); }
  });

  /* ------------------------------------------------------------ Beitreten */

  function handleEntry(res) {
    if (!res || res.ok === false) {
      $('home-error').textContent = (res && res.error) || 'Verbindung fehlgeschlagen.';
      return;
    }
    store.setToken(res.code, res.token);
    store.lastCode = res.code;
    if (res.name) store.name = res.name;
    $('home-error').textContent = '';
    location.hash = res.code;
  }

  $('btn-create').addEventListener('click', () => {
    const name = $('input-name').value.trim();
    if (!name) { $('home-error').textContent = 'Bitte gib einen Namen ein.'; return; }
    store.name = name;
    Sound.ensure();
    socket.emit('createRoom', { name }, handleEntry);
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('input-name').value.trim();
    const code = $('input-code').value.replace(/\D/g, '');
    if (!name) { $('home-error').textContent = 'Bitte gib einen Namen ein.'; return; }
    if (code.length !== 4) { $('home-error').textContent = 'Der Raumcode besteht aus vier Ziffern.'; return; }
    store.name = name;
    Sound.ensure();
    socket.emit('joinRoom', { code, name, token: store.token(code) }, handleEntry);
  });

  $('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('input-name').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    ($('input-code').value.replace(/\D/g, '').length === 4 ? $('btn-join') : $('btn-create')).click();
  });

  function leave() {
    emit('leaveRoom');
    view = null;
    selection.clear();
    closeModal(false);
    location.hash = '';
    showScreen('home');
  }
  $('btn-leave-lobby').addEventListener('click', leave);
  $('btn-leave-game').addEventListener('click', () => {
    openModal({
      mode: 'rules',
      title: 'Raum verlassen?',
      text: 'Du kannst mit demselben Gerät jederzeit wieder beitreten, solange die Runde läuft.',
      body: [],
      foot: [
        button('Abbrechen', 'ghost', () => { closeModal(); render(); }),
        button('Verlassen', 'danger', () => { closeModal(false); leave(); })
      ]
    });
  });
  $('btn-start').addEventListener('click', () => emit('startGame'));

  $('btn-sound').addEventListener('click', () => {
    store.sound = !store.sound;
    renderSoundButton();
    if (store.sound) { Sound.ensure(); Sound.play('play'); }
  });
  function renderSoundButton() {
    const on = store.sound;
    $('btn-sound').textContent = on ? '🔊' : '🔇';
    $('btn-sound').classList.toggle('off', !on);
    $('btn-sound').setAttribute('aria-label', on ? 'Ton ausschalten' : 'Ton einschalten');
  }

  $('btn-log').addEventListener('click', () => $('log-panel').classList.toggle('open'));
  $('btn-log-close').addEventListener('click', () => $('log-panel').classList.remove('open'));

  /* ------------------------------------------------------------------ Lobby */

  function joinUrl(code) {
    return `${location.origin}/#${code}`;
  }

  function renderQR(code) {
    if (lastQrCode === code) return;
    lastQrCode = code;
    const box = $('qr');
    box.innerHTML = '';
    try {
      const qr = qrcode(0, 'M');
      qr.addData(joinUrl(code));
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      box.setAttribute('aria-label', `QR-Code für ${joinUrl(code)}`);
    } catch {
      box.textContent = '';
    }
  }

  function renderSettings(v) {
    const host = Boolean(v.you && v.you.isHost);
    const wrap = $('settings');
    wrap.innerHTML = '';
    SETTING_DEFS.forEach((def) => {
      const row = document.createElement('div');
      row.className = 'setting';
      const head = document.createElement('div');
      head.className = 'setting-head';
      const b = document.createElement('b');
      b.textContent = def.label;
      const hint = document.createElement('span');
      hint.textContent = def.hint;
      head.append(b, hint);

      const opts = document.createElement('div');
      opts.className = 'setting-options';
      opts.setAttribute('role', 'group');
      opts.setAttribute('aria-label', def.label);
      (v.settingRanges[def.key] || []).forEach((value) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt';
        btn.textContent = def.fmt(value);
        btn.setAttribute('aria-pressed', v.settings[def.key] === value ? 'true' : 'false');
        btn.disabled = !host;
        btn.addEventListener('click', () => emit('updateSettings', { [def.key]: value }));
        opts.appendChild(btn);
      });
      row.append(head, opts);
      wrap.appendChild(row);
    });
    if (!host) {
      const note = document.createElement('p');
      note.className = 'hint small';
      note.textContent = 'Nur der Host kann die Hausregeln ändern.';
      wrap.appendChild(note);
    }
  }

  function renderLobby(v) {
    $('lobby-code').textContent = v.code;
    $('join-url').textContent = joinUrl(v.code);
    renderQR(v.code);
    $('lobby-count').textContent = String(v.players.length);

    const list = $('lobby-players');
    const isHostNow = Boolean(v.you && v.you.isHost);
    list.innerHTML = '';
    v.players.forEach((p) => {
      const li = document.createElement('li');
      li.style.borderColor = p.id === v.youId ? p.color : '';

      const main = document.createElement('div');
      main.className = 'player-main';
      const name = document.createElement('span');
      name.className = 'pname-text';
      name.textContent = p.name + (p.id === v.youId ? ' (du)' : '');
      main.append(avatarEl(p), name);

      const tags = [];
      if (p.isHost) tags.push('Host');
      if (p.bot) tags.push(`Bot · ${v.botLevelNames[p.level] || p.level}`);
      else if (!p.connected) tags.push('offline');
      tags.forEach((text, i) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = text;
        if (i === 0) tag.style.marginLeft = 'auto';
        main.appendChild(tag);
      });

      if (isHostNow && p.id !== v.youId) {
        const kick = button('✕', 'tiny ghost', () => emit('kickPlayer', { playerId: p.id }));
        kick.setAttribute('aria-label', `${p.name} entfernen`);
        kick.title = `${p.name} entfernen`;
        if (!tags.length) kick.style.marginLeft = 'auto';
        main.appendChild(kick);
      }
      li.appendChild(main);

      if (p.bot && isHostNow) {
        const levels = document.createElement('div');
        levels.className = 'bot-levels';
        levels.setAttribute('role', 'group');
        levels.setAttribute('aria-label', `Spielstärke von ${p.name}`);
        (v.botLevels || []).forEach((level) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'opt';
          btn.textContent = v.botLevelNames[level] || level;
          btn.setAttribute('aria-pressed', p.level === level ? 'true' : 'false');
          btn.addEventListener('click', () => emit('setBotLevel', { playerId: p.id, level }));
          levels.appendChild(btn);
        });
        li.appendChild(levels);
      }
      list.appendChild(li);
    });

    renderSettings(v);

    const isHost = Boolean(v.you && v.you.isHost);
    const participants = v.players.filter((p) => p.connected).length;
    const enough = participants >= 2;
    const full = v.players.length >= 8;
    $('bot-add').classList.toggle('hidden', !isHost);
    $('btn-add-bot').disabled = full;
    $('btn-start').disabled = !isHost || !enough;
    $('lobby-hint').textContent = !isHost
      ? 'Warte, bis der Host das Spiel startet.'
      : (enough ? '' : 'Es fehlt noch ein Mitspieler – ein Bot zählt auch.');
  }

  $('btn-add-bot').addEventListener('click', () => emit('addBot', { level: 'normal' }));

  $('btn-copy-link').addEventListener('click', async () => {
    const ok = await copyText(joinUrl(view ? view.code : ''));
    toast(ok ? 'Link kopiert.' : 'Kopieren hat nicht geklappt – Adresse bitte abtippen.', !ok);
  });
  $('btn-copy-code').addEventListener('click', async () => {
    const ok = await copyText(view ? view.code : '');
    toast(ok ? 'Code kopiert.' : 'Kopieren hat nicht geklappt.', !ok);
  });

  /* ------------------------------------------------------- Auswahl & Regeln */

  function selectedIds(v) {
    return [...selection].map((uid) => {
      const card = v.you.hand.find((c) => c.uid === uid);
      return card ? card.id : null;
    });
  }

  /** Was ergibt die aktuelle Auswahl? */
  function classify(ids) {
    if (ids.some((id) => !id)) return { kind: null };
    const cats = ids.every((id) => cardInfo(id).kind === 'cat');
    const same = ids.every((id) => id === ids[0]);
    if (ids.length === 1) {
      const info = cardInfo(ids[0]);
      if (info.kind === 'action') return { kind: 'action', needsTarget: Boolean(info.target) };
      return { kind: null, why: info.kind };
    }
    if (cats && same && ids.length === 2) return { kind: 'steal', needsTarget: true };
    if (cats && same && ids.length === 3) return { kind: 'demand', needsTarget: true };
    if (cats && ids.length === 5 && new Set(ids).size === 5) return { kind: 'fromDiscard' };
    return { kind: null };
  }

  function handHint(v) {
    if (!v.you) return '';
    if (v.you.spectator) return 'Du bist Zuschauer und in der nächsten Runde dabei.';
    if (!v.you.alive) return 'Du bist ausgeschieden – du kannst weiter zuschauen.';
    if (selection.size === 0) {
      return v.you.isCurrent
        ? 'Karten antippen zum Auswählen – oder direkt ziehen und den Zug beenden.'
        : 'Du bist nicht am Zug. Nope kannst du trotzdem jederzeit spielen.';
    }
    const ids = selectedIds(v);
    const res = classify(ids);
    switch (res.kind) {
      case 'action': return `${cardInfo(ids[0]).name}: ${cardInfo(ids[0]).text}`;
      case 'steal': return 'Zwei gleiche Katzen: du klaust eine zufällige Karte.';
      case 'demand': return 'Drei gleiche Katzen: du sagst eine Karte an und bekommst sie, wenn sie da ist.';
      case 'fromDiscard': return 'Fünf verschiedene Katzen: du nimmst dir eine Karte aus dem Ablagestapel.';
      default: break;
    }
    if (ids.length === 1 && res.why === 'cat') return 'Einzelne Katzen wirken nicht – wähle zwei, drei oder fünf.';
    if (ids.length === 1 && res.why === 'defuse') return 'Entschärfungen setzt du nicht selbst ein – das passiert beim Bombenzug automatisch.';
    if (ids.length === 1 && res.why === 'nope') return 'Nope spielst du unten, sobald jemand eine Aktion spielt.';
    return 'Diese Kombination ist nicht spielbar.';
  }

  function selectionPlayable(v) {
    if (!v.you || !v.you.isCurrent || v.pending || v.prompt || v.phase !== 'playing') return false;
    return Boolean(classify(selectedIds(v)).kind);
  }

  /* -------------------------------------------------------------- Spielbrett */

  function renderGame(v) {
    $('game-code').textContent = v.code;
    const current = v.players.find((p) => p.id === v.currentId);
    $('chip-turn').textContent = v.phase === 'finished'
      ? (v.winnerName ? `🏆 ${v.winnerName}` : 'Runde beendet')
      : (current ? `${current.bot ? '🤖' : current.emoji} ${current.name}${current.turnsLeft > 1 ? ` · ${current.turnsLeft} Züge` : ''}` : '–');
    $('chip-turn').classList.toggle('alarm', Boolean(v.you && v.you.isCurrent));

    const strip = $('players-strip');
    strip.innerHTML = '';
    v.players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'pcard'
        + (p.id === v.currentId ? ' current' : '')
        + (!p.alive || p.spectator ? ' dead' : '');
      li.style.borderLeftColor = p.color;
      const name = document.createElement('span');
      name.className = 'pname';
      name.append(avatarEl(p, 22), document.createTextNode(p.name + (p.id === v.youId ? ' (du)' : '')));
      const meta = document.createElement('span');
      meta.className = 'pmeta';
      const parts = [`🎴 ${p.handCount}`];
      if (p.bot) parts.push(`Bot · ${(view && view.botLevelNames && view.botLevelNames[p.level]) || p.level}`);
      if (p.isHost) parts.push('Host');
      if (p.spectator) parts.push('Zuschauer');
      else if (p.removed) parts.push('entfernt');
      else if (!p.alive) parts.push('💥 raus');
      if (!p.connected) parts.push('💤 offline');
      if (p.turnsLeft > 1) parts.push(`${p.turnsLeft} Züge`);
      meta.textContent = parts.join(' · ');
      li.append(name, meta);
      if (v.you && v.you.isHost && p.id !== v.youId && !p.connected && p.alive && !p.spectator) {
        const kick = button('✕', 'tiny ghost', () => emit('kickPlayer', { playerId: p.id }));
        kick.setAttribute('aria-label', `${p.name} aus der Runde nehmen`);
        kick.style.cssText = 'position:absolute;top:4px;right:4px;min-height:26px;padding:.1rem .35rem;';
        li.appendChild(kick);
      }
      strip.appendChild(li);
    });

    $('deck-count').textContent = `${v.deckCount} Karten`;
    $('discard-count').textContent = `${v.discardCount} Karten`;
    const top = v.discardTop ? cardInfo(v.discardTop) : null;
    $('discard-emoji').textContent = top ? top.emoji : '·';
    $('discard-label').textContent = 'Ablage';
    $('discard-pile').setAttribute('aria-label', top
      ? `Ablagestapel ansehen, oben liegt ${top.name}`
      : 'Ablagestapel ist leer');
    $('discard-pile').title = top ? `Oben: ${top.name}` : 'Ablagestapel';

    const yourTurn = Boolean(v.you && v.you.isCurrent);
    const banner = $('turn-banner');
    banner.classList.toggle('you', yourTurn);
    if (v.phase === 'finished') {
      banner.textContent = v.winnerName ? `🏆 ${v.winnerName} hat gewonnen!` : 'Runde beendet.';
    } else if (v.prompt) {
      banner.textContent = 'Du musst eine Entscheidung treffen.';
    } else if (v.promptInfo) {
      banner.textContent = `Warten auf ${v.promptInfo.playerName} …`;
    } else if (v.pending) {
      banner.textContent = 'Aktion läuft – Nope-Fenster offen.';
    } else if (yourTurn) {
      banner.textContent = v.you.turnsLeft > 1 ? `Du bist am Zug – noch ${v.you.turnsLeft} Züge.` : 'Du bist am Zug.';
    } else if (v.you && v.you.spectator) {
      banner.textContent = 'Du bist in der nächsten Runde dabei.';
    } else if (v.you && !v.you.alive) {
      banner.textContent = 'Du bist ausgeschieden.';
    } else {
      banner.textContent = current ? `${current.name} ist am Zug …` : '';
    }

    const canAct = yourTurn && !v.pending && !v.prompt && v.phase === 'playing';
    $('btn-draw').disabled = !canAct;
    $('deck-pile').disabled = !canAct;

    renderHand(v);
    renderClock(v);

    const log = $('log');
    log.innerHTML = '';
    v.log.forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = entry.text;
      log.appendChild(li);
    });
    log.scrollTop = log.scrollHeight;

    if (v.phase === 'playing' && v.currentId !== lastTurnId) {
      lastTurnId = v.currentId;
      if (yourTurn) { Sound.play('turn'); announce('Du bist am Zug.'); }
      else if (current) announce(`${current.name} ist am Zug.`);
    }
  }

  function renderHand(v) {
    const hand = $('hand');
    // Fokus über den Neuaufbau hinweg erhalten (Tastaturbedienung)
    const active = document.activeElement;
    const focusUid = active && active.dataset && hand.contains(active) ? active.dataset.uid : null;
    const scrollLeft = hand.scrollLeft;
    hand.innerHTML = '';
    const cards = v.you ? [...v.you.hand] : [];
    cards.sort((a, b) => {
      const d = SORT_ORDER.indexOf(a.id) - SORT_ORDER.indexOf(b.id);
      return d !== 0 ? d : a.uid.localeCompare(b.uid);
    });
    const valid = new Set(cards.map((c) => c.uid));
    for (const uid of [...selection]) if (!valid.has(uid)) selection.delete(uid);

    cards.forEach((c) => {
      const kind = cardInfo(c.id).kind;
      const el = cardEl(c.id, {
        pressed: selection.has(c.uid),
        onClick: () => {
          if (selection.has(c.uid)) selection.delete(c.uid);
          else selection.add(c.uid);
          Sound.play('play');
          render();
        }
      });
      if (kind !== 'action' && kind !== 'cat') el.classList.add('passive');
      el.dataset.uid = c.uid;
      hand.appendChild(el);
    });
    if (focusUid) {
      const again = hand.querySelector(`[data-uid="${CSS.escape(focusUid)}"]`);
      if (again) { again.focus({ preventScroll: true }); hand.scrollLeft = scrollLeft; }
    }
    if (!cards.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = v.you && v.you.alive ? 'Keine Karten auf der Hand.' : 'Du schaust gerade zu.';
      hand.appendChild(empty);
    }

    $('hand-title').textContent = handHint(v);
    const playable = selectionPlayable(v);
    $('btn-play').disabled = !playable;
    $('btn-play').textContent = selection.size ? `Spielen (${selection.size})` : 'Spielen';
  }

  function renderClock(v) {
    clearInterval(clockTimer);
    clockTimer = null;
    const wrap = $('turn-clock');
    const total = (v.settings.turnSeconds || 0) * 1000;
    if (!v.turnDeadline || !total || v.phase !== 'playing') { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const tick = () => {
      const left = Math.max(0, v.turnDeadline - Date.now());
      const pct = Math.min(100, (left / total) * 100);
      const fill = $('turn-clock-fill');
      fill.style.width = `${pct}%`;
      fill.style.background = pct < 25 ? 'var(--danger)' : 'var(--accent)';
      if (left <= 0) { clearInterval(clockTimer); clockTimer = null; }
    };
    tick();
    clockTimer = setInterval(tick, 200);
  }

  /* ------------------------------------------------------------- Ausspielen */

  $('btn-draw').addEventListener('click', () => { Sound.play('draw'); emit('drawCard'); });
  $('deck-pile').addEventListener('click', () => { Sound.play('draw'); emit('drawCard'); });
  $('discard-pile').addEventListener('click', () => openDiscardView());

  $('btn-play').addEventListener('click', () => {
    if (!view || !selectionPlayable(view)) return;
    const uids = [...selection];
    const ids = selectedIds(view);
    const res = classify(ids);
    pendingPlay = { uids, kind: res.kind, label: ids.length > 1 ? `${cardInfo(ids[0]).name}-Kombination` : cardInfo(ids[0]).name };
    if (res.needsTarget) return openTargetModal();
    if (res.kind === 'fromDiscard') return openDiscardPicker();
    sendPlay({});
  });

  function sendPlay(extra) {
    const uids = pendingPlay ? pendingPlay.uids : [];
    closeModal(false);
    selection.clear();
    emit('playCards', { uids, ...extra });
  }

  function openTargetModal() {
    const choices = view.players
      .filter((p) => p.alive && !p.spectator && p.id !== view.youId)
      .map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn choice';
        b.append(avatarEl(p), document.createTextNode(`${p.name} · ${p.handCount} Karten${p.connected ? '' : ' (offline)'}`));
        b.addEventListener('click', () => {
          if (pendingPlay.kind === 'demand') openDemandModal(p.id);
          else sendPlay({ targetId: p.id });
        });
        return b;
      });
    openModal({
      mode: 'target',
      title: `${pendingPlay.label} – gegen wen?`,
      text: 'Wähle einen Mitspieler.',
      body: choices,
      foot: [button('Abbrechen', 'ghost', () => { closeModal(); render(); })]
    });
  }

  function openDemandModal(targetId) {
    const row = document.createElement('div');
    row.className = 'card-row';
    Object.keys(CARDS)
      .filter((id) => id !== 'bomb')
      .sort((a, b) => SORT_ORDER.indexOf(a) - SORT_ORDER.indexOf(b))
      .forEach((id) => {
        row.appendChild(cardEl(id, { compact: true, onClick: () => sendPlay({ targetId, demandCardId: id }) }));
      });
    openModal({
      mode: 'demand',
      title: 'Welche Karte forderst du?',
      text: 'Hat der Mitspieler diese Karte, musst er sie herausgeben – sonst passiert nichts.',
      body: [row],
      foot: [button('Abbrechen', 'ghost', () => { closeModal(); render(); })]
    });
  }

  function openDiscardPicker() {
    const counts = {};
    (view.discardPile || []).forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    const ids = Object.keys(counts).sort((a, b) => SORT_ORDER.indexOf(a) - SORT_ORDER.indexOf(b));
    const row = document.createElement('div');
    row.className = 'card-row';
    ids.forEach((id) => {
      row.appendChild(cardEl(id, {
        compact: true,
        label: counts[id] > 1 ? `${cardInfo(id).name} ×${counts[id]}` : cardInfo(id).name,
        onClick: () => sendPlay({ discardCardId: id })
      }));
    });
    if (!ids.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Der Ablagestapel ist leer.';
      row.appendChild(p);
    }
    openModal({
      mode: 'discardPick',
      title: 'Welche Karte holst du dir?',
      text: 'Fünf verschiedene Katzen: such dir eine Karte aus dem Ablagestapel aus.',
      body: [row],
      foot: [button('Abbrechen', 'ghost', () => { closeModal(); render(); })]
    });
  }

  function openDiscardView() {
    const counts = {};
    (view.discardPile || []).forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    const ids = Object.keys(counts).sort((a, b) => SORT_ORDER.indexOf(a) - SORT_ORDER.indexOf(b));
    const row = document.createElement('div');
    row.className = 'card-row';
    ids.forEach((id) => row.appendChild(cardEl(id, { compact: true, label: `${cardInfo(id).name} ×${counts[id]}` })));
    if (!ids.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Noch nichts abgelegt.';
      row.appendChild(p);
    }
    openModal({
      mode: 'discardView',
      title: 'Ablagestapel',
      text: `${view.discardCount} Karten liegen offen aus.`,
      body: [row],
      foot: [button('Schließen', 'primary', () => { closeModal(); render(); })]
    });
  }

  /* ------------------------------------------------------------ Nope-Fenster */

  function renderNope(v) {
    const bar = $('nope-bar');
    if (!v.pending || v.phase !== 'playing') {
      bar.classList.add('hidden');
      clearInterval(nopeTimer);
      nopeTimer = null;
      return;
    }
    const p = v.pending;
    const target = p.targetName ? ` gegen ${p.targetName}` : '';
    const detail = p.detail ? ` (${p.detail})` : '';
    const nopes = p.nopeLayers ? ` · ${p.nopeLayers}× Nope` : '';
    const status = p.cancelled ? ' – aktuell aufgehoben' : '';
    const waiting = p.waitingFor.length ? ` · wartet auf ${p.waitingFor.join(', ')}` : '';
    $('nope-text').textContent = `${p.byName}: ${p.label}${detail}${target}${nopes}${status}${waiting}`;
    $('btn-nope').disabled = !p.youCanNope;
    $('btn-pass').disabled = !p.youCanNope;
    bar.classList.remove('hidden');

    clearInterval(nopeTimer);
    const total = p.windowMs || 6000;
    const tick = () => {
      const left = Math.max(0, p.deadline - Date.now());
      $('nope-progress-fill').style.width = `${Math.min(100, (left / total) * 100)}%`;
      if (left <= 0) { clearInterval(nopeTimer); nopeTimer = null; }
    };
    tick();
    nopeTimer = setInterval(tick, 80);
  }

  $('btn-nope').addEventListener('click', () => emit('nope'));
  $('btn-pass').addEventListener('click', () => emit('passNope'));

  /* --------------------------------------------------------- Entscheidungen */

  function renderPrompt(v) {
    if (v.prompt && v.prompt.type === 'defuse' && modalMode !== 'defuse') return openDefuseModal(v);
    if (v.prompt && v.prompt.type === 'favor' && modalMode !== 'favor') return openFavorModal(v);
    if (!v.prompt && MANDATORY.has(modalMode)) closeModal();

    if (v.peek && !v.prompt && modalMode !== 'peek') return openPeekModal(v);
    if (!v.peek && modalMode === 'peek') closeModal();

    if (v.phase === 'finished' && !modalMode) return openOverModal(v);
    if (v.phase !== 'finished' && modalMode === 'over') closeModal();
  }

  function openDefuseModal(v) {
    const max = v.prompt.deckSize;
    const wrap = document.createElement('div');
    wrap.className = 'slider-row';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = String(max);
    range.value = String(Math.min(2, max));
    range.setAttribute('aria-label', 'Position der Bombe im Stapel');
    const value = document.createElement('span');
    value.className = 'pos-value';
    const label = () => {
      const pos = Number(range.value);
      value.textContent = pos === 0 ? 'ganz oben' : (pos >= max ? 'ganz unten' : `Platz ${pos + 1}`);
    };
    range.addEventListener('input', label);
    label();
    wrap.append(range, value);

    const quick = document.createElement('div');
    quick.className = 'quick-row';
    [['Ganz oben', 0], ['3. von oben', Math.min(2, max)], ['Mitte', Math.floor(max / 2)], ['Ganz unten', max]]
      .forEach(([text, pos]) => quick.appendChild(button(text, 'tiny ghost', () => { range.value = String(pos); label(); })));

    openModal({
      mode: 'defuse',
      title: '🧯 Bombe entschärft!',
      text: `Stecke das Explodierende Kätzchen zurück in den Stapel (${max} Karten). Niemand sieht, wo.`,
      body: [wrap, quick],
      foot: [button('Zurückstecken', 'primary', () => {
        emit('respondPrompt', { position: Number(range.value) });
        closeModal();
      })]
    });
  }

  function openFavorModal(v) {
    const row = document.createElement('div');
    row.className = 'card-row';
    [...v.you.hand]
      .sort((a, b) => SORT_ORDER.indexOf(a.id) - SORT_ORDER.indexOf(b.id))
      .forEach((c) => row.appendChild(cardEl(c.id, {
        compact: true,
        onClick: () => { emit('respondPrompt', { uid: c.uid }); closeModal(); }
      })));
    openModal({
      mode: 'favor',
      title: '🙏 Gefallen',
      text: `${v.prompt.requesterName} möchte eine Karte von dir. Du entscheidest, welche.`,
      body: [row],
      foot: []
    });
  }

  function openPeekModal(v) {
    const row = document.createElement('div');
    row.className = 'card-row';
    v.peek.forEach((id, i) => {
      const el = cardEl(id, { compact: true });
      el.classList.add('peek-card');
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = `#${i + 1}`;
      el.appendChild(idx);
      row.appendChild(el);
    });
    if (!v.peek.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Der Stapel ist leer.';
      row.appendChild(p);
    }
    openModal({
      mode: 'peek',
      title: '🔮 Blick in die Zukunft',
      text: 'Die obersten Karten des Nachziehstapels – nur du siehst sie.',
      body: [row],
      foot: [button('Alles klar', 'primary', () => { emit('clearPeek'); closeModal(); })]
    });
  }

  function openOverModal(v) {
    const foot = [];
    if (v.you && v.you.isHost) foot.push(button('Neue Runde', 'primary', () => { emit('backToLobby'); closeModal(); }));
    foot.push(button('Schließen', 'ghost', () => { closeModal(); render(); }));
    openModal({
      mode: 'over',
      title: v.winnerId === v.youId ? '🏆 Du hast gewonnen!' : '💥 Runde beendet',
      text: v.winnerName ? `${v.winnerName} ist als Letzte(r) übrig geblieben.` : 'Niemand hat überlebt.',
      body: [],
      foot
    });
  }

  $('btn-rules').addEventListener('click', () => {
    const box = document.createElement('div');
    box.innerHTML = document.getElementById('rules-list').outerHTML;
    box.className = 'rules';
    openModal({ mode: 'rules', title: 'Spielregeln', text: '', body: [box], foot: [button('Schließen', 'primary', () => { closeModal(); render(); })] });
  });

  /* ------------------------------------------------------------------ Effekte */

  const FX = {
    bomb: { emoji: '💥', text: (d) => `${d.name} ist explodiert!`, sound: 'bomb', shake: true },
    defuse: { emoji: '🧯', text: (d) => `${d.name} entschärft die Bombe`, sound: 'defuse' },
    nope: { emoji: '🚫', text: (d) => `${d.name}: Nope!${d.layers > 1 ? ` (${d.layers}×)` : ''}`, sound: 'nope' },
    steal: { emoji: '😼', text: (d) => `${d.name} klaut bei ${d.victim}`, sound: 'steal' },
    attack: { emoji: '⚔️', text: (d) => `${d.name} muss doppelt ran`, sound: 'attack' },
    win: { emoji: '🏆', text: (d) => `${d.name} gewinnt!`, sound: 'win' }
  };

  const fxQueue = [];
  let fxBusy = false;

  /** Effekte nacheinander zeigen, damit z. B. Explosion und Sieg nicht kollidieren. */
  function showFx(data) {
    if (!FX[data.type]) return;
    if (fxQueue.length > 4) fxQueue.shift();
    fxQueue.push(data);
    if (!fxBusy) playNextFx();
  }

  function playNextFx() {
    const data = fxQueue.shift();
    if (!data) { fxBusy = false; return; }
    fxBusy = true;
    const def = FX[data.type];
    const pop = document.createElement('div');
    pop.className = 'fx-pop';
    const emoji = document.createElement('span');
    emoji.className = 'fx-emoji';
    emoji.textContent = def.emoji;
    const text = document.createElement('span');
    text.className = 'fx-text';
    text.textContent = def.text(data);
    pop.append(emoji, text);
    $('fx-layer').innerHTML = '';
    $('fx-layer').appendChild(pop);
    setTimeout(() => { pop.remove(); playNextFx(); }, 1150);
    announce(def.text(data));
    Sound.play(def.sound);
    if (def.shake) {
      document.body.classList.add('shake');
      setTimeout(() => document.body.classList.remove('shake'), 500);
    }
  }

  /* ------------------------------------------------------------------ Render */

  function render() {
    if (!view) { showScreen('home'); return; }
    if (view.phase === 'lobby') {
      showScreen('lobby');
      renderLobby(view);
      $('nope-bar').classList.add('hidden');
      lastTurnId = null;
      if (modalMode && modalMode !== 'rules') closeModal();
      return;
    }
    showScreen('game');
    renderGame(view);
    renderNope(view);
    renderPrompt(view);
  }

  /* ------------------------------------------------------------ Socket-Events */

  socket.on('state', (v) => { view = v; render(); });
  socket.on('toast', (msg) => toast(msg));
  socket.on('fx', (data) => showFx(data));

  socket.on('kicked', (reason) => {
    toast(reason || 'Du hast dieses Spiel in einem anderen Tab geöffnet.', true);
    view = null;
    closeModal(false);
    showScreen('home');
  });

  socket.on('connect', () => {
    const code = (location.hash || '').replace(/[^0-9]/g, '') || (view && view.code) || store.lastCode;
    const token = code ? store.token(code) : null;
    if (code && token) {
      socket.emit('joinRoom', { code, token, name: store.name }, (res) => {
        if (!res || res.ok === false) {
          location.hash = '';
          showScreen('home');
          if (res && res.error) toast(res.error, true);
        } else handleEntry(res);
      });
    } else {
      showScreen('home');
    }
  });

  socket.on('disconnect', () => toast('Verbindung verloren – es wird erneut verbunden …', true));

  /* ---------------------------------------------------------------- Startwerte */

  fetch('/api/cards').then((r) => r.json()).then((data) => { CARDS = data; render(); }).catch(() => {});
  $('input-name').value = store.name;
  renderSoundButton();
  const hashCode = (location.hash || '').replace(/[^0-9]/g, '');
  if (hashCode.length === 4) $('input-code').value = hashCode;
})();
