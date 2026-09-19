require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const db = require('./db');
const { generateCards, checkBingo, generateRoomCode } = require('./gameLogic');

// Global server safety limit: maximum 80 players across all rooms.
const MAX_SERVER_PLAYERS = 80;

// After a game ends, keep the room for a short grace period so players can
// refresh/reconnect. If every non-host player has left the browser and stays
// offline for the full delay, reset the same room back to the lobby so the
// Host can continue using the same Room Code for a new group of players.
// Disconnected post-game players are kept in the room until they explicitly leave
// or the Host removes them. They do not block the next-round readiness count.
const disconnectedPlayerTimers = new Map();

function clearDisconnectedPlayerTimer(playerId) {
  const timer = disconnectedPlayerTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    disconnectedPlayerTimers.delete(playerId);
  }
}

function releasePlayerCard(player) {
  if (player?.selectedCardId) {
    db.updateCard(player.selectedCardId, { status: 'available', selectedBy: null });
  }
}

function resetRoomToLobby(roomId) {
  const room = db.getRoom(roomId);
  if (!room || room.gameStatus !== 'ended' || !room.hostConnected) return false;

  db.getPlayersByRoom(roomId).forEach((p) => {
    if (p.playerId === room.hostId) return;
    clearDisconnectedPlayerTimer(p.playerId);
    releasePlayerCard(p);
    db.deletePlayer(p.playerId);
  });

  db.updateRoom(roomId, {
    gameStatus: 'lobby',
    currentNumber: null,
    calledNumbers: [],
    winners: [],
    playAgainChoices: {},
  });

  db.getCardsByRoom(roomId).forEach((c) => {
    if (c.selectedBy !== room.hostId) {
      db.updateCard(c.cardId, { status: 'available', selectedBy: null });
    }
  });

  io.to(roomId).emit('game_reset', {
    reason: 'all_players_left',
    message: 'ผู้เล่นชุดเดิมออกจากห้องแล้ว ห้องเดิมพร้อมรับผู้เล่นชุดใหม่',
  });
  broadcastRoom(roomId);
  return true;
}

function maybeResetRoomAfterEveryoneLeaves(roomId) {
  const room = db.getRoom(roomId);
  if (!room || room.gameStatus !== 'ended' || !room.hostConnected) return false;

  const nonHosts = db.getPlayersByRoom(roomId).filter((p) => p.playerId !== room.hostId);
  if (nonHosts.length > 0) return false;

  return resetRoomToLobby(roomId);
}

function removeDisconnectedPlayer(playerId) {
  const player = db.getPlayer(playerId);
  if (!player) {
    clearDisconnectedPlayerTimer(playerId);
    return;
  }
  if (player.connected) {
    clearDisconnectedPlayerTimer(playerId);
    return;
  }

  const room = db.getRoom(player.roomId);
  clearDisconnectedPlayerTimer(playerId);
  releasePlayerCard(player);
  db.deletePlayer(playerId);

  if (room && room.gameStatus === 'ended') {
    const choices = { ...(room.playAgainChoices || {}) };
    delete choices[playerId];
    db.updateRoom(room.roomId, { playAgainChoices: choices });
    if (!maybeResetRoomAfterEveryoneLeaves(room.roomId)) {
      broadcastRoom(room.roomId);
    }
  }
}

function scheduleDisconnectedPlayerCleanup(playerId) {
  // Intentionally do not auto-remove disconnected players during the post-game
  // waiting phase. They may reconnect and choose reuse/new later, or the Host
  // can remove them manually.
  return;
}

function cleanupDisconnectedPlayersAtGameEnd(roomId) {
  // No automatic kick after the game ends. Disconnected players remain visible
  // to the Host but are excluded from next-round readiness counts.
  maybeResetRoomAfterEveryoneLeaves(roomId);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------- helpers ----------

function padCard(n) {
  return String(n).padStart(2, '0');
}

function roomStatePayload(room) {
  const players = db.getPlayersByRoom(room.roomId).map((p) => ({
    playerId: p.playerId,
    playerName: p.playerName,
    selectedCardId: p.selectedCardId,
    connected: p.connected,
    isHost: p.playerId === room.hostId,
    markedCount: p.markedNumbers.length,
  }));
  const cards = db.getCardsByRoom(room.roomId).map((c) => ({
    cardId: c.cardId,
    cardNumber: c.cardNumber,
    numbers: c.numbers,
    status: c.status,
    selectedBy: c.selectedBy,
  }));
  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    hostId: room.hostId,
    hostConnected: room.hostConnected,
    config: {
      cardCount: room.cardCount,
      maxPlayers: room.maxPlayers,
      numberMin: room.numberMin,
      numberMax: room.numberMax,
    },
    gameStatus: room.gameStatus, // 'lobby' | 'playing' | 'ended'
    currentNumber: room.currentNumber,
    calledNumbers: room.calledNumbers,
    winners: room.winners,
    playAgainChoices: room.playAgainChoices || {},
    players,
    cards,
  };
}

function broadcastRoom(roomId) {
  const room = db.getRoom(roomId);
  if (!room) return;
  io.to(roomId).emit('room_state', roomStatePayload(room));
}

function myCardPayload(playerId) {
  const player = db.getPlayer(playerId);
  if (!player || !player.selectedCardId) return null;
  const card = db.getCard(player.selectedCardId);
  if (!card) return null;
  return {
    cardId: card.cardId,
    cardNumber: card.cardNumber,
    numbers: card.numbers,
    markedNumbers: player.markedNumbers,
  };
}

// ---------- socket handlers ----------

io.on('connection', (socket) => {
  // 1) HOST creates a room
  socket.on('create_room', ({ hostName, config = {} }, cb = () => {}) => {
    try {
      const cleanHostName = String(hostName || '').trim();
      if (!cleanHostName) return cb({ ok: false, error: 'กรุณากรอกชื่อ Host ก่อนสร้างห้อง' });
      if (db.getPlayerCount() >= MAX_SERVER_PLAYERS) return cb({ ok: false, error: 'ผู้เล่นทั้ง Server ครบ 80 คนแล้ว กรุณารอจนกว่าจะมีผู้เล่นออก' });
      if (cleanHostName.length > 20) return cb({ ok: false, error: 'ชื่อยาวเกิน 20 ตัวอักษร' });
      const cardCount = [20, 30, 50, 100].includes(config.cardCount) ? config.cardCount : 30;
      const maxPlayers = [10, 15, 20, 30, 40, 50, 60].includes(Number(config.maxPlayers)) ? Number(config.maxPlayers) : 20;
      const numberMin = Number.isFinite(Number(config.numberMin)) ? Number(config.numberMin) : 1;
      const numberMax = Number.isFinite(Number(config.numberMax)) ? Number(config.numberMax) : 75;

      if (!Number.isInteger(numberMin) || !Number.isInteger(numberMax) || numberMin < 1 || numberMax < numberMin || numberMax > 999 || numberMax - numberMin + 1 < 25) {
        return cb({ ok: false, error: 'ช่วงเลขต้องมีอย่างน้อย 25 ค่า' });
      }

      const roomId = nanoid(10);
      let roomCode = generateRoomCode();
      while (db.getRoomByCode(roomCode)) roomCode = generateRoomCode(); // avoid collision

      const room = {
        roomId,
        roomCode,
        hostId: null,
        hostConnected: true,
        cardCount,
        maxPlayers,
        numberMin,
        numberMax,
        gameStatus: 'lobby',
        currentNumber: null,
        calledNumbers: [],
        winners: [],
        playAgainChoices: {},
        createdAt: Date.now(),
      };
      db.createRoom(room);

      const cardGrids = generateCards(cardCount, numberMin, numberMax);
      cardGrids.forEach((numbers, i) => {
        db.createCard({
          cardId: nanoid(8),
          roomId,
          cardNumber: i + 1,
          numbers,
          selectedBy: null,
          status: 'available',
        });
      });

      const hostId = nanoid(8);
      db.createPlayer({
        playerId: hostId,
        roomId,
        playerName: cleanHostName,
        selectedCardId: null,
        markedNumbers: [],
        connected: true,
        socketId: socket.id,
        joinedAt: Date.now(),
      });
      db.updateRoom(roomId, { hostId });

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = hostId;

      cb({ ok: true, roomId, roomCode, playerId: hostId });
      broadcastRoom(roomId);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 2) PLAYER joins a room by code
  socket.on('join_room', ({ roomCode, playerName }, cb = () => {}) => {
    const cleanPlayerName = String(playerName || '').trim();
    if (!cleanPlayerName) return cb({ ok: false, error: 'กรุณากรอกชื่อก่อนเข้าห้อง' });
    if (cleanPlayerName.length > 20) return cb({ ok: false, error: 'ชื่อยาวเกิน 20 ตัวอักษร' });
    const room = db.getRoomByCode((roomCode || '').trim().toUpperCase());
    if (!room) return cb({ ok: false, error: 'ไม่พบห้องนี้ ตรวจสอบ Room Code อีกครั้ง' });

    const existing = db.getPlayersByRoom(room.roomId);
    const activeInRoom = existing.filter((p) => p.connected || p.playerId === room.hostId);
    if (db.getPlayerCount() >= MAX_SERVER_PLAYERS) return cb({ ok: false, error: 'ผู้เล่นทั้ง Server ครบ 80 คนแล้ว กรุณารอจนกว่าจะมีผู้เล่นออก' });
    if (activeInRoom.length >= room.maxPlayers) return cb({ ok: false, error: 'ห้องเต็มแล้ว' });

    const joiningAfterGame = room.gameStatus === 'ended';

    // New players may join a room that is on the post-game results screen.
    // They are automatically treated as new-card players and can choose a card immediately.
    if (room.gameStatus === 'playing') {
      return cb({ ok: false, error: 'เกมกำลังเล่นอยู่ ไม่สามารถเข้าร่วมกลางเกมได้' });
    }
    if (room.gameStatus !== 'lobby' && room.gameStatus !== 'ended') {
      return cb({ ok: false, error: 'ไม่สามารถเข้าร่วมห้องนี้ได้ในขณะนี้' });
    }

    const playerId = nanoid(8);
    db.createPlayer({
      playerId,
      roomId: room.roomId,
      playerName: cleanPlayerName,
      selectedCardId: null,
      markedNumbers: [],
      connected: true,
      socketId: socket.id,
      joinedAt: Date.now(),
    });

    if (joiningAfterGame) {
      const choices = { ...(room.playAgainChoices || {}), [playerId]: 'new' };
      db.updateRoom(room.roomId, { playAgainChoices: choices });
    }

    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    socket.data.playerId = playerId;

    // Tell the client whether this is a brand-new player joining during the
    // post-game results phase. The client uses this flag immediately instead
    // of waiting for a later broadcast/event before showing card selection.
    cb({
      ok: true,
      roomId: room.roomId,
      roomCode: room.roomCode,
      playerId,
      joiningAfterGame,
    });
    broadcastRoom(room.roomId);
    if (joiningAfterGame) {
      socket.emit('start_new_card_selection');
    }
  });

  // 3) Reconnect (after refresh / dropped connection)
  socket.on('rejoin_room', ({ roomCode, playerId }, cb = () => {}) => {
    const room = db.getRoomByCode((roomCode || '').trim().toUpperCase());
    if (!room) return cb({ ok: false, error: 'ไม่พบห้องนี้' });
    const player = db.getPlayer(playerId);
    if (!player || player.roomId !== room.roomId) {
      return cb({ ok: false, error: 'ไม่พบผู้เล่นคนนี้ในห้อง' });
    }

    clearDisconnectedPlayerTimer(playerId);
    db.updatePlayer(playerId, { connected: true, socketId: socket.id });
    if (playerId === room.hostId) db.updateRoom(room.roomId, { hostConnected: true });

    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    socket.data.playerId = playerId;

    cb({
      ok: true,
      roomId: room.roomId,
      roomCode: room.roomCode,
      playerId,
      isHost: playerId === room.hostId,
      state: roomStatePayload(db.getRoom(room.roomId)),
      myCard: myCardPayload(playerId),
    });
    broadcastRoom(room.roomId);
    if (room.gameStatus === 'ended' && room.playAgainChoices?.[playerId] === 'new' && !db.getPlayer(playerId)?.selectedCardId) {
      socket.emit('start_new_card_selection');
    }
  });

  // Preview a card's numbers before selecting (read-only, no lock taken)
  socket.on('preview_card', ({ cardId }, cb = () => {}) => {
    const { roomId } = socket.data;
    const card = db.getCard(cardId);
    if (!card || card.roomId !== roomId) return cb({ ok: false, error: 'ไม่พบบัตรนี้' });
    cb({
      ok: true,
      card: { cardId: card.cardId, cardNumber: card.cardNumber, numbers: card.numbers, status: card.status },
    });
  });

  // 4) Select a card (server-authoritative lock — also supports choosing a NEW card after game over)
  socket.on('select_card', ({ cardId }, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room) return cb({ ok: false, error: 'ไม่พบห้อง' });

    const player = db.getPlayer(playerId);
    const choosingNewAfterGame = room.gameStatus === 'ended'
      && player
      && player.playerId !== room.hostId
      && room.playAgainChoices
      && room.playAgainChoices[playerId] === 'new';

    if (room.gameStatus !== 'lobby' && !choosingNewAfterGame) {
      return cb({ ok: false, error: 'ไม่สามารถเลือกบัตรได้ในขณะนี้' });
    }

    const card = db.getCard(cardId);
    if (!card || card.roomId !== roomId) return cb({ ok: false, error: 'ไม่พบบัตรนี้' });
    if (card.status === 'selected' && card.selectedBy !== playerId) {
      return cb({ ok: false, error: `❌ บัตร #${padCard(card.cardNumber)} ถูกผู้เล่นอื่นเลือกไปแล้ว` });
    }

    if (player.selectedCardId && player.selectedCardId !== cardId) {
      const prev = db.getCard(player.selectedCardId);
      if (prev) db.updateCard(prev.cardId, { status: 'available', selectedBy: null });
    }

    db.updateCard(cardId, { status: 'selected', selectedBy: playerId });
    db.updatePlayer(playerId, { selectedCardId: cardId });

    if (choosingNewAfterGame) {
      const latest = getPlayAgainStatus(roomId);
      io.to(roomId).emit('play_again_progress', {
        chosen: latest.chosen,
        total: latest.total,
        allChosen: latest.allChosen,
        allReady: latest.allReady,
      });
    }

    cb({ ok: true, card: { cardId: card.cardId, cardNumber: card.cardNumber, numbers: card.numbers }, choosingNewAfterGame });

    // While choosing a new card after a game, keep the room in the results
    // state and broadcast the latest card selection so the Host can see
    // everyone’s readiness. The Host will explicitly start the next round.
    broadcastRoom(roomId);
  });

  // 5) Release currently selected card (only allowed before game starts)
  socket.on('change_card', (_payload, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.gameStatus !== 'lobby') {
      return cb({ ok: false, error: 'ไม่สามารถเปลี่ยนบัตรได้หลังเริ่มเกม' });
    }
    const player = db.getPlayer(playerId);
    clearDisconnectedPlayerTimer(playerId);
    if (player && player.selectedCardId) {
      db.updateCard(player.selectedCardId, { status: 'available', selectedBy: null });
      db.updatePlayer(playerId, { selectedCardId: null });
    }
    cb({ ok: true });
    broadcastRoom(roomId);
  });

  // 6) Host starts the game — locks all cards
  socket.on('start_game', (_payload, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.hostId !== playerId) return cb({ ok: false, error: 'เฉพาะ Host เท่านั้นที่เริ่มเกมได้' });
    if (room.gameStatus !== 'lobby') return cb({ ok: false, error: 'เกมเริ่มไปแล้ว' });

    const players = db.getPlayersByRoom(roomId).filter((p) => p.playerId !== room.hostId);
    if (players.length === 0) return cb({ ok: false, error: 'ต้องมีผู้เล่นอย่างน้อย 1 คนก่อนเริ่มเกม' });
    const notReady = players.filter((p) => !p.selectedCardId);
    if (notReady.length > 0) {
      return cb({ ok: false, error: `ยังมีผู้เล่น ${notReady.length} คนที่ยังไม่ได้เลือกบัตร` });
    }

    db.updateRoom(roomId, { gameStatus: 'playing', currentNumber: null, calledNumbers: [], winners: [], playAgainChoices: {} });
    io.to(roomId).emit('game_started');
    broadcastRoom(roomId);
    cb({ ok: true });
  });

  // 7) Host draws a number — no repeats
  socket.on('draw_number', (_payload, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.hostId !== playerId) return cb({ ok: false, error: 'เฉพาะ Host เท่านั้นที่สุ่มเลขได้' });
    if (room.gameStatus !== 'playing') return cb({ ok: false, error: 'เกมยังไม่เริ่ม' });

    const total = room.numberMax - room.numberMin + 1;
    if (room.calledNumbers.length >= total) return cb({ ok: false, error: 'สุ่มเลขครบทุกตัวแล้ว' });

    let num;
    do {
      num = Math.floor(Math.random() * total) + room.numberMin;
    } while (room.calledNumbers.includes(num));

    const calledNumbers = [...room.calledNumbers, num];
    db.updateRoom(roomId, { currentNumber: num, calledNumbers });

    io.to(roomId).emit('number_drawn', {
      number: num,
      calledNumbers,
      remaining: total - calledNumbers.length,
    });
    broadcastRoom(roomId);
    cb({ ok: true, number: num });
  });

  // 8) Player marks a number on their own card — validated server-side
  socket.on('mark_number', ({ number }, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    const player = db.getPlayer(playerId);
    if (!room || !player) return cb({ ok: false, error: 'ไม่พบผู้เล่นหรือห้อง' });
    if (room.gameStatus !== 'playing') return cb({ ok: false, error: 'เกมยังไม่เริ่ม' });
    if (!room.calledNumbers.includes(number)) {
      return cb({ ok: false, error: 'เลขนี้ยังไม่ถูกสุ่มออกมา' });
    }

    const card = db.getCard(player.selectedCardId);
    if (!card) return cb({ ok: false, error: 'ไม่พบบัตรของคุณ' });
    if (!card.numbers.flat().includes(number)) {
      return cb({ ok: false, error: 'เลขนี้ไม่มีอยู่ในบัตรของคุณ' });
    }
    if (player.markedNumbers.includes(number)) {
      return cb({ ok: true, alreadyMarked: true, markedNumbers: player.markedNumbers });
    }

    const markedNumbers = [...player.markedNumbers, number];
    db.updatePlayer(playerId, { markedNumbers });

    let bingoInfo = null;
    const result = checkBingo(card.numbers, markedNumbers);
    if (result.isBingo && !room.winners.some((w) => w.playerId === playerId)) {
      bingoInfo = {
        playerId,
        playerName: player.playerName,
        cardNumber: card.cardNumber,
        winningNumber: number,
        pattern: result.pattern,
        time: Date.now(),
      };
      db.updateRoom(roomId, { winners: [...room.winners, bingoInfo] });
      io.to(roomId).emit('bingo', bingoInfo);
    }

    cb({ ok: true, markedNumbers, bingo: !!bingoInfo });
    broadcastRoom(roomId);
  });

  // 9) Host ends the game
  socket.on('end_game', (_payload, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.hostId !== playerId) return cb({ ok: false, error: 'เฉพาะ Host เท่านั้น' });

    db.updateRoom(roomId, { gameStatus: 'ended' });
    io.to(roomId).emit('game_ended', { winners: room.winners });
    broadcastRoom(roomId);
    // Disconnected players get a 60-second reconnect grace. Connected players
    // continue into the normal play-again flow.
    cleanupDisconnectedPlayersAtGameEnd(roomId);
    cb({ ok: true });
  });

  // Host removes a player from the lobby before the game starts.
  socket.on('kick_player', ({ targetPlayerId }, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.hostId !== playerId) return cb({ ok: false, error: 'เฉพาะ Host เท่านั้นที่เตะผู้เล่นได้' });
    if (!['lobby', 'ended'].includes(room.gameStatus)) return cb({ ok: false, error: 'เตะผู้เล่นได้เฉพาะตอน Lobby หรือช่วงรอรอบใหม่' });
    if (!targetPlayerId || targetPlayerId === room.hostId) return cb({ ok: false, error: 'ไม่สามารถเตะ Host ได้' });
    const target = db.getPlayer(targetPlayerId);
    if (!target || target.roomId !== roomId) return cb({ ok: false, error: 'ไม่พบผู้เล่นคนนี้ในห้อง' });
    clearDisconnectedPlayerTimer(targetPlayerId);
    releasePlayerCard(target);
    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
    if (targetSocket) {
      targetSocket.emit('kicked', { message: 'Host นำคุณออกจากห้องแล้ว' });
      targetSocket.leave(roomId);
      targetSocket.data.roomId = null;
      targetSocket.data.playerId = null;
    }
    db.deletePlayer(targetPlayerId);
    if (room.gameStatus === 'ended') {
      const choices = { ...(room.playAgainChoices || {}) };
      delete choices[targetPlayerId];
      db.updateRoom(roomId, { playAgainChoices: choices });
      if (!maybeResetRoomAfterEveryoneLeaves(roomId)) broadcastRoom(roomId);
    } else {
      broadcastRoom(roomId);
    }
    cb({ ok: true, playerId: targetPlayerId });
  });

  // Leave room: player releases their card; Host closes the entire room.
  socket.on('leave_room', (_payload, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room) return cb({ ok: false, error: 'ไม่พบห้อง' });

    if (playerId === room.hostId) {
      io.to(roomId).emit('room_closed', { message: 'Host ออกจากห้อง ห้องนี้ถูกปิดแล้ว' });
      db.deleteRoom(roomId);
      socket.leave(roomId);
      socket.data.roomId = null;
      socket.data.playerId = null;
      return cb({ ok: true, closed: true });
    }

    const player = db.getPlayer(playerId);
    clearDisconnectedPlayerTimer(playerId);
    if (player && player.selectedCardId) {
      db.updateCard(player.selectedCardId, { status: 'available', selectedBy: null });
    }
    db.deletePlayer(playerId);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.playerId = null;

    if (room.gameStatus === 'ended') {
      const choices = { ...(room.playAgainChoices || {}) };
      delete choices[playerId];
      db.updateRoom(roomId, { playAgainChoices: choices });
      if (!maybeResetRoomAfterEveryoneLeaves(roomId)) broadcastRoom(roomId);
    } else {
      broadcastRoom(roomId);
    }
    cb({ ok: true });
  });

  // 10) After a game, each player chooses reuse/new.
  // The room stays on the results screen until the Host explicitly starts
  // the next round. A player choosing "new" can select a replacement card
  // immediately while the game is still in the "ended" state.
  function getPlayAgainStatus(roomId) {
    const room = db.getRoom(roomId);
    if (!room || room.gameStatus !== 'ended') {
      return { ok: false, chosen: 0, total: 0, allChosen: false, allReady: false };
    }
    const players = db.getPlayersByRoom(roomId).filter((p) => p.playerId !== room.hostId && p.connected);
    const choices = room.playAgainChoices || {};
    const chosen = players.filter((p) => choices[p.playerId] === 'new' || choices[p.playerId] === 'reuse').length;
    const allChosen = players.length > 0 && chosen === players.length;
    const allReady = allChosen && players.every((p) => !!p.selectedCardId);
    return { ok: true, chosen, total: players.length, allChosen, allReady };
  }

  socket.on('play_again_choice', ({ choice }, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room) return cb({ ok: false, error: 'ไม่พบห้อง' });
    if (room.gameStatus !== 'ended') return cb({ ok: false, error: 'ยังไม่อยู่ในช่วงเลือกบัตรรอบใหม่' });
    if (playerId === room.hostId) return cb({ ok: false, error: 'Host ไม่ต้องเลือกบัตร' });
    if (!['new', 'reuse'].includes(choice)) return cb({ ok: false, error: 'ตัวเลือกไม่ถูกต้อง' });

    const player = db.getPlayer(playerId);
    if (!player || player.roomId !== roomId) return cb({ ok: false, error: 'ไม่พบผู้เล่นในห้อง' });

    // A player who just joined after the previous game has no old card to reuse.
    if (choice === 'reuse' && !player.selectedCardId) {
      return cb({ ok: false, error: 'ผู้เล่นใหม่ต้องเลือกรับบัตรใหม่' });
    }

    // Do not allow a player to make a second choice in the same round.
    if ((room.playAgainChoices || {})[playerId]) {
      return cb({ ok: false, error: 'คุณเลือกสำหรับรอบใหม่ไปแล้ว' });
    }

    const choices = { ...(room.playAgainChoices || {}), [playerId]: choice };

    if (choice === 'new') {
      // Release the old card immediately and require a new one.
      if (player.selectedCardId) {
        db.updateCard(player.selectedCardId, { status: 'available', selectedBy: null });
      }
      db.updatePlayer(playerId, { selectedCardId: null, markedNumbers: [] });
    } else {
      // Keep the old card and clear its marks for the next round.
      db.updatePlayer(playerId, { markedNumbers: [] });
      if (player.selectedCardId) {
        db.updateCard(player.selectedCardId, { status: 'selected', selectedBy: playerId });
      }
    }

    db.updateRoom(roomId, { playAgainChoices: choices });

    const status = getPlayAgainStatus(roomId);
    cb({
      ok: true,
      choice,
      allChosen: status.allChosen,
      allReady: status.allReady,
      needsCardSelection: choice === 'new',
    });

    if (choice === 'new') {
      socket.emit('start_new_card_selection');
    }

    io.to(roomId).emit('play_again_progress', {
      chosen: status.chosen,
      total: status.total,
      allChosen: status.allChosen,
      allReady: status.allReady,
    });
    broadcastRoom(roomId);
  });

  // Host can manually open the same Room Code for a brand-new group once
  // all old non-host players have left. This prevents the Host from being
  // stuck on the results screen waiting forever.
  socket.on('host_reset_room', (_payload, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.hostId !== playerId) {
      return cb({ ok: false, error: 'เฉพาะ Host เท่านั้น' });
    }
    if (room.gameStatus !== 'ended') {
      return cb({ ok: false, error: 'ห้องไม่ได้อยู่ในช่วงจบเกม' });
    }

    const onlineNonHosts = db.getPlayersByRoom(roomId)
      .filter((p) => p.playerId !== room.hostId && p.connected);
    if (onlineNonHosts.length > 0) {
      return cb({ ok: false, error: `ยังมีผู้เล่นเก่าอยู่ในห้อง ${onlineNonHosts.length} คน` });
    }

    resetRoomToLobby(roomId);
    cb({ ok: true });
  });

  // Host explicitly starts the next round once every player has chosen
  // reuse/new and every player has a valid selected card.
  socket.on('start_next_round', (_payload, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.hostId !== playerId) {
      return cb({ ok: false, error: 'เฉพาะ Host เท่านั้นที่เริ่มรอบใหม่ได้' });
    }
    const status = getPlayAgainStatus(roomId);
    if (!status.allChosen) {
      return cb({ ok: false, error: `ยังมีผู้เล่นที่ยังไม่ได้เลือกว่าจะใช้บัตรเดิมหรือรับบัตรใหม่ (${status.chosen}/${status.total})` });
    }
    if (!status.allReady) {
      return cb({ ok: false, error: 'ยังมีผู้เล่นที่ยังไม่ได้เลือกบัตรใหม่' });
    }

    const players = db.getPlayersByRoom(roomId).filter((p) => p.playerId !== room.hostId && p.connected);
    const choices = room.playAgainChoices || {};

    // Keep every selected card locked and clear marks before the new round.
    players.forEach((p) => {
      db.updatePlayer(p.playerId, { markedNumbers: [] });
      if (p.selectedCardId) {
        db.updateCard(p.selectedCardId, { status: 'selected', selectedBy: p.playerId });
      }
    });

    // Any card not selected by a player is available for future selection.
    const kept = new Set(players.map((p) => p.selectedCardId).filter(Boolean));
    db.getCardsByRoom(roomId).forEach((c) => {
      if (!kept.has(c.cardId)) db.updateCard(c.cardId, { status: 'available', selectedBy: null });
    });

    db.updateRoom(roomId, {
      gameStatus: 'playing',
      currentNumber: null,
      calledNumbers: [],
      winners: [],
      playAgainChoices: {},
    });

    io.to(roomId).emit('game_started');
    broadcastRoom(roomId);
    cb({ ok: true });
  });

  // Fetch my own card explicitly (used right after reconnect / card select)
  socket.on('get_my_card', (_payload, cb = () => {}) => {
    const { playerId } = socket.data;
    cb({ ok: true, myCard: myCardPayload(playerId) });
  });

  socket.on('disconnect', () => {
    const { roomId, playerId } = socket.data;
    if (!roomId || !playerId) return;
    const room = db.getRoom(roomId);
    if (!room) return;

    db.updatePlayer(playerId, { connected: false });
    if (playerId === room.hostId) {
      db.updateRoom(roomId, { hostConnected: false });
      io.to(roomId).emit('host_disconnected');
    } else if (room.gameStatus === 'ended') {
      // Keep a short reconnect grace, then permanently remove the old session.
      scheduleDisconnectedPlayerCleanup(playerId);
    }
    broadcastRoom(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`🎱 Bingo Online server running at http://localhost:${PORT}`);
});
