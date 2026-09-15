const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const rooms = {};
const PALETTE = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];
const GAME_DURATION = 20 * 60;
const GRACE_PERIOD = 90 * 1000; // 90 წამი დაბრუნებისთვის

function safePlayers(room) {
  return room.players.map(p => ({
    id: p.id,
    username: p.username,
    color: p.color,
    isHost: p.isHost,
    connected: p.connected !== false
  }));
}

function connectedCount(room) {
  return room.players.filter(p => p.connected !== false).length;
}

function stopRoomTimer(room) {
  if (room && room.timerHandle) {
    clearInterval(room.timerHandle);
    room.timerHandle = null;
  }
}

function startRoomTimer(roomId, room) {
  stopRoomTimer(room);
  io.to(roomId).emit('timer_tick', { timeLeft: room.timeLeft });
  room.timerHandle = setInterval(() => {
    const r = rooms[roomId];
    if (!r) { return; }
    r.timeLeft--;
    io.to(roomId).emit('timer_tick', { timeLeft: r.timeLeft });
    if (r.timeLeft <= 0) {
      stopRoomTimer(r);
      io.to(roomId).emit('time_up', {});
    }
  }, 1000);
}

io.on('connection', (socket) => {

  /* ============ JOIN LOBBY ============ */
  socket.on('join_lobby', ({ roomId, username, color }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        gameStarted: false,
        currentTurnIndex: 0,
        state: null,
        timeLeft: GAME_DURATION,
        timerHandle: null
      };
    }

    const room = rooms[roomId];
    const existingPlayer = room.players.find(p => p.id === socket.id && p.connected !== false);

    if (!existingPlayer) {
      if (room.gameStarted && connectedCount(room) >= 2) {
        socket.emit('error_message', 'ოთახი სავსეა');
        return;
      }

      const usedColors = room.players.filter(p => p.connected !== false).map(p => p.color);
      let chosen = color;
      if (!chosen || usedColors.includes(chosen)) {
        chosen = PALETTE.find(c => !usedColors.includes(c)) || '#64748b';
      }

      const token = crypto.randomBytes(16).toString('hex');
      room.players.push({
        id: socket.id,
        token,
        username: username || `Player_${socket.id.substring(0, 4)}`,
        color: chosen,
        isHost: room.players.length === 0,
        connected: true,
        disconnectTimer: null
      });

      socket.data.roomId = roomId;
      socket.data.token = token;
      socket.emit('welcome', { token, roomId });
    }

    io.to(roomId).emit('update_lobby', safePlayers(room));

    if (connectedCount(room) === 2 && !room.gameStarted) {
      room.gameStarted = true;
      room.currentTurnIndex = 0;
      room.timeLeft = GAME_DURATION;

      const orderedPlayers = room.players.map(x => ({
        id: x.id, username: x.username, color: x.color
      }));

      room.players.forEach((p, idx) => {
        io.to(p.id).emit('game_started', {
          players: orderedPlayers,
          myIndex: idx,
          currentTurnIndex: room.currentTurnIndex,
          timeLeft: GAME_DURATION
        });
      });

      startRoomTimer(roomId, room);
    }
  });

  /* ============ REJOIN (refresh / reconnect) ============ */
  socket.on('rejoin', ({ roomId, token }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('rejoin_failed', { reason: 'no_room' }); return; }

    const idx = room.players.findIndex(p => p.token === token);
    if (idx === -1) { socket.emit('rejoin_failed', { reason: 'no_player' }); return; }

    const player = room.players[idx];
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.id = socket.id;
    player.connected = true;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.token = token;

    socket.emit('rejoin_success', {
      roomId,
      myIndex: idx,
      gameStarted: room.gameStarted,
      players: room.players.map(p => ({
        id: p.id, username: p.username, color: p.color
      })),
      state: room.state,
      timeLeft: room.timeLeft,
      currentTurnIndex: room.currentTurnIndex
    });

    socket.to(roomId).emit('opponent_reconnected', {
      username: player.username,
      players: safePlayers(room)
    });

    if (room.gameStarted && connectedCount(room) >= 2 && room.timeLeft > 0) {
      startRoomTimer(roomId, room);
    }

    io.to(roomId).emit('update_lobby', safePlayers(room));
  });

  /* ============ STATE SYNC ============ */
  socket.on('game_sync', ({ roomId, state }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    room.state = state;
    socket.to(roomId).emit('game_sync', { state });
    if (state && state.gameOver) {
      stopRoomTimer(room);
    }
  });

  socket.on('dice_roll', ({ roomId, d1, d2 }) => {
    socket.to(roomId).emit('dice_roll', { d1, d2 });
  });

  socket.on('end_turn', (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    const cur = room.players[room.currentTurnIndex];
    if (!cur) return;
    if (socket.id === cur.id) {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      io.to(roomId).emit('turn_changed', {
        currentTurn: room.players[room.currentTurnIndex].id
      });
    }
  });

  /* ============ DISCONNECT ============ */
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = rooms[roomId];
      if (!room) continue;

      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex === -1) continue;
      const player = room.players[playerIndex];

      // Lobby — წაშალე დაუყოვნებლივ
      if (!room.gameStarted) {
        room.players.splice(playerIndex, 1);
        if (room.players.length === 0) {
          stopRoomTimer(room);
          delete rooms[roomId];
        } else {
          room.players[0].isHost = true;
          io.to(roomId).emit('update_lobby', safePlayers(room));
        }
        continue;
      }

      // თამაში მიმდინარეობს — არ ვშლით, ვნიშნავთ როგორც გათიშულს
      player.connected = false;
      player.id = null;

      io.to(roomId).emit('opponent_disconnected', {
        username: player.username,
        players: safePlayers(room)
      });

      // ტაიმერის შეჩერება
      stopRoomTimer(room);

      player.disconnectTimer = setTimeout(() => {
        const r = rooms[roomId];
        if (!r) return;
        const i = r.players.findIndex(p => p.token === player.token);
        if (i === -1) return;
        if (r.players[i].connected) return;

        // Grace პერიოდი ამოიწურა
        r.players.splice(i, 1);
        stopRoomTimer(r);

        if (r.players.length === 0) {
          delete rooms[roomId];
          return;
        }

        if (r.players.length === 1) {
          io.to(roomId).emit('game_over', {
            winner: { username: r.players[0].username },
            reason: 'all_opponents_disconnected'
          });
          delete rooms[roomId];
        }
      }, GRACE_PERIOD);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
