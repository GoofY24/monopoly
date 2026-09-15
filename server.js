const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};
const PALETTE = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];

io.on('connection', (socket) => {

  // 1. ოთახის შექმნა ან შეერთება
  socket.on('join_lobby', ({ roomId, username, color }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        gameStarted: false,
        currentTurnIndex: 0,
        state: null
      };
    }

    const room = rooms[roomId];

    const existingPlayer = room.players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      const usedColors = room.players.map(p => p.color);
      let chosen = color;
      if (!chosen || usedColors.includes(chosen)) {
        chosen = PALETTE.find(c => !usedColors.includes(c)) || '#64748b';
      }
      room.players.push({
        id: socket.id,
        username: username || `Player_${socket.id.substring(0, 4)}`,
        color: chosen,
        isHost: room.players.length === 0
      });
    }

    const safePlayers = room.players.map(p => ({
      id: p.id, username: p.username, color: p.color, isHost: p.isHost
    }));

    io.to(roomId).emit('update_lobby', safePlayers);

    // აუტო-სტარტი 2 მოთამაშეზე
    if (room.players.length === 2 && !room.gameStarted) {
      room.gameStarted = true;
      room.currentTurnIndex = 0;

      room.players.forEach((p, idx) => {
        io.to(p.id).emit('game_started', {
          players: room.players.map(x => ({
            id: x.id, username: x.username, color: x.color
          })),
          myIndex: idx,
          currentTurnIndex: room.currentTurnIndex
        });
      });
    }
  });

  // 2. ხელით დაწყება (სარეზერვო)
  socket.on('start_game', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error_message', 'თამაშის დაწყება მხოლოდ ჰოსტს შეუძლია!');
      return;
    }
    if (room.players.length < 2) {
      socket.emit('error_message', 'თამაშის დასაწყებად საჭიროა მინიმუმ 2 მოთამაშე!');
      return;
    }

    room.gameStarted = true;
    room.currentTurnIndex = 0;

    room.players.forEach((p, idx) => {
      io.to(p.id).emit('game_started', {
        players: room.players.map(x => ({
          id: x.id, username: x.username, color: x.color
        })),
        myIndex: idx,
        currentTurnIndex: room.currentTurnIndex
      });
    });
  });

  // 3. STATE RELAY - მთავარი სინქრონიზაცია
  socket.on('game_sync', ({ roomId, state }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    room.state = state;
    socket.to(roomId).emit('game_sync', { state });
  });

  // 4. კამათლის ანიმაციის სინქრონიზაცია
  socket.on('dice_roll', ({ roomId, d1, d2 }) => {
    socket.to(roomId).emit('dice_roll', { d1, d2 });
  });

  // 5. სვლის დასრულება
  socket.on('end_turn', (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    if (socket.id === room.players[room.currentTurnIndex].id) {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      io.to(roomId).emit('turn_changed', {
        currentTurn: room.players[room.currentTurnIndex].id
      });
    }
  });

  // 6. კავშირის გაწყვეტა
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      const room = rooms[roomId];
      if (!room) continue;

      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex === -1) continue;

      if (!room.gameStarted) {
        room.players.splice(playerIndex, 1);
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          room.players[0].isHost = true;
          io.to(roomId).emit('update_lobby', room.players.map(p => ({
            id: p.id, username: p.username, color: p.color, isHost: p.isHost
          })));
        }
        continue;
      }

      const isCurrentTurnPlayer = (room.currentTurnIndex === playerIndex);
      room.players.splice(playerIndex, 1);

      if (room.players.length === 0) {
        delete rooms[roomId];
        continue;
      }

      if (room.players.length === 1) {
        io.to(roomId).emit('game_over', {
          winner: room.players[0],
          reason: 'all_opponents_disconnected'
        });
        delete rooms[roomId];
        continue;
      }

      if (playerIndex < room.currentTurnIndex) room.currentTurnIndex--;
      if (room.currentTurnIndex >= room.players.length) room.currentTurnIndex = 0;

      if (isCurrentTurnPlayer) {
        io.to(roomId).emit('turn_changed', {
          currentTurn: room.players[room.currentTurnIndex].id
        });
      }

      io.to(roomId).emit('player_left', {
        players: room.players.map(p => ({
          id: p.id, username: p.username, color: p.color
        })),
        disconnectedId: socket.id
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
