/* OpenKittens – Client */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });

  let CARDS = {};
  let view = null;
  let selection = new Set();
  let modalMode = null;      // 'target' | 'defuse' | 'favor' | 'peek' | 'over' | 'rules'
  let pendingPlay = null;    // { uids }
  let nopeTimer = null;
  let myToken = null;
  let myCode = null;

  const SORT_ORDER = ['defuse', 'nope', 'skip', 'attack', 'shuffle', 'future', 'favor',
    'cat_pizza', 'cat_melon', 'cat_beard', 'cat_rainbow', 'cat_potato', 'bomb'];

  const store = {
    get name() { return localStorage.getItem('ok:name') || ''; },
    set name(v) { localStorage.setItem('ok:name', v); },
    token(code) { return localStorage.getItem(`ok:token:${code}`); },
    setToken(code, token) { localStorage.setItem(`ok:token:${code}`, token); },
    get lastCode() { return localStorage.getItem('ok:lastCode') || ''; },
    set lastCode(v) { localStorage.setItem('ok:lastCode', v || ''); }
  };

  /* --------------------------------------------------------------- Hilfsmittel */

  function toast(message, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `screen-${name}`);
  }

  function cardInfo(id) {
    return CARDS[id] || { name: id, emoji: '🂠', text: '', color: '#555', kind: 'action' };
  }

  function cardEl(id, extraClass = '') {
    const info = cardInfo(id);
    const el = document.createElement('div');
    el.className = `card ${extraClass}`.trim();
    el.innerHTML = `<span class="cemoji"></span><span class="cname"></span><span class="ctext"></span><span class="cbar"></span>`;
    el.querySelector('.cemoji').textContent = info.emoji;
    el.querySelector('.cname').textContent = info.name;
    el.querySelector('.ctext').textContent = info.text || '';
    el.querySelector('.cbar').style.background = info.color;
    return el;
  }

  function closeModal() {
    modalMode = null;
    pendingPlay = null;
    $('modal').classList.add('hidden');
  }

  function openModal({ title, text, body = [], foot = [], mode }) {
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
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function emit(event, payload = {}) {
    socket.emit(event, payload, (res) => {
      if (res && res.ok === false) toast(res.error || 'Das hat nicht funktioniert.', true);
    });
  }

  /* ------------------------------------------------------------ Beitreten */

  function handleEntry(res) {
    if (!res || res.ok === false) {
      $('home-error').textContent = (res && res.error) || 'Verbindung fehlgeschlagen.';
      return;
    }
    myToken = res.token;
    myCode = res.code;
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
    socket.emit('createRoom', { name }, handleEntry);
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('input-name').value.trim();
    const code = $('input-code').value.replace(/\D/g, '');
    if (!name) { $('home-error').textContent = 'Bitte gib einen Namen ein.'; return; }
    if (code.length !== 4) { $('home-error').textContent = 'Der Raumcode besteht aus vier Ziffern.'; return; }
    store.name = name;
    socket.emit('joinRoom', { code, name, token: store.token(code) }, handleEntry);
  });

  $('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });

  function leave() {
    emit('leaveRoom');
    view = null;
    myCode = null;
    selection.clear();
    closeModal();
    location.hash = '';
    showScreen('home');
  }
  $('btn-leave-lobby').addEventListener('click', leave);
  $('btn-leave-game').addEventListener('click', () => {
    if (confirm('Raum wirklich verlassen?')) leave();
  });

  $('btn-start').addEventListener('click', () => emit('startGame'));

  /* ------------------------------------------------------------------ Lobby */

  function renderLobby(v) {
    $('lobby-code').textContent = v.code;
    $('lobby-count').textContent = String(v.players.length);
    const list = $('lobby-players');
    list.innerHTML = '';
    v.players.forEach((p) => {
      const li = document.createElement('li');
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = p.connected ? '🐱' : '💤';
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === v.youId ? ' (du)' : '');
      li.append(av, name);
      if (p.isHost) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'Host';
        li.appendChild(tag);
      }
      list.appendChild(li);
    });

    const isHost = v.you && v.you.isHost;
    const enough = v.players.filter((p) => p.connected).length >= 2;
    $('btn-start').disabled = !isHost || !enough;
    $('lobby-hint').textContent = !isHost
      ? 'Warte, bis der Host das Spiel startet.'
      : (enough ? '' : 'Es fehlt noch mindestens ein Mitspieler.');
  }

  /* ------------------------------------------------------------------ Spiel */

  function playableHint(v) {
    if (!v.you) return '';
    if (!v.you.alive) return 'Du bist ausgeschieden – du kannst zuschauen.';
    if (v.you.spectator) return 'Du bist in der nächsten Runde dabei.';
    if (selection.size === 0) return 'Karten antippen zum Auswählen. Zwei gleiche Katzen klauen eine Karte.';
    const ids = [...selection].map((uid) => (v.you.hand.find((c) => c.uid === uid) || {}).id);
    if (ids.length === 1) {
      const info = cardInfo(ids[0]);
      if (info.kind === 'cat') return 'Katzen funktionieren nur als Paar – wähle eine zweite gleiche Katze.';
      if (info.kind === 'defuse') return 'Entschärfungen werden automatisch eingesetzt, wenn du eine Bombe ziehst.';
      if (info.kind === 'nope') return 'Nope spielst du über den Balken unten, wenn jemand eine Aktion spielt.';
      return `${info.name}: ${info.text}`;
    }
    if (ids.length === 2 && ids[0] === ids[1] && cardInfo(ids[0]).kind === 'cat') {
      return 'Zwei gleiche Katzen – du klaust einem Mitspieler eine zufällige Karte.';
    }
    return 'Diese Kombination lässt sich nicht spielen.';
  }

  function selectionValid(v) {
    if (!v.you || !v.you.isCurrent || v.pending || v.prompt) return false;
    const ids = [...selection].map((uid) => (v.you.hand.find((c) => c.uid === uid) || {}).id);
    if (ids.some((id) => !id)) return false;
    if (ids.length === 1) {
      const kind = cardInfo(ids[0]).kind;
      return kind === 'action';
    }
    return ids.length === 2 && ids[0] === ids[1] && cardInfo(ids[0]).kind === 'cat';
  }

  function renderGame(v) {
    $('game-code').textContent = v.code;
    const current = v.players.find((p) => p.id === v.currentId);
    $('chip-turn').textContent = v.phase === 'finished'
      ? 'Runde beendet'
      : (current ? `Am Zug: ${current.name}${current.turnsLeft > 1 ? ` (${current.turnsLeft} Züge)` : ''}` : '–');

    const strip = $('players-strip');
    strip.innerHTML = '';
    v.players.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'pcard'
        + (p.id === v.currentId ? ' current' : '')
        + (!p.alive || p.spectator ? ' dead' : '')
        + (p.id === v.youId ? ' you' : '');
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      const meta = document.createElement('span');
      meta.className = 'pmeta';
      const dot = `<span class="dot${p.connected ? '' : ' off'}"></span>`;
      const parts = [`${dot}${p.handCount} Karten`];
      if (p.isHost) parts.push('Host');
      if (p.spectator) parts.push('Zuschauer');
      else if (!p.alive) parts.push('💥 raus');
      if (p.turnsLeft > 1) parts.push(`${p.turnsLeft} Züge`);
      meta.innerHTML = parts.join(' · ');
      el.append(name, meta);
      strip.appendChild(el);
    });

    $('deck-count').textContent = `${v.deckCount} Karten`;
    $('discard-count').textContent = `${v.discardCount} Karten`;
    const top = v.discardTop ? cardInfo(v.discardTop) : null;
    $('discard-emoji').textContent = top ? top.emoji : '·';
    $('discard-label').textContent = top ? top.name : 'Ablage';

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
      banner.textContent = v.you.turnsLeft > 1
        ? `Du bist am Zug – noch ${v.you.turnsLeft} Züge.`
        : 'Du bist am Zug.';
    } else if (v.you && !v.you.alive) {
      banner.textContent = v.you.spectator ? 'Du bist in der nächsten Runde dabei.' : 'Du bist ausgeschieden.';
    } else {
      banner.textContent = current ? `${current.name} ist am Zug …` : '';
    }

    const canDraw = yourTurn && !v.pending && !v.prompt && v.phase === 'playing';
    $('btn-draw').disabled = !canDraw;
    $('deck-pile').disabled = !canDraw;

    const hand = $('hand');
    hand.innerHTML = '';
    const cards = v.you ? [...v.you.hand] : [];
    cards.sort((a, b) => {
      const d = SORT_ORDER.indexOf(a.id) - SORT_ORDER.indexOf(b.id);
      return d !== 0 ? d : a.uid.localeCompare(b.uid);
    });
    const validUids = new Set(cards.map((c) => c.uid));
    for (const uid of [...selection]) if (!validUids.has(uid)) selection.delete(uid);

    cards.forEach((c) => {
      const el = cardEl(c.id, selection.has(c.uid) ? 'selected' : '');
      const kind = cardInfo(c.id).kind;
      if (kind !== 'action' && kind !== 'cat') el.classList.add('not-playable');
      el.addEventListener('click', () => {
        if (selection.has(c.uid)) selection.delete(c.uid);
        else selection.add(c.uid);
        render();
      });
      hand.appendChild(el);
    });
    if (!cards.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = v.you && v.you.alive ? 'Keine Karten auf der Hand.' : 'Du schaust gerade zu.';
      hand.appendChild(empty);
    }

    $('hand-title').textContent = playableHint(v);
    $('btn-play').disabled = !selectionValid(v);
    $('btn-clear').disabled = selection.size === 0;

    const log = $('log');
    log.innerHTML = '';
    v.log.forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = entry.text;
      log.appendChild(li);
    });
    log.scrollTop = log.scrollHeight;
  }

  $('btn-clear').addEventListener('click', () => { selection.clear(); render(); });
  $('btn-draw').addEventListener('click', () => emit('drawCard'));
  $('deck-pile').addEventListener('click', () => emit('drawCard'));

  $('btn-play').addEventListener('click', () => {
    if (!view || !selectionValid(view)) return;
    const uids = [...selection];
    const ids = uids.map((uid) => view.you.hand.find((c) => c.uid === uid).id);
    const needsTarget = ids.length === 2 || cardInfo(ids[0]).target;
    if (needsTarget) {
      pendingPlay = { uids };
      openTargetModal(ids.length === 2 ? `${cardInfo(ids[0]).name}-Paar` : cardInfo(ids[0]).name);
      return;
    }
    selection.clear();
    emit('playCards', { uids });
  });

  function openTargetModal(label) {
    const choices = view.players
      .filter((p) => p.alive && !p.spectator && p.id !== view.youId)
      .map((p) => button(`${p.name} · ${p.handCount} Karten${p.connected ? '' : ' (offline)'}`, 'choice', () => {
        const uids = pendingPlay ? pendingPlay.uids : [];
        closeModal();
        selection.clear();
        emit('playCards', { uids, targetId: p.id });
      }));
    openModal({
      mode: 'target',
      title: `${label} – wen triffst du?`,
      text: 'Wähle einen Mitspieler.',
      body: choices,
      foot: [button('Abbrechen', 'ghost', () => { closeModal(); render(); })]
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
    const nopes = p.nopeLayers ? ` · ${p.nopeLayers}× Nope` : '';
    const status = p.cancelled ? ' – aktuell aufgehoben' : '';
    const waiting = p.waitingFor.length ? ` · wartet auf ${p.waitingFor.join(', ')}` : '';
    $('nope-text').textContent = `${p.byName} spielt ${p.label}${target}${nopes}${status}${waiting}`;
    $('btn-nope').disabled = !p.youCanNope;
    $('btn-pass').disabled = !p.youCanNope;
    bar.classList.remove('hidden');

    clearInterval(nopeTimer);
    const total = 6000;
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
    if (!v.prompt && (modalMode === 'defuse' || modalMode === 'favor')) closeModal();

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
    quick.className = 'modal-foot';
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
    const cards = [...v.you.hand].sort((a, b) => SORT_ORDER.indexOf(a.id) - SORT_ORDER.indexOf(b.id));
    const row = document.createElement('div');
    row.className = 'peek-row';
    cards.forEach((c) => {
      const el = cardEl(c.id);
      el.addEventListener('click', () => {
        emit('respondPrompt', { uid: c.uid });
        closeModal();
      });
      row.appendChild(el);
    });
    openModal({
      mode: 'favor',
      title: '🙏 Gefallen',
      text: `${v.prompt.requesterName} möchte eine Karte von dir. Wähle aus, welche du abgibst.`,
      body: [row],
      foot: []
    });
  }

  function openPeekModal(v) {
    const row = document.createElement('div');
    row.className = 'peek-row';
    v.peek.forEach((id, i) => {
      const el = cardEl(id, '');
      el.style.cursor = 'default';
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
      text: 'Das sind die obersten Karten des Nachziehstapels – nur du siehst sie.',
      body: [row],
      foot: [button('Alles klar', 'primary', () => { emit('clearPeek'); closeModal(); })]
    });
  }

  function openOverModal(v) {
    const foot = [];
    if (v.you && v.you.isHost) foot.push(button('Neue Runde', 'primary', () => { emit('backToLobby'); closeModal(); }));
    foot.push(button('Schließen', 'ghost', () => closeModal()));
    openModal({
      mode: 'over',
      title: v.winnerId === v.youId ? '🏆 Du hast gewonnen!' : '💥 Runde beendet',
      text: v.winnerName ? `${v.winnerName} ist als Letzte(r) übrig geblieben.` : 'Niemand hat überlebt.',
      body: [],
      foot
    });
  }

  $('btn-rules').addEventListener('click', () => {
    const ol = document.createElement('div');
    ol.innerHTML = document.querySelector('.rules ol').outerHTML;
    openModal({ mode: 'rules', title: 'Spielregeln', text: '', body: [ol], foot: [button('Schließen', 'primary', closeModal)] });
  });

  $('modal').addEventListener('click', (e) => {
    if (e.target !== $('modal')) return;
    if (modalMode === 'defuse' || modalMode === 'favor') return; // Pflichtentscheidung
    closeModal();
    render();
  });

  /* ------------------------------------------------------------------ Render */

  function render() {
    if (!view) { showScreen('home'); return; }
    if (view.phase === 'lobby') {
      showScreen('lobby');
      renderLobby(view);
      $('nope-bar').classList.add('hidden');
      if (modalMode && modalMode !== 'rules') closeModal();
      return;
    }
    showScreen('game');
    renderGame(view);
    renderNope(view);
    renderPrompt(view);
  }

  /* ------------------------------------------------------------- Socket-Events */

  socket.on('state', (v) => {
    view = v;
    myCode = v.code;
    render();
  });

  socket.on('toast', (msg) => toast(msg));

  socket.on('kicked', () => {
    toast('Du hast dieses Spiel in einem anderen Tab geöffnet.', true);
    view = null;
    showScreen('home');
  });

  socket.on('connect', () => {
    const code = (location.hash || '').replace(/[^0-9]/g, '') || myCode || store.lastCode;
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
  const hashCode = (location.hash || '').replace(/[^0-9]/g, '');
  if (hashCode.length === 4) $('input-code').value = hashCode;
})();
