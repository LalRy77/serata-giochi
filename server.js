
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.static(__dirname));

let rooms = {};

function generateRoomCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

app.get('/crea-stanza', (req, res) => {
  const quiz = req.query.quiz;
  const roomCode = generateRoomCode();
  rooms[roomCode] = {
    quiz,
    players: {},
    approvati: [],
    risposte: {},
    attesa: []
  };
  res.json({ room: roomCode });
});

io.on('connection', (socket) => {
  socket.on('join-host', (room) => {
    socket.join(room);
    const quizFile = path.join(__dirname, 'quiz', rooms[room].quiz + '.json');
    if (fs.existsSync(quizFile)) {
      const quizData = JSON.parse(fs.readFileSync(quizFile));
      rooms[room].domande = quizData;
      rooms[room].corrente = 0;
      sendNextQuestion(room);
    }
  });

  socket.on('join-player', ({ room, nome }) => {
    if (!rooms[room]) return;
    if (rooms[room].players[nome]) return;
    rooms[room].players[nome] = socket.id;
    rooms[room].attesa.push(nome);
    socket.join(room);
    socket.room = room;
    socket.nome = nome;
    io.to(room).emit('lista-attesa', rooms[room].attesa);
  });

  socket.on('join-tesoriere', (room) => {
    socket.join(room);
    if (rooms[room]) {
      io.to(socket.id).emit('lista-attesa', rooms[room].attesa);
    }
  });

  socket.on('approve-player', ({ room, nome }) => {
    if (rooms[room]) {
      rooms[room].approvati.push(nome);
      rooms[room].attesa = rooms[room].attesa.filter(n => n !== nome);
      const id = rooms[room].players[nome];
      if (id) {
        io.to(id).emit('approved');
      }
      io.to(room).emit('lista-attesa', rooms[room].attesa);
    }
  });

  socket.on('answer', ({ room, nome, risposta }) => {
    if (!rooms[room].risposte[nome]) {
      rooms[room].risposte[nome] = risposta;
    }
  });

  socket.on('show-ranking', (room) => {
    const domandaCorrente = rooms[room].corrente - 1;
    if (domandaCorrente < 0 || !rooms[room].domande[domandaCorrente]) return;
    const corretta = rooms[room].domande[domandaCorrente].corretta;
    const punteggi = Object.entries(rooms[room].risposte)
      .map(([nome, risposta]) => ({ nome, corretto: risposta === corretta }))
      .sort((a, b) => b.corretto - a.corretto);

    const primi = punteggi.filter(p => p.corretto).map(p => p.nome).slice(0, 3);
    Object.keys(rooms[room].players).forEach(nome => {
      const id = rooms[room].players[nome];
      let msg = '';
      if (primi[0] === nome) msg = `🏆 Primo classificato<br>Stanza ${room}<br>Giocatore: ${nome}`;
      else if (primi[1] === nome) msg = `🥈 Secondo classificato<br>Stanza ${room}<br>Giocatore: ${nome}`;
      else if (primi[2] === nome) msg = `🥉 Terzo classificato<br>Stanza ${room}<br>Giocatore: ${nome}`;
      else msg = `❌ Ops! Ritenta<br>Stanza ${room}<br>Giocatore: ${nome}`;
      io.to(id).emit('badge', msg);
    });
  });
});

function sendNextQuestion(room) {
  const domande = rooms[room].domande;
  const index = rooms[room].corrente;
  if (index < domande.length) {
    const domanda = domande[index];
    rooms[room].risposte = {};
    io.to(room).emit('new-question', domanda);
    rooms[room].corrente++;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server avviato sulla porta', PORT);
});
