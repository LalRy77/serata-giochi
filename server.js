
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let approvedPlayers = new Set();

app.use(express.static(__dirname + '/public'));

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    socket.name = name;
    socket.emit('waiting');
    io.emit('player-join', name);
  });

  socket.on('approve-player', (name) => {
    approvedPlayers.add(name);
    io.sockets.sockets.forEach(s => {
      if (s.name === name) {
        s.emit('approved');
      }
    });
  });

  socket.on('send-question', (q) => {
    io.emit('question', q);
  });

  socket.on('answer', (data) => {
    io.emit('player-answer', data);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server attivo sulla porta ${PORT}`);
});
