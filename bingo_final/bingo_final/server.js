require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const db = require('./db');
const { generateCards, checkBingo, generateRoomCode } = require('./gameLogic');

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
      if (cleanHostName.length > 20) return cb({ ok: false, error: 'ชื่อยาวเกิน 20 ตัวอักษร' });
      const cardCount = [20, 30, 50, 100].includes(config.cardCount) ? config.cardCount : 30;
      const maxPlayers = [10, 15, 20].includes(config.maxPlayers) ? config.maxPlayers : 20;
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
    if (existing.length >= room.maxPlayers) return cb({ ok: false, error: 'ห้องเต็มแล้ว' });
    if (room.gameStatus !== 'lobby') return cb({ ok: false, error: 'เกมเริ่มไปแล้ว ไม่สามารถเข้าร่วมได้' });

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

    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    socket.data.playerId = playerId;

    cb({ ok: true, roomId: room.roomId, roomCode: room.roomCode, playerId });
    broadcastRoom(room.roomId);
  });

  // 3) Reconnect (after refresh / dropped connection)
  socket.on('rejoin_room', ({ roomCode, playerId }, cb = () => {}) => {
    const room = db.getRoomByCode((roomCode || '').trim().toUpperCase());
    if (!room) return cb({ ok: false, error: 'ไม่พบห้องนี้' });
    const player = db.getPlayer(playerId);
    if (!player || player.roomId !== room.roomId) {
      return cb({ ok: false, error: 'ไม่พบผู้เล่นคนนี้ในห้อง' });
    }

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

  // 4) Select a card (server-authoritative lock — prevents double-selection races)
  socket.on('select_card', ({ cardId }, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.gameStatus !== 'lobby') {
      return cb({ ok: false, error: 'ไม่สามารถเลือกบัตรได้ในขณะนี้' });
    }
    const card = db.getCard(cardId);
    if (!card || card.roomId !== roomId) return cb({ ok: false, error: 'ไม่พบบัตรนี้' });
    if (card.status === 'selected') {
      return cb({ ok: false, error: `❌ บัตร #${padCard(card.cardNumber)} ถูกผู้เล่นอื่นเลือกไปแล้ว` });
    }

    const player = db.getPlayer(playerId);
    if (player.selectedCardId) {
      const prev = db.getCard(player.selectedCardId);
      if (prev) db.updateCard(prev.cardId, { status: 'available', selectedBy: null });
    }

    db.updateCard(cardId, { status: 'selected', selectedBy: playerId });
    db.updatePlayer(playerId, { selectedCardId: cardId });

    cb({ ok: true, card: { cardId: card.cardId, cardNumber: card.cardNumber, numbers: card.numbers } });
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
    cb({ ok: true });
  });

  // Host removes a player from the lobby before the game starts.
  socket.on('kick_player', ({ targetPlayerId }, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room || room.hostId !== playerId) return cb({ ok: false, error: 'เฉพาะ Host เท่านั้นที่เตะผู้เล่นได้' });
    if (room.gameStatus !== 'lobby') return cb({ ok: false, error: 'เตะผู้เล่นได้เฉพาะตอนอยู่หน้า Lobby' });
    if (!targetPlayerId || targetPlayerId === room.hostId) return cb({ ok: false, error: 'ไม่สามารถเตะ Host ได้' });
    const target = db.getPlayer(targetPlayerId);
    if (!target || target.roomId !== roomId) return cb({ ok: false, error: 'ไม่พบผู้เล่นคนนี้ในห้อง' });
    if (target.selectedCardId) db.updateCard(target.selectedCardId, { status: 'available', selectedBy: null });
    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
    if (targetSocket) {
      targetSocket.emit('kicked', { message: 'Host นำคุณออกจากห้องแล้ว' });
      targetSocket.leave(roomId);
      targetSocket.data.roomId = null;
      targetSocket.data.playerId = null;
    }
    db.deletePlayer(targetPlayerId);
    cb({ ok: true, playerId: targetPlayerId });
    broadcastRoom(roomId);
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
    if (player && player.selectedCardId) {
      db.updateCard(player.selectedCardId, { status: 'available', selectedBy: null });
    }
    db.deletePlayer(playerId);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.playerId = null;
    broadcastRoom(roomId);
    cb({ ok: true });
  });

  // 10) Each player chooses how they want to continue after a game ends.
  // 'reuse' keeps the current card; 'new' releases it. Once every player has chosen,
  // the room automatically returns to lobby. The Host does not need to choose.
  socket.on('play_again_choice', ({ choice }, cb = () => {}) => {
    const { roomId, playerId } = socket.data;
    const room = db.getRoom(roomId);
    if (!room) return cb({ ok: false, error: 'ไม่พบห้อง' });
    if (room.gameStatus !== 'ended') return cb({ ok: false, error: 'ยังไม่อยู่ในช่วงเลือกบัตรรอบใหม่' });
    if (playerId === room.hostId) return cb({ ok: false, error: 'Host ไม่ต้องเลือกบัตร' });
    if (!['new', 'reuse'].includes(choice)) return cb({ ok: false, error: 'ตัวเลือกไม่ถูกต้อง' });

    const player = db.getPlayer(playerId);
    if (!player || player.roomId !== roomId) return cb({ ok: false, error: 'ไม่พบผู้เล่นในห้อง' });

    const choices = { ...(room.playAgainChoices || {}), [playerId]: choice };
    db.updateRoom(roomId, { playAgainChoices: choices });

    const players = db.getPlayersByRoom(roomId).filter((p) => p.playerId !== room.hostId);
    const allChosen = players.length > 0 && players.every((p) => choices[p.playerId]);

    if (allChosen) {
      const cards = db.getCardsByRoom(roomId);
      for (const p of players) {
        const selected = p.selectedCardId ? db.getCard(p.selectedCardId) : null;
        if (choices[p.playerId] === 'new') {
          if (selected) db.updateCard(selected.cardId, { status: 'available', selectedBy: null });
          db.updatePlayer(p.playerId, { selectedCardId: null, markedNumbers: [] });
        } else {
          if (selected) db.updateCard(selected.cardId, { status: 'selected', selectedBy: p.playerId });
          db.updatePlayer(p.playerId, { markedNumbers: [] });
        }
      }

      // Any card that was not kept by a player becomes available.
      const kept = new Set(players.filter((p) => choices[p.playerId] === 'reuse' && p.selectedCardId).map((p) => p.selectedCardId));
      cards.forEach((c) => {
        if (!kept.has(c.cardId)) db.updateCard(c.cardId, { status: 'available', selectedBy: null });
      });

      db.updateRoom(roomId, { gameStatus: 'lobby', currentNumber: null, calledNumbers: [], winners: [], playAgainChoices: {} });
      io.to(roomId).emit('game_reset', { message: 'ผู้เล่นเลือกการ์ดรอบใหม่ครบแล้ว' });
    } else {
      io.to(roomId).emit('play_again_progress', {
        chosen: players.filter((p) => choices[p.playerId]).length,
        total: players.length,
      });
    }

    cb({ ok: true, choice, allChosen });
    broadcastRoom(roomId);
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
    }
    broadcastRoom(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`🎱 Bingo Online server running at http://localhost:${PORT}`);
});
