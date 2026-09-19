# Bingo Online

Version based on v11 with one additional room-lifecycle fix:

- After a game ends, if every non-host player disconnects from the browser, the server waits 15 seconds for reconnects.
- If nobody reconnects during the grace period, old non-host player records are removed, their cards are released, and the **same room** is reset to `lobby`.
- The Host remains in the same room and can accept a new group of players using the same Room Code.
- Existing "reuse card / new card" flow for players who remain in the room is unchanged.
- Existing 60 players per room / 80 players server-wide limits are unchanged.
