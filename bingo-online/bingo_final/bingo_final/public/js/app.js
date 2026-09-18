const socket = io();
const $ = id => document.getElementById(id);
let state = null;
let me = { playerId: localStorage.getItem('bingo_playerId'), roomCode: localStorage.getItem('bingo_roomCode'), isHost: false };
let config = { cardCount:30, maxPlayers:20, numberMin:1, numberMax:75 };
let selectedRange = {min:1,max:75};
let selectedPreviewCard = null;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const totalNumbers = () => selectedRange.max-selectedRange.min+1;
function toast(msg,type=''){ const t=$('toast'); t.textContent=msg; t.className=`toast ${type}`; clearTimeout(toast.timer); toast.timer=setTimeout(()=>t.classList.add('hidden'),3000); }
function screen(id){ document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active')); $(id).classList.add('active'); window.scrollTo({top:0,behavior:'smooth'}); }
function requireName(input,label){ const v=input.value.trim(); if(!v){ input.focus(); toast(`กรุณากรอก${label}`,'error'); input.classList.add('shake'); setTimeout(()=>input.classList.remove('shake'),350); return null; } return v; }

$('btn-go-create').onclick=()=>screen('screen-create');
$('btn-go-join').onclick=()=>screen('screen-join');
$('btn-back-1').onclick=()=>screen('screen-home');
$('btn-back-2').onclick=()=>screen('screen-home');
$('btn-pick-back').onclick=()=>screen('screen-lobby');
$('btn-close-preview').onclick=()=>$('modal-preview').classList.add('hidden');
$('btn-close-bingo').onclick=()=>$('modal-bingo').classList.add('hidden');
$('btn-close-bingo-2').onclick=()=>$('modal-bingo').classList.add('hidden');

function chips(id, fn){ document.querySelectorAll(`#${id} .chip`).forEach(b=>b.onclick=()=>{document.querySelectorAll(`#${id} .chip`).forEach(x=>x.classList.remove('active'));b.classList.add('active');fn(+b.dataset.value);}); }
chips('chip-cardcount',v=>config.cardCount=v); chips('chip-maxplayers',v=>config.maxPlayers=v);
document.querySelectorAll('#chip-range .range-card').forEach(b=>b.onclick=()=>{document.querySelectorAll('#chip-range .range-card').forEach(x=>x.classList.remove('active'));b.classList.add('active');const custom=b.dataset.custom==='1';$('range-custom-inputs').classList.toggle('hidden',!custom);if(!custom)selectedRange={min:+b.dataset.min,max:+b.dataset.max};updateRangePreview();});
$('input-range-min').oninput=updateCustomRange;$('input-range-max').oninput=updateCustomRange;
function updateCustomRange(){selectedRange={min:+$('input-range-min').value,max:+$('input-range-max').value};updateRangePreview();}
function updateRangePreview(){const valid=Number.isInteger(selectedRange.min)&&Number.isInteger(selectedRange.max)&&selectedRange.min>=1&&selectedRange.max>=selectedRange.min&&totalNumbers()>=25&&selectedRange.max<=999;$('create-range-preview').textContent=valid?`${selectedRange.min} – ${selectedRange.max}`:'ไม่ถูกต้อง';$('create-range-count').textContent=valid?totalNumbers():'—';}
updateRangePreview();

$('btn-create-room').onclick=()=>{
  const hostName=requireName($('input-host-name'),'ชื่อของคุณ'); if(!hostName)return;
  const min=selectedRange.min,max=selectedRange.max;
  if(!Number.isInteger(min)||!Number.isInteger(max)||min<1||max<min||max>999||max-min+1<25)return toast('ช่วงเลขต้องมีอย่างน้อย 25 ตัว และไม่เกิน 999','error');
  const btn=$('btn-create-room');btn.disabled=true;btn.classList.add('loading');
  socket.emit('create_room',{hostName,config:{...config,numberMin:min,numberMax:max}},res=>{
    btn.disabled=false;btn.classList.remove('loading');
    if(!res?.ok)return toast(res?.error||'สร้างห้องไม่สำเร็จ','error');
    me={playerId:res.playerId,roomCode:res.roomCode,isHost:true};localStorage.setItem('bingo_playerId',me.playerId);localStorage.setItem('bingo_roomCode',me.roomCode);
    toast(`สร้างห้อง ${res.roomCode} สำเร็จ`,'success');
    setTimeout(()=>screen('screen-lobby'),80);
  });
};
$('btn-join-room').onclick=()=>{
  const code=$('input-room-code').value.trim().toUpperCase(); if(!code)return toast('กรุณาใส่รหัสห้อง','error');
  const name=requireName($('input-player-name'),'ชื่อของคุณ'); if(!name)return;
  socket.emit('join_room',{roomCode:code,playerName:name},res=>{if(!res?.ok)return toast(res?.error||'เข้าห้องไม่สำเร็จ','error');me={playerId:res.playerId,roomCode:res.roomCode,isHost:false};localStorage.setItem('bingo_playerId',me.playerId);localStorage.setItem('bingo_roomCode',me.roomCode);toast('เข้าห้องสำเร็จ','success');setTimeout(()=>screen('screen-lobby'),80);});
};
$('input-room-code').oninput=e=>e.target.value=e.target.value.toUpperCase();

socket.on('connect',()=>{ if(me.playerId&&me.roomCode)socket.emit('rejoin_room',{roomCode:me.roomCode,playerId:me.playerId},res=>{if(!res?.ok){localStorage.removeItem('bingo_playerId');localStorage.removeItem('bingo_roomCode');return;}me.isHost=!!res.isHost;state=res.state;renderAll();if(res.myCard)renderMyCard(res.myCard);}); });
socket.on('connect_error',()=>toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้','error'));
socket.on('room_state',s=>{state=s;renderAll();if(document.querySelector('#screen-pick.active'))renderCardGrid();});
socket.on('game_started',()=>{toast('เกมเริ่มแล้ว! 🎱','success');screen('screen-game');});
socket.on('number_drawn',info=>{if(state){state.currentNumber=info.number;state.calledNumbers=info.calledNumbers;}renderCurrent();renderCalledHistory();renderNumberBoard();});
socket.on('host_disconnected',()=>toast('Host หลุดการเชื่อมต่อชั่วคราว','error'));
socket.on('kicked',msg=>{localStorage.removeItem('bingo_playerId');localStorage.removeItem('bingo_roomCode');state=null;me={playerId:null,roomCode:null,isHost:false};$('modal-bingo').classList.add('hidden');screen('screen-home');toast(msg?.message||'คุณถูก Host นำออกจากห้อง','error');});
socket.on('room_closed',msg=>{localStorage.removeItem('bingo_playerId');localStorage.removeItem('bingo_roomCode');state=null;me={playerId:null,roomCode:null,isHost:false};$('modal-bingo').classList.add('hidden');screen('screen-home');toast(msg?.message||'Host ปิดห้องแล้ว','error');});
socket.on('bingo',info=>{renderWinners(state);openBingo(info);});
socket.on('game_ended',info=>{renderResults(info.winners||[]);screen('screen-results');});
socket.on('game_reset',()=>{$('modal-bingo').classList.add('hidden');screen('screen-lobby');});

function renderAll(){
 if(!state)return;config={...config,...state.config};me.isHost=state.hostId===me.playerId;
 $('lobby-room-code').textContent=state.roomCode;$('game-room-code').textContent=state.roomCode;$('game-player-name').textContent=me.isHost?'👑 Host':getMeName();
 const total=state.config.numberMax-state.config.numberMin+1, selected=state.cards.filter(c=>c.status==='selected').length;
 $('stat-players').textContent=`${state.players.length}/${state.config.maxPlayers}`;$('stat-cards').textContent=`${selected}/${state.cards.length}`;$('stat-range').textContent=total;
 $('lobby-config').textContent=`🎱 ${state.config.numberMin}–${state.config.numberMax} • ${state.cards.length} บัตร • สูงสุด ${state.config.maxPlayers} คน`;
 $('lobby-role').textContent=me.isHost?'👑 Host':'🎟️ Player';$('lobby-host-banner').classList.toggle('hidden',state.hostConnected);$('game-host-banner').classList.toggle('hidden',state.hostConnected);
 $('btn-go-pick-card').classList.toggle('hidden',me.isHost||state.gameStatus!=='lobby');$('btn-start-game').classList.toggle('hidden',!(me.isHost&&state.gameStatus==='lobby'));$('host-start-hint').classList.toggle('hidden',!(me.isHost&&state.gameStatus==='lobby'));$('host-panel').classList.toggle('hidden',!(me.isHost&&state.gameStatus==='playing'));$('host-kick-hint').classList.toggle('hidden',!me.isHost||state.gameStatus!=='lobby');
 renderLobbyPlayers();renderCurrent();renderCalledHistory();renderNumberBoard();renderWinners(state);renderHostPlayers();
 const mine=state.players.find(p=>p.playerId===me.playerId);$('lobby-my-status').innerHTML=me.isHost?'👑 คุณคือ Host — ไม่ต้องเลือกบัตร':mine?.selectedCardId?`✅ บัตรของคุณ <strong>#${pad(getCardNumber(mine.selectedCardId))}</strong> พร้อมเล่น`:'🎟️ คุณยังไม่ได้เลือกบัตร';
 if(state.gameStatus==='lobby'){if(document.querySelector('#screen-game.active'))screen('screen-lobby');}
 else if(state.gameStatus==='playing'){screen('screen-game');socket.emit('get_my_card',{},res=>{if(res?.ok&&res.myCard)renderMyCard(res.myCard);});}
 else if(state.gameStatus==='ended'){screen('screen-results');}
}
function getMeName(){return state?.players.find(p=>p.playerId===me.playerId)?.playerName||'Player';}
function getCardNumber(id){return state?.cards.find(c=>c.cardId===id)?.cardNumber||'?';}
function renderLobbyPlayers(){
 const list=$('lobby-player-list');
 list.innerHTML='';
 $('player-online-count').textContent=`${state.players.filter(p=>p.connected).length} ออนไลน์`;
 state.players.forEach(p=>{
   const e=document.createElement('div');
   e.className='player-row';
   const kick=(me.isHost&&!p.isHost)?`<button class="kick-btn" data-kick="${p.playerId}" type="button">เตะ</button>`:'';
   e.innerHTML=`<div class="avatar">${p.isHost?'👑':'🎟️'}</div><div class="player-info"><b>${esc(p.playerName)}</b><small>${p.isHost?'Host':p.selectedCardId?'เลือกบัตรแล้ว':'กำลังเลือกบัตร'}</small></div><span class="online ${p.connected?'on':''}"></span>${kick}`;
   list.appendChild(e);
 });
 list.querySelectorAll('[data-kick]').forEach(btn=>{
   btn.onclick=()=>{
     const p=state.players.find(x=>x.playerId===btn.dataset.kick);
     if(!p)return;
     if(confirm(`ต้องการเตะ "${p.playerName}" ออกจากห้องใช่ไหม?`)){
       socket.emit('kick_player',{targetPlayerId:p.playerId},res=>{
         if(!res?.ok)toast(res?.error||'เตะผู้เล่นไม่สำเร็จ','error');
         else toast(`นำ ${p.playerName} ออกจากห้องแล้ว`,'success');
       });
     }
   };
 });
}
$('btn-go-pick-card').onclick=()=>{renderCardGrid();screen('screen-pick');};
$('btn-start-game').onclick=()=>socket.emit('start_game',{},res=>{if(!res?.ok)toast(res.error,'error');});

function renderCardGrid(){const grid=$('card-grid');grid.innerHTML='';const mine=state.players.find(p=>p.playerId===me.playerId)?.selectedCardId;const selected=new Set(state.cards.filter(c=>c.status==='selected').map(c=>c.cardId));$('pick-progress').textContent=`${selected.size}/${state.cards.length} ถูกเลือก`;state.cards.forEach(card=>{const isMine=card.cardId===mine;const locked=card.status==='selected'&&!isMine;const e=document.createElement('button');e.type='button';e.className=`select-card ${locked?'locked':''} ${isMine?'selected':''}`;e.innerHTML=`<div class="select-head"><b>บัตร #${pad(card.cardNumber)}</b><span>${isMine?'✓ ของฉัน':locked?'🔒 ถูกเลือก':'ว่าง'}</span></div><div class="bingo-head mini"><b>B</b><b>I</b><b>N</b><b>G</b><b>O</b></div><div class="bingo-grid card-preview-grid">${(card.numbers||[]).flat().map(n=>`<span>${n}</span>`).join('')}</div><div class="card-foot">${isMine?'✓ เลือกอยู่':locked?'✕ ถูกเลือกแล้ว':'แตะเพื่อดูบัตร'}</div>${locked?'<div class="card-lock-overlay">✕<small>ถูกเลือกแล้ว</small></div>':''}`;if(!locked)e.onclick=()=>openPreview(card);grid.appendChild(e);});}
function openPreview(card){selectedPreviewCard=card;$('preview-title').textContent=`บัตร #${pad(card.cardNumber)}`;$('preview-grid').innerHTML=(card.numbers||[]).flat().map(n=>`<span>${n}</span>`).join('');$('modal-preview').classList.remove('hidden');}
$('btn-select-this-card').onclick=()=>{if(!selectedPreviewCard)return;socket.emit('select_card',{cardId:selectedPreviewCard.cardId},res=>{if(!res?.ok)return toast(res.error,'error');$('modal-preview').classList.add('hidden');toast(`เลือกบัตร #${pad(res.card.cardNumber)} แล้ว`,'success');renderCardGrid();screen('screen-lobby');});};

function renderCurrent(){if(!state)return;const total=state.config.numberMax-state.config.numberMin+1;const n=state.currentNumber;$('current-number').textContent=n??'–';$('remaining-label').textContent=total-(state.calledNumbers||[]).length;$('called-count').textContent=(state.calledNumbers||[]).length;}
function renderCalledHistory(){if(!state)return;const h=$('called-history');h.innerHTML='';[...(state.calledNumbers||[])].reverse().slice(0,22).forEach((n,i)=>{const e=document.createElement('span');e.className=`called-ball ${i===0?'latest':''}`;e.textContent=n;h.appendChild(e);});}
function renderNumberBoard(){if(!state)return;const b=$('number-board');if(!b)return;b.innerHTML='';const called=new Set(state.calledNumbers||[]);const min=state.config.numberMin,max=state.config.numberMax;$('number-board-total').textContent=max-min+1;for(let n=min;n<=max;n++){const e=document.createElement('span');e.className=`number-dot ${called.has(n)?'called':''} ${state.currentNumber===n?'current':''}`;e.textContent=n;b.appendChild(e);}}
function renderMyCard(card){if(!card)return;$('my-card-number').textContent=`บัตร #${pad(card.cardNumber)}`;const called=new Set(state?.calledNumbers||[]),marked=new Set(card.markedNumbers||[]),grid=$('my-card-grid');grid.innerHTML='';(card.numbers||[]).flat().forEach(n=>{const e=document.createElement('button');e.type='button';e.className=`cell ${called.has(n)?'ready':''} ${marked.has(n)?'marked':''}`;e.textContent=n;e.onclick=()=>{if(!called.has(n))return toast('เลขนี้ยังไม่ออก','error');socket.emit('mark_number',{number:n},res=>{if(!res?.ok)toast(res.error,'error');else{e.classList.add('marked');if(res.bingo)e.classList.add('bingo-hit');}});};grid.appendChild(e);});}
function renderWinners(s){const list=$('host-winners');if(!list||!s)return;const ws=s.winners||[];$('winner-count').textContent=ws.length;list.innerHTML=ws.length?ws.map((w,i)=>`<div class="winner-item"><span class="winner-medal">${i===0?'🥇':i===1?'🥈':'🏆'}</span><div><b>${esc(w.playerName)}</b><small>บัตร #${pad(w.cardNumber)} • ${esc(w.pattern)}</small></div></div>`).join(''):'<div class="empty">ยังไม่มีใคร Bingo 🎯</div>';}
function renderHostPlayers(){const list=$('host-player-list');if(!list||!state)return;$('host-player-count').textContent=state.players.length;list.innerHTML=state.players.map(p=>{const winner=(state.winners||[]).some(w=>w.playerId===p.playerId);return `<div class="host-player"><div><b>${p.isHost?'👑 ':''}${esc(p.playerName)} ${winner?'🏆 BINGO':''}</b><small>${p.selectedCardId?'บัตร #'+pad(getCardNumber(p.selectedCardId)):'ยังไม่เลือกบัตร'} • ✓ ${p.markedCount||0} ดวง ${winner?'• BINGO แล้ว':''}</small></div><span class="online ${p.connected?'on':''}"></span></div>`;}).join('');}
function openBingo(info){$('bingo-names').innerHTML=`<div class="winner-big">🏆 ${esc(info.playerName)}</div><div class="winner-card">บัตร #${pad(info.cardNumber)}</div><div class="winner-pattern">${esc(info.pattern)}</div>`;$('modal-bingo').classList.remove('hidden');}
function renderResults(ws){const list=$('results-list');list.innerHTML=ws.length?ws.map((w,i)=>`<div class="result-row"><b>${i+1}. ${esc(w.playerName)}</b><span>บัตร #${pad(w.cardNumber)}</span></div>`).join(''):'<div class="empty">ยังไม่มีผู้ชนะ</div>';$('play-again-options').classList.toggle('hidden',!me.isHost);$('results-wait-hint').classList.toggle('hidden',me.isHost);}

function leaveRoom(){if(!me.roomCode)return;const host=me.isHost;const ok=confirm(host?'ออกจากห้องในฐานะ Host? ห้องจะถูกปิดและผู้เล่นทั้งหมดจะออกด้วย':'ต้องการออกจากห้องนี้ใช่ไหม?');if(!ok)return;socket.emit('leave_room',{},res=>{if(!res?.ok)return toast(res?.error||'ออกจากห้องไม่สำเร็จ','error');localStorage.removeItem('bingo_playerId');localStorage.removeItem('bingo_roomCode');state=null;me={playerId:null,roomCode:null,isHost:false};$('modal-bingo').classList.add('hidden');screen('screen-home');toast('ออกจากห้องแล้ว','success');});}
$('btn-leave-lobby').onclick=leaveRoom;$('btn-leave-game').onclick=leaveRoom;
$('btn-draw-number').onclick=()=>socket.emit('draw_number',{},res=>{if(!res?.ok)toast(res.error,'error');});
$('btn-end-game').onclick=()=>{if(confirm('ต้องการจบเกมตอนนี้ใช่ไหม?'))socket.emit('end_game',{},res=>{if(!res?.ok)toast(res.error,'error');});};
$('btn-confirm-play-again').onclick=()=>{const reuse=document.querySelector('input[name="reuse"]:checked')?.value==='reuse';socket.emit('play_again',{reuseCards:reuse},res=>{if(!res?.ok)toast(res.error,'error');});};
