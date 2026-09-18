const socket = io();

const $ = (id) => document.getElementById(id);
let state = null;
let me = { playerId: localStorage.getItem('bingo_playerId') || null, roomCode: localStorage.getItem('bingo_roomCode') || null, isHost: false };
let config = { cardCount: 30, maxPlayers: 20, numberMin: 1, numberMax: 75 };
let selectedPreviewCard = null;
let selectedRange = { min: 1, max: 75 };

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function pad(n) { return String(n).padStart(2, '0'); }
function showToast(message, type = '') { const el = $('toast'); el.textContent = message; el.className = `toast ${type}`; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.classList.add('hidden'), 2600); }
function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); $(id).classList.add('active'); window.scrollTo(0,0); }
function rangeCount() { return selectedRange.max - selectedRange.min + 1; }

// Navigation
$('btn-go-create').onclick = () => showScreen('screen-create');
$('btn-go-join').onclick = () => showScreen('screen-join');
$('btn-back-1').onclick = () => showScreen('screen-home');
$('btn-back-2').onclick = () => showScreen('screen-home');
$('btn-pick-back').onclick = () => showScreen('screen-lobby');
$('btn-close-preview').onclick = () => $('modal-preview').classList.add('hidden');
$('btn-close-bingo').onclick = () => $('modal-bingo').classList.add('hidden');

function clearSessionAndGoHome(message = '') {
  localStorage.removeItem('bingo_playerId');
  localStorage.removeItem('bingo_roomCode');
  me = { playerId: null, roomCode: null, isHost: false };
  state = null;
  selectedPreviewCard = null;
  if (message) showToast(message, 'success');
  showScreen('screen-home');
}

function leaveRoom() {
  if (!me.playerId || !me.roomCode) return clearSessionAndGoHome();
  const hostLeaving = !!me.isHost;
  const message = hostLeaving
    ? 'ออกจากห้องในฐานะ Host? ห้องจะถูกปิดและผู้เล่นทุกคนจะถูกนำออกจากห้อง'
    : 'ต้องการออกจากห้องนี้ใช่ไหม?';
  if (!confirm(message)) return;

  socket.emit('leave_room', {}, res => {
    if (!res.ok) return showToast(res.error || 'ออกจากห้องไม่สำเร็จ', 'error');
    clearSessionAndGoHome(hostLeaving ? 'ปิดห้องเรียบร้อยแล้ว' : 'ออกจากห้องเรียบร้อยแล้ว');
  });
}

$('btn-leave-lobby').onclick = leaveRoom;
$('btn-leave-pick').onclick = leaveRoom;
$('btn-leave-game').onclick = leaveRoom;

function setupChips(id, callback) {
  document.querySelectorAll(`#${id} .chip`).forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll(`#${id} .chip`).forEach(x => x.classList.remove('active'));
    btn.classList.add('active'); callback(Number(btn.dataset.value));
  }));
}
setupChips('chip-cardcount', v => config.cardCount = v);
setupChips('chip-maxplayers', v => config.maxPlayers = v);

document.querySelectorAll('#chip-range .range-chip').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#chip-range .range-chip').forEach(x => x.classList.remove('active'));
  btn.classList.add('active');
  const custom = btn.dataset.custom === '1';
  $('range-custom-inputs').classList.toggle('hidden', !custom);
  if (!custom) selectedRange = { min: Number(btn.dataset.min), max: Number(btn.dataset.max) };
  updateCreateRangePreview();
}));
$('input-range-min').addEventListener('input', updateCustomRange);
$('input-range-max').addEventListener('input', updateCustomRange);
function updateCustomRange() { const min = Number($('input-range-min').value); const max = Number($('input-range-max').value); if (Number.isFinite(min) && Number.isFinite(max)) selectedRange = { min, max }; updateCreateRangePreview(); }
function updateCreateRangePreview() {
  const valid = selectedRange.max >= selectedRange.min && selectedRange.max - selectedRange.min + 1 >= 25;
  $('create-range-preview').textContent = valid ? `${selectedRange.min} – ${selectedRange.max}` : 'ไม่ถูกต้อง';
  $('create-range-count').textContent = valid ? rangeCount() : '—';
}
updateCreateRangePreview();

$('btn-create-room').onclick = () => {
  const hostName = $('input-host-name').value.trim() || 'Host';
  const min = Number(selectedRange.min), max = Number(selectedRange.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max - min + 1 < 25 || max > 999) return showToast('ช่วงเลขต้องเป็นจำนวนเต็มอย่างน้อย 25 ตัว และไม่เกิน 999', 'error');
  socket.emit('create_room', { hostName, config: { ...config, numberMin: min, numberMax: max } }, res => {
    if (!res.ok) return showToast(res.error, 'error');
    me = { playerId: res.playerId, roomCode: res.roomCode, isHost: true };
    localStorage.setItem('bingo_playerId', me.playerId); localStorage.setItem('bingo_roomCode', me.roomCode);
    showToast(`สร้างห้อง ${res.roomCode} สำเร็จ`, 'success');
  });
};

$('btn-join-room').onclick = () => {
  const roomCode = $('input-room-code').value.trim().toUpperCase(); const playerName = $('input-player-name').value.trim() || 'Player';
  if (!roomCode) return showToast('กรุณาใส่ Room Code', 'error');
  socket.emit('join_room', { roomCode, playerName }, res => {
    if (!res.ok) return showToast(res.error, 'error');
    me = { playerId: res.playerId, roomCode: res.roomCode, isHost: false };
    localStorage.setItem('bingo_playerId', me.playerId); localStorage.setItem('bingo_roomCode', me.roomCode);
  });
};

socket.on('connect', () => {
  if (me.playerId && me.roomCode) socket.emit('rejoin_room', { roomCode: me.roomCode, playerId: me.playerId }, res => {
    if (!res.ok) return;
    me.isHost = !!res.isHost; state = res.state; renderAll();
    if (res.myCard) renderMyCard(res.myCard);
  });
});
socket.on('connect_error', () => showToast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'error'));
socket.on('room_state', next => { state = next; renderAll(); });
socket.on('game_started', () => showToast('เกมเริ่มแล้ว! 🎱', 'success'));
socket.on('number_drawn', info => { renderDraw(info.number, info.calledNumbers); });
socket.on('host_disconnected', () => showToast('Host หลุดการเชื่อมต่อชั่วคราว', 'error'));
socket.on('room_closed', info => {
  clearSessionAndGoHome(info?.reason || 'ห้องถูกปิดแล้ว');
});
socket.on('bingo', info => { renderWinners(state); openBingo(info); });
socket.on('game_ended', info => { renderResults(info.winners || (state && state.winners) || []); showScreen('screen-results'); });
socket.on('game_reset', () => { $('modal-bingo').classList.add('hidden'); showScreen('screen-lobby'); });

function renderAll() {
  if (!state) return;
  config = { ...config, ...state.config }; me.isHost = state.hostId === me.playerId;
  $('lobby-room-code').textContent = state.roomCode; $('game-room-code').textContent = state.roomCode; $('game-player-name').textContent = me.isHost ? '👑 Host' : getMeName();
  const total = state.config.numberMax - state.config.numberMin + 1;
  $('stat-players').textContent = `${state.players.length}/${state.config.maxPlayers}`;
  $('stat-cards').textContent = `${state.cards.filter(c => c.status === 'selected').length}/${state.cards.length}`;
  $('stat-range').textContent = total; $('lobby-config').textContent = `🎱 ${state.config.numberMin}–${state.config.numberMax} • ${state.cards.length} บัตร`;
  $('lobby-host-banner').classList.toggle('hidden', state.hostConnected); $('game-host-banner').classList.toggle('hidden', state.hostConnected);
  $('btn-go-pick-card').classList.toggle('hidden', state.gameStatus !== 'lobby');
  $('btn-toggle-host-panel').classList.toggle('hidden', !me.isHost);
  $('btn-start-game').classList.toggle('hidden', !(me.isHost && state.gameStatus === 'lobby'));
  $('host-start-hint').classList.toggle('hidden', !(me.isHost && state.gameStatus === 'lobby'));
  if (me.isHost && state.gameStatus === 'lobby') $('host-start-hint').textContent = 'ผู้เล่นควรเลือกบัตรก่อนเริ่มเกม';
  renderLobbyPlayers(); renderNumberBoard(); renderWinners(state); renderHostPlayers(); renderCalledHistory(); renderCurrent();
  if (state.gameStatus === 'lobby') {
    const my = state.players.find(p => p.playerId === me.playerId);
    $('lobby-my-status').innerHTML = my?.selectedCardId ? `✅ คุณเลือกบัตรแล้ว <strong>#${getCardNumber(my.selectedCardId)}</strong>` : 'ยังไม่ได้เลือกบัตร';
    if (document.querySelector('#screen-game.active')) showScreen('screen-lobby');
  } else if (state.gameStatus === 'playing') {
    showScreen('screen-game'); socket.emit('get_my_card', {}, res => { if (res.ok && res.myCard) renderMyCard(res.myCard); });
  } else if (state.gameStatus === 'ended') showScreen('screen-results');
}
function getMeName() { return state?.players.find(p => p.playerId === me.playerId)?.playerName || 'Player'; }
function getCardNumber(cardId) { return state?.cards.find(c => c.cardId === cardId)?.cardNumber || '?'; }

function renderLobbyPlayers() {
  const list = $('lobby-player-list'); list.innerHTML = '';
  (state.players || []).forEach(p => { const div = document.createElement('div'); div.className='player-row'; div.innerHTML=`<div><div class="name">${p.isHost?'👑 ':''}${escapeHtml(p.playerName)}</div><small>${p.selectedCardId ? `🎟️ บัตร #${pad(getCardNumber(p.selectedCardId))}` : 'ยังไม่เลือกบัตร'}</small></div><span class="status-dot" title="${p.connected?'ออนไลน์':'ออฟไลน์'}">${p.connected?'🟢':'⚫'}</span>`; list.appendChild(div); });
}

$('btn-go-pick-card').onclick = () => { renderCardGrid(); showScreen('screen-pick'); };
$('btn-start-game').onclick = () => socket.emit('start_game', {}, res => { if (!res.ok) showToast(res.error, 'error'); });

function renderCardGrid() {
  const grid = $('card-grid'); grid.innerHTML = '';
  const selected = new Set((state.cards || []).filter(c => c.status === 'selected').map(c => c.cardId));
  $('pick-progress').textContent = `${selected.size}/${state.cards.length} ถูกเลือก`;
  state.cards.forEach(card => {
    const mine = state.players.find(p => p.playerId === me.playerId)?.selectedCardId === card.cardId;
    const el = document.createElement('div'); el.className=`select-card ${card.status==='selected'&&!mine?'locked':''} ${mine?'selected':''}`;
    el.innerHTML=`<div class="select-card-head"><strong>บัตร #${pad(card.cardNumber)}</strong><span class="card-lock">${mine?'✓ ของฉัน':card.status==='selected'?'🔒 ถูกเลือก':'ว่าง'}</span></div><div class="mini-grid">${card.numbers.flat().map(n=>`<div class="mini-cell">${n}</div>`).join('')}</div>`;
    if (card.status !== 'selected' || mine) el.onclick = () => openPreview(card);
    grid.appendChild(el);
  });
}
function openPreview(card) { selectedPreviewCard = card; $('preview-title').textContent=`Card #${pad(card.cardNumber)}`; $('preview-grid').innerHTML=card.numbers.flat().map(n=>`<div class="mini-cell">${n}</div>`).join(''); $('modal-preview').classList.remove('hidden'); }
$('btn-select-this-card').onclick = () => { if (!selectedPreviewCard) return; socket.emit('select_card', { cardId: selectedPreviewCard.cardId }, res => { if (!res.ok) return showToast(res.error,'error'); $('modal-preview').classList.add('hidden'); showToast(`เลือกบัตร #${pad(res.card.cardNumber)} แล้ว`,'success'); }); };

function renderCurrent() { renderDraw(state.currentNumber, state.calledNumbers || []); }
function renderDraw(number, called) { const total=state.config.numberMax-state.config.numberMin+1; $('current-number').textContent=number ?? '-'; $('remaining-label').textContent=total-(called||[]).length; $('called-count').textContent=(called||[]).length; }
function renderCalledHistory() { const history=$('called-history'); history.innerHTML=''; [...(state.calledNumbers||[])].reverse().slice(0,18).forEach((n,i)=>{ const el=document.createElement('span'); el.className=`called-ball ${i===0?'latest':''}`; el.textContent=n; history.appendChild(el); }); }

function renderMyCard(card) {
  if (!card) return; $('my-card-number').textContent=`บัตร #${pad(card.cardNumber)}`; const called=new Set(state?.calledNumbers||[]); const marked=new Set(card.markedNumbers||[]); const grid=$('my-card-grid'); grid.innerHTML='';
  card.numbers.flat().forEach((n,index)=>{ const cell=document.createElement('button'); cell.type='button'; cell.className=`mini-cell ${called.has(n)?'called':''} ${marked.has(n)?'marked':''}`; cell.textContent=n; cell.onclick=()=>{ if (!called.has(n)) return showToast('เลขนี้ยังไม่ถูกสุ่มออกมา','error'); socket.emit('mark_number',{number:n},res=>{ if(!res.ok) showToast(res.error,'error'); else if(res.bingo) cell.classList.add('bingo-hit'); }); }; grid.appendChild(cell); });
}
function renderNumberBoard() {
  const board=$('number-board'); if(!board||!state) return; const min=state.config.numberMin,max=state.config.numberMax,called=new Set(state.calledNumbers||[]); $('number-board-total').textContent=max-min+1; board.innerHTML='';
  for(let n=min;n<=max;n++){ const el=document.createElement('div'); el.className=`number-dot ${called.has(n)?'called':''} ${state.currentNumber===n?'current':''}`; el.textContent=n; board.appendChild(el); }
}
function renderWinners(s) {
  const list=$('host-winners'); if(!list||!s)return; const winners=s.winners||[]; $('winner-count').textContent=winners.length; list.innerHTML='';
  if(!winners.length){list.innerHTML='<div class="winner-empty">ยังไม่มีใคร Bingo 🎯</div>';return;}
  winners.forEach((w,i)=>{ const el=document.createElement('div'); el.className='winner-item'; el.innerHTML=`<div><strong>${i===0?'🥇':i===1?'🥈':'🏆'} ${escapeHtml(w.playerName)}</strong><small>บัตร #${pad(w.cardNumber)} • ออกเลข ${w.winningNumber}</small></div><div class="winner-pattern">${escapeHtml(w.pattern)}</div>`; list.appendChild(el); });
}
function renderHostPlayers(){ const list=$('host-player-list'); if(!list||!state)return; $('host-player-count').textContent=state.players.length; list.innerHTML=''; state.players.forEach(p=>{const el=document.createElement('div');el.className='host-player';el.innerHTML=`<div><div class="pname">${p.isHost?'👑 ':''}${escapeHtml(p.playerName)}</div><div class="pmeta">${p.selectedCardId?'บัตร #'+pad(getCardNumber(p.selectedCardId)):'ยังไม่เลือก'} • ทำเครื่องหมาย ${p.markedCount||0}</div></div><span>${p.connected?'🟢':'⚫'}</span>`;list.appendChild(el)}); }

$('btn-toggle-host-panel').onclick=()=>{$('host-panel').classList.toggle('hidden')};
$('btn-draw-number').onclick=()=>socket.emit('draw_number',{},res=>{if(!res.ok)showToast(res.error,'error')});
$('btn-end-game').onclick=()=>{if(confirm('ต้องการจบเกมตอนนี้ใช่ไหม?'))socket.emit('end_game',{},res=>{if(!res.ok)showToast(res.error,'error')})};

function openBingo(info){ $('bingo-names').innerHTML=`<div class="bingo-winner"><div class="name">🏆 ${escapeHtml(info.playerName)}</div><div class="meta">บัตร #${pad(info.cardNumber)} • ${escapeHtml(info.pattern)}</div></div>`; $('modal-bingo').classList.remove('hidden'); }
function renderResults(winners){const list=$('results-list');list.innerHTML=''; if(!winners.length){list.innerHTML='<div class="winner-empty">ยังไม่มีผู้ชนะ</div>';} winners.forEach((w,i)=>{const el=document.createElement('div');el.className='result-row';el.innerHTML=`<div><span class="rank">#${i+1} ${escapeHtml(w.playerName)}</span><small>บัตร #${pad(w.cardNumber)}</small></div><span>${escapeHtml(w.pattern)}</span>`;list.appendChild(el)}); $('btn-play-again-host').classList.toggle('hidden',!me.isHost); $('play-again-options').classList.toggle('hidden',!me.isHost); $('results-wait-hint').classList.toggle('hidden',me.isHost); }
$('btn-confirm-play-again').onclick=()=>{const reuse=document.querySelector('input[name="reuse"]:checked').value==='reuse';socket.emit('play_again',{reuseCards:reuse},res=>{if(!res.ok)showToast(res.error,'error')})};

// Update selected card grid after room state changes.
socket.on('room_state', next => { if(next.gameStatus==='lobby' && $('screen-pick').classList.contains('active')) renderCardGrid(); if(next.gameStatus==='playing'){socket.emit('get_my_card',{},res=>{if(res.ok&&res.myCard)renderMyCard(res.myCard)})} });
