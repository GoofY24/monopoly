const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// index.html-ის და სხვა სტატიკური ფაილების მიწოდება
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io ლოგიკა
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // ოთახის შექმნა
  socket.on('createRoom', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} created room: ${roomId}`);
    socket.emit('roomCreated', roomId);
  });

  // ოთახში შეერთება
  socket.on('joinRoom', (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size < 4) { // მაქსიმუმ 4 მოთამაშე
      socket.join(roomId);
      console.log(`User ${socket.id} joined room: ${roomId}`);
      io.to(roomId).emit('playerJoined', { playerId: socket.id, roomSize: room.size });
    } else {
      socket.emit('errorMsg', 'ოთახი ვერ მოიძებნა ან სავსეა!');
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
