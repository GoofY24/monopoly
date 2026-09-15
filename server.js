const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 1. Static ფაილების მიწოდება Render-ისთვის (public საქაღალდე)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ოთახების მდგომარეობა
const rooms = {};

io.on('connection', (socket) => {
  
  // 1. ოთახის შექმნა ან შეერთება ლობიში
  socket.on('join_lobby', ({ roomId, username }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        gameStarted: false,
        currentTurnIndex: 0
      };
    }

    // მოთამაშის დამატება ლობიში
    const existingPlayer = rooms[roomId].players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      rooms[roomId].players.push({
        id: socket.id,
        username: username || `Player_${socket.id.substring(0, 4)}`,
        isHost: rooms[roomId].players.length === 0 // პირველი შემოსული არის ჰოსტი
      });
    }

    // ლობის ყველა წევრს ვუგზავნით განახლებულ სიას
    io.to(roomId).emit('update_lobby', rooms[roomId].players);
  });

  // 2. თამაშის დაწყება (მხოლოდ ჰოსტს შეუძლია)
  socket.on('start_game', (roomId) => {
    const room = rooms[roomId];

    if (room && !room.gameStarted) {
      room.gameStarted = true;
      room.currentTurnIndex = 0; // იწყებს პირველი მოთამაშე

      // ვაგზავნით სიგნალს თამაშის დაწყებაზე + საწყის სვლას
      io.to(roomId).emit('game_started', {
        players: room.players,
        currentTurn: room.players[room.currentTurnIndex].id
      });
    }
  });

  // 3. სვლის დასრულება/გადაცემა
  socket.on('end_turn', (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    // ვამოწმებთ, ნამდვილად იმ მოთამაშემ გამოგზავნა თუ არა, ვისი სვლაც იყო
    if (socket.id === room.players[room.currentTurnIndex].id) {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

      io.to(roomId).emit('turn_changed', {
        currentTurn: room.players[room.currentTurnIndex].id
      });
    }
  });

  // 4. კავშირის გაწყვეტა (Disconnect)
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      const room = rooms[roomId];
      if (!room) continue;

      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex === -1) continue;

      // ა) თუ თამაში ლობიშია
      if (!room.gameStarted) {
        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          // თუ ჰოსტი გავიდოდა, ახალ ჰოსტად ვნიშნავთ პირველს
          room.players[0].isHost = true;
          io.to(roomId).emit('update_lobby', room.players);
        }
        continue;
      }

      // ბ) თუ თამაში მიმდინარეობს
      const isCurrentTurnPlayer = (room.currentTurnIndex === playerIndex);
      room.players.splice(playerIndex, 1);

      if (room.players.length === 0) {
        delete rooms[roomId];
        continue;
      }

      // თუ მხოლოდ 1 მოთამაშე დარჩა — თამაში სრულდება
      if (room.players.length === 1) {
        io.to(roomId).emit('game_over', {
          winner: room.players[0],
          reason: 'all_opponents_disconnected'
        });
        delete rooms[roomId];
        continue;
      }

      // ინდექსის გასწორება
      if (playerIndex < room.currentTurnIndex) {
        room.currentTurnIndex--;
      }
      if (room.currentTurnIndex >= room.players.length) {
        room.currentTurnIndex = 0;
      }

      // თუ იმის სვლა იყო ვინც გავარდა, რიგი გადადის შემდეგზე
      if (isCurrentTurnPlayer) {
        io.to(roomId).emit('turn_changed', {
          currentTurn: room.players[room.currentTurnIndex].id
        });
      }

      io.to(roomId).emit('player_left', {
        players: room.players,
        disconnectedId: socket.id
      });
    }
  });

});

// Render იყენებს process.env.PORT-ს
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
