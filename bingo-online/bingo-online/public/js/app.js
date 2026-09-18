const socket = io();

// ---------- persistent identity ----------
let myPlayerId = localStorage.getItem('bingo_playerId') || null;
let myRoomCode = localStorage.getItem('bingo_roomCode') || null;

let currentState = null;
let myCard = null; // { cardId, cardNumber, numbers, markedNumbers }
let activeScreen = 'home';
let previewCardId = null;

// ---------- generic helpers ----------
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return [...document.querySelectorAll(sel)]; }
function pad(n) { return String(n).padStart(2, '0'); }

function goTo(screenId) {
  activeScreen = screenId;
  $all('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById('screen-' + screenId);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
  if (screenId === 'pick') renderPickScreen();
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function saveIdentity(roomCode, playerId) {
  myRoomCode = roomCode;
  myPlayerId = playerId;
  localStorage.setItem('bingo_roomCode', roomCode);
  localStorage.setItem('bingo_playerId', playerId);
}
function clearIdentity() {
  myRoomCode = null; myPlayerId = null;
  localStorage.removeItem('bingo_roomCode');
  localStorage.removeItem('bingo_playerId');
}

// ---------- HOME ----------
$('#btn-go-create').onclick = () => goTo('create');
$('#btn-go-join').onclick = () => goTo('join');
$('#btn-back-1').onclick = () => goTo('home');
$('#btn-back-2').onclick = () => goTo('home');

// ---------- CREATE ROOM ----------
let cfgCardCount = 30, cfgMaxPlayers = 20, cfgMin = 1, cfgMax = 99, cfgCustom = false;

function wireChipGroup(groupSel, onPick) {
  $all(groupSel + ' .chip').forEach((btn) => {
    btn.onclick = () => {
      $all(groupSel + ' .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onPick(btn);
    };
  });
}
wireChipGroup('#chip-cardcount', (btn) => (cfgCardCount = Number(btn.dataset.value)));
wireChipGroup('#chip-maxplayers', (btn) => (cfgMaxPlayers = Number(btn.dataset.value)));
wireChipGroup('#chip-range', (btn) => {
  if (btn.dataset.custom) {
    cfgCustom = true;
    $('#range-custom-inputs').classList.remove('hidden');
  } else {
    cfgCustom = false;
    $('#range-custom-inputs').classList.add('hidden');
    cfgMin = Number(btn.dataset.min);
    cfgMax = Number(btn.dataset.max);
  }
});

$('#btn-create-room').onclick = () => {
  const hostName = $('#input-host-name').value.trim() || 'Host';
  if (cfgCustom) {
    cfgMin = Number($('#input-range-min').value) || 1;
    cfgMax = Number($('#input-range-max').value) || 99;
  }
  socket.emit(
    'create_room',
    { hostName, config: { cardCount: cfgCardCount, maxPlayers: cfgMaxPlayers, numberMin: cfgMin, numberMax: cfgMax } },
    (res) => {
      if (!res.ok) return toast(res.error || 'สร้างห้องไม่สำเร็จ');
      saveIdentity(res.roomCode, res.playerId);
      goTo('lobby');
    }
  );
};

// ---------- JOIN ROOM ----------
$('#btn-join-room').onclick = () => {
  const roomCode = $('#input-room-code').value.trim().toUpperCase();
  const playerName = $('#input-player-name').value.trim() || 'Player';
  if (!roomCode) return toast('กรุณากรอก Room Code');
  socket.emit('join_room', { roomCode, playerName }, (res) => {
    if (!res.ok) return toast(res.error || 'เข้าร่วมห้องไม่สำเร็จ');
    saveIdentity(res.roomCode, res.playerId);
    goTo('lobby');
  });
};

// ---------- auto-reconnect on load ----------
socket.on('connect', () => {
  if (myRoomCode && myPlayerId) {
    socket.emit('rejoin_room', { roomCode: myRoomCode, playerId: myPlayerId }, (res) => {
      if (!res.ok) {
        clearIdentity();
        return; // stay on home
      }
      myCard = res.myCard;
      applyRoomState(res.state);
    });
  }
});

// ---------- room_state (the single source of truth broadcast) ----------
socket.on('room_state', (state) => applyRoomState(state));

function applyRoomState(state) {
  currentState = state;
  const isHost = state.hostId === myPlayerId;

  renderLobby(state, isHost);
  if (activeScreen === 'pick') renderPickScreen();
  renderGame(state, isHost);
  renderResults(state, isHost);

  // routing based on game status
  if (state.gameStatus === 'playing') {
    if (activeScreen !== 'game') goTo('game');
  } else if (state.gameStatus === 'ended') {
    if (activeScreen !== 'results') goTo('results');
  } else if (state.gameStatus === 'lobby') {
    if (activeScreen === 'game' || activeScreen === 'results') goTo('lobby');
  }
}

// ---------- LOBBY ----------
function renderLobby(state, isHost) {
  $('#lobby-room-code').textContent = state.roomCode;
  $('#game-room-code').textContent = state.roomCode;
  $('#stat-players').textContent = `${state.players.length}/${state.config.maxPlayers}`;
  const selectedCards = state.cards.filter((c) => c.status === 'selected').length;
  $('#stat-cards').textContent = `${selectedCards}/${state.cards.length}`;

  $('#lobby-host-banner').classList.toggle('hidden', state.hostConnected !== false);

  const me = state.players.find((p) => p.playerId === myPlayerId);
  const pickBtn = $('#btn-go-pick-card');
  const statusEl = $('#lobby-my-status');

  if (!isHost) {
    pickBtn.classList.remove('hidden');
    if (me && me.selectedCardId) {
      const card = state.cards.find((c) => c.cardId === me.selectedCardId);
      pickBtn.textContent = `🎱 บัตรของคุณ: #${pad(card ? card.cardNumber : '?')} (แก้ไข)`;
      statusEl.textContent = '✅ คุณพร้อมแล้ว รอ Host เริ่มเกม';
    } else {
      pickBtn.textContent = '🎱 เลือกบัตร Bingo';
      statusEl.textContent = '⏳ กรุณาเลือกบัตรของคุณ';
    }
  } else {
    pickBtn.classList.add('hidden');
    statusEl.textContent = '';
  }

  // player list
  const list = $('#lobby-player-list');
  list.innerHTML = '';
  state.players.forEach((p) => {
    const card = state.cards.find((c) => c.cardId === p.selectedCardId);
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span class="pname ${p.connected ? '' : 'disconnected'}">${escapeHtml(p.playerName)}${p.isHost ? '<span class="badge-host">HOST</span>' : ''}</span>
      <span class="pcard">${card ? '#' + pad(card.cardNumber) : '-'}</span>
      <span class="${p.selectedCardId || p.isHost ? 'badge-ready' : 'badge-waiting'}">${p.selectedCardId || p.isHost ? '✅ พร้อม' : '⏳ ยังไม่เลือก'}</span>
    `;
    list.appendChild(row);
  });

  // host start button
  const startBtn = $('#btn-start-game');
  const hint = $('#host-start-hint');
  if (isHost) {
    startBtn.classList.remove('hidden');
    const nonHostPlayers = state.players.filter((p) => !p.isHost);
    const notReady = nonHostPlayers.filter((p) => !p.selectedCardId).length;
    if (nonHostPlayers.length === 0) {
      startBtn.disabled = true;
      hint.textContent = 'รอผู้เล่นเข้าร่วมห้องก่อน';
      hint.classList.remove('hidden');
    } else if (notReady > 0) {
      startBtn.disabled = true;
      hint.textContent = `ยังมีผู้เล่น ${notReady} คนที่ยังไม่เลือกบัตร`;
      hint.classList.remove('hidden');
    } else {
      startBtn.disabled = false;
      hint.classList.add('hidden');
    }
  } else {
    startBtn.classList.add('hidden');
    hint.classList.add('hidden');
  }
}

$('#btn-go-pick-card').onclick = () => goTo('pick');
$('#btn-pick-back').onclick = () => goTo('lobby');

$('#btn-start-game').onclick = () => {
  socket.emit('start_game', {}, (res) => {
    if (!res.ok) toast(res.error || 'เริ่มเกมไม่สำเร็จ');
  });
};

// ---------- CARD SELECT ----------
function renderPickScreen() {
  if (!currentState) return;
  const state = currentState;
  const me = state.players.find((p) => p.playerId === myPlayerId);
  const selectedCount = state.cards.filter((c) => c.status === 'selected').length;
  $('#pick-progress').textContent = `${selectedCount}/${state.cards.length} ถูกเลือกแล้ว`;

  const grid = $('#card-grid');
  grid.innerHTML = '';
  state.cards.forEach((c) => {
    const btn = document.createElement('button');
    const mine = me && me.selectedCardId === c.cardId;
    btn.className = 'mini-card-btn' + (mine ? ' mine' : c.status === 'selected' ? ' taken' : '');
    btn.textContent = '#' + pad(c.cardNumber);
    btn.onclick = () => openPreview(c.cardId);
    grid.appendChild(btn);
  });
}

function openPreview(cardId) {
  previewCardId = cardId;
  socket.emit('preview_card', { cardId }, (res) => {
    if (!res.ok) return toast(res.error || 'ไม่สามารถดูตัวอย่างบัตรได้');
    const { card } = res;
    $('#preview-title').textContent = `Card #${pad(card.cardNumber)}`;
    const gridEl = $('#preview-grid');
    gridEl.innerHTML = '';
    card.numbers.flat().forEach((n) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.textContent = n;
      gridEl.appendChild(cell);
    });
    const me = currentState.players.find((p) => p.playerId === myPlayerId);
    const isMine = me && me.selectedCardId === cardId;
    const selectBtn = $('#btn-select-this-card');
    if (card.status === 'selected' && !isMine) {
      selectBtn.disabled = true;
      selectBtn.textContent = '❌ บัตรนี้ถูกเลือกไปแล้ว';
    } else if (isMine) {
      selectBtn.disabled = true;
      selectBtn.textContent = '✅ นี่คือบัตรของคุณ';
    } else {
      selectBtn.disabled = false;
      selectBtn.textContent = 'เลือกบัตรนี้';
    }
    $('#modal-preview').classList.remove('hidden');
  });
}
$('#btn-close-preview').onclick = () => $('#modal-preview').classList.add('hidden');
$('#btn-select-this-card').onclick = () => {
  socket.emit('select_card', { cardId: previewCardId }, (res) => {
    if (!res.ok) {
      toast(res.error || 'เลือกบัตรไม่สำเร็จ');
      renderPickScreen();
      return;
    }
    myCard = { ...res.card, markedNumbers: [] };
    $('#modal-preview').classList.add('hidden');
    toast(`✅ เลือกบัตร #${pad(res.card.cardNumber)} แล้ว`);
    goTo('lobby');
  });
};

// ---------- GAME BOARD ----------
let lastAnimatedNumber = null;

function renderGame(state, isHost) {
  $('#game-host-banner').classList.toggle('hidden', state.hostConnected !== false);

  const total = state.config.numberMax - state.config.numberMin + 1;
  $('#current-number').textContent = state.currentNumber ?? '-';
  $('#remaining-label').textContent = `เหลืออีก ${total - state.calledNumbers.length} เลข`;

  if (state.currentNumber !== null && state.currentNumber !== lastAnimatedNumber) {
    lastAnimatedNumber = state.currentNumber;
    const el = $('#current-number');
    el.classList.remove('pop');
    // restart animation
    void el.offsetWidth;
    el.classList.add('pop');
  }

  const history = $('#called-history');
  history.innerHTML = '';
  state.calledNumbers
    .slice()
    .reverse()
    .forEach((n, i) => {
      const chip = document.createElement('span');
      chip.className = 'called-chip' + (i === 0 ? ' latest' : '');
      chip.textContent = n;
      history.appendChild(chip);
    });

  renderMyCard(state);

  // host controls
  const toggleBtn = $('#btn-toggle-host-panel');
  if (isHost) {
    toggleBtn.classList.remove('hidden');
    renderHostPlayerList(state);
  } else {
    toggleBtn.classList.add('hidden');
    $('#host-panel').classList.add('hidden');
  }
}

function renderMyCard(state) {
  const gridEl = $('#my-card-grid');
  if (!myCard) {
    gridEl.innerHTML = '<p class="hint">ไม่พบบัตรของคุณ</p>';
    return;
  }
  gridEl.innerHTML = '';
  myCard.numbers.flat().forEach((n) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const called = state.calledNumbers.includes(n);
    const marked = myCard.markedNumbers.includes(n);
    if (marked) {
      cell.classList.add('marked');
      cell.textContent = '❌' + n;
    } else if (called) {
      cell.classList.add('blink', 'callable');
      cell.textContent = n;
      cell.onclick = () => markNumber(n);
    } else {
      cell.textContent = n;
    }
    gridEl.appendChild(cell);
  });
}

function markNumber(n) {
  socket.emit('mark_number', { number: n }, (res) => {
    if (!res.ok) return toast(res.error || 'ทำเครื่องหมายไม่สำเร็จ');
    if (myCard) myCard.markedNumbers = res.markedNumbers;
    renderMyCard(currentState);
  });
}

$('#btn-toggle-host-panel').onclick = () => $('#host-panel').classList.toggle('hidden');
$('#btn-draw-number').onclick = () => {
  socket.emit('draw_number', {}, (res) => {
    if (!res.ok) toast(res.error || 'สุ่มเลขไม่สำเร็จ');
  });
};
$('#btn-end-game').onclick = () => {
  if (!confirm('ต้องการจบเกมตอนนี้เลยหรือไม่?')) return;
  socket.emit('end_game', {}, (res) => {
    if (!res.ok) toast(res.error || 'จบเกมไม่สำเร็จ');
  });
};

function renderHostPlayerList(state) {
  const list = $('#host-player-list');
  list.innerHTML = '';
  state.players
    .filter((p) => !p.isHost)
    .forEach((p) => {
      const card = state.cards.find((c) => c.cardId === p.selectedCardId);
      const row = document.createElement('div');
      row.className = 'host-player-row';
      row.innerHTML = `<span>${escapeHtml(p.playerName)} ${card ? '#' + pad(card.cardNumber) : ''}</span><span>${p.markedCount} กากบาท ${p.connected ? '' : '(หลุด)'}</span>`;
      list.appendChild(row);
    });
}

// ---------- BINGO popup ----------
socket.on('bingo', (info) => {
  const namesEl = $('#bingo-names');
  namesEl.innerHTML = `<div>${escapeHtml(info.playerName)}</div><div class="hint">Bingo ด้วยบัตร #${pad(info.cardNumber)} · ${escapeHtml(info.pattern)}</div>`;
  $('#modal-bingo').classList.remove('hidden');
});
$('#btn-close-bingo').onclick = () => $('#modal-bingo').classList.add('hidden');

// ---------- RESULTS ----------
function renderResults(state, isHost) {
  const list = $('#results-list');
  list.innerHTML = '';
  if (state.winners.length === 0) {
    list.innerHTML = '<p class="hint">ยังไม่มีผู้เล่นทำ Bingo สำเร็จ</p>';
  } else {
    state.winners.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      const time = new Date(w.time).toLocaleTimeString('th-TH');
      row.innerHTML = `<span><span class="result-rank">#${i + 1}</span>${escapeHtml(w.playerName)}</span><span>บัตร #${pad(w.cardNumber)} · เลข ${w.winningNumber} · ${time}</span>`;
      list.appendChild(row);
    });
  }

  const playAgainOptions = $('#play-again-options');
  const waitHint = $('#results-wait-hint');
  if (isHost) {
    playAgainOptions.classList.remove('hidden');
    waitHint.classList.add('hidden');
  } else {
    playAgainOptions.classList.add('hidden');
    waitHint.classList.remove('hidden');
  }
}

$('#btn-confirm-play-again').onclick = () => {
  const reuse = $('input[name="reuse"]:checked').value === 'reuse';
  socket.emit('play_again', { reuseCards: reuse }, (res) => {
    if (!res.ok) toast(res.error || 'เริ่มเกมใหม่ไม่สำเร็จ');
  });
};

// ---------- misc events ----------
socket.on('game_started', () => {
  lastAnimatedNumber = null;
  socket.emit('get_my_card', {}, (res) => {
    if (res.ok) myCard = res.myCard;
  });
});
socket.on('game_reset', () => {
  myCard = null;
  lastAnimatedNumber = null;
});
socket.on('host_disconnected', () => toast('⚠️ Host ขาดการเชื่อมต่อ'));

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
