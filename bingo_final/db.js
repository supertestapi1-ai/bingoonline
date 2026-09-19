/**
 * In-memory data store.
 * Field names match the schema in the spec exactly:
 *   rooms:   roomId, roomCode, hostId, maxPlayers, cardCount,
 *            numberMin, numberMax, gameStatus, currentNumber,
 *            calledNumbers, createdAt, hostConnected, winners
 *   players: playerId, roomId, playerName, selectedCardId,
 *            markedNumbers, connected, joinedAt, socketId
 *   cards:   cardId, roomId, cardNumber, numbers, selectedBy, status
 *
 * To move to a real database (Postgres / Firebase / Supabase), replace
 * the bodies of these functions with calls to that database — nothing
 * in server.js needs to change, since it only talks to this module.
 */

const rooms = new Map();          // roomId -> room
const roomsByCode = new Map();    // roomCode -> roomId
const players = new Map();        // playerId -> player
const cardsByRoom = new Map();    // roomId -> Map(cardId -> card)

module.exports = {
  // ---- rooms ----
  createRoom(room) {
    rooms.set(room.roomId, room);
    roomsByCode.set(room.roomCode, room.roomId);
    cardsByRoom.set(room.roomId, new Map());
    return room;
  },
  getRoom(roomId) {
    return rooms.get(roomId) || null;
  },
  getRoomByCode(code) {
    const id = roomsByCode.get(code);
    return id ? rooms.get(id) || null : null;
  },
  updateRoom(roomId, patch) {
    const r = rooms.get(roomId);
    if (r) Object.assign(r, patch);
    return r || null;
  },
  deleteRoom(roomId) {
    const room = rooms.get(roomId);
    if (room) roomsByCode.delete(room.roomCode);
    rooms.delete(roomId);
    cardsByRoom.delete(roomId);
    for (const [pid, p] of players) if (p.roomId === roomId) players.delete(pid);
  },

  // ---- players ----
  createPlayer(p) {
    players.set(p.playerId, p);
    return p;
  },
  getPlayer(playerId) {
    return players.get(playerId) || null;
  },
  deletePlayer(playerId) {
    return players.delete(playerId);
  },
  updatePlayer(playerId, patch) {
    const p = players.get(playerId);
    if (p) Object.assign(p, patch);
    return p || null;
  },
  getPlayersByRoom(roomId) {
    return [...players.values()].filter((p) => p.roomId === roomId);
  },
  getAllPlayers() {
    return [...players.values()];
  },

  // ---- cards ----
  createCard(c) {
    cardsByRoom.get(c.roomId).set(c.cardId, c);
    return c;
  },
  getCard(cardId) {
    for (const m of cardsByRoom.values()) {
      if (m.has(cardId)) return m.get(cardId);
    }
    return null;
  },
  updateCard(cardId, patch) {
    const c = this.getCard(cardId);
    if (c) Object.assign(c, patch);
    return c || null;
  },
  getCardsByRoom(roomId) {
    const m = cardsByRoom.get(roomId);
    return m ? [...m.values()] : [];
  },
};
