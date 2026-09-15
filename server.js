// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
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
        gameStarted: false
      };
    }

    // მოთამაშის დამატება ლობიში
    const existingPlayer = rooms[roomId].players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      rooms[roomId].players.push({
        id: socket.id,
        username: username,
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

      // ვაგზავნით სიგნალს თამაშის დაწყებაზე + გადავცემთ მოთამაშეების სრულ სიას
      io.to(roomId).emit('game_started', {
        players: room.players
      });
    }
  });

  // 3. კავშირის გაწყვეტა (Disconnect)
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (rooms[roomId]) {
        // ამოვიღოთ მოთამაშე ლობიდან
        rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);

        if (rooms[roomId].players.length === 0) {
          delete rooms[roomId]; // თუ ოთახი ცარიელია, ვშლით
        } else {
          // განვაახლოთ დარჩენილი მოთამაშეების სია
          io.to(roomId).emit('update_lobby', rooms[roomId].players);
        }
      }
    }
  });

});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
