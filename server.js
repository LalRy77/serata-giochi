
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

// ✅ API per creare stanza
app.get('/crea-stanza', (req, res) => {
  const quiz = req.query.quiz;
  if (!quiz) return res.status(400).json({ error: 'Quiz non specificato' });

  const roomCode = generateRoomCode();
  rooms[roomCode] = {
    quiz,
    players: {},
    approvati: [],
    risposte: {},
  };
  res.json({ room: roomCode });
});

// ✅ SOCKET.IO gestione eventi
io.on('connection', (socket) => {
  // Host
  socket.on('join-host', (room) => {
    if (!room || !rooms[room]) return;
    socket.join(room);
    const quizFile = path.join(__dirname, 'quiz', rooms[room].quiz + '.json');
    if (fs.existsSync(quizFile)) {
      const quizData = JSON.parse(fs.readFileSync(quizFile));
      rooms[room].domande = quizData;
      rooms[room].corrente = 0;
      sendNextQuestion(room);
    }
  });

  // Player
  socket.on('join-player', ({ room, nome }) => {
    if (!room || !rooms[room] || !nome) return;
    if (rooms[room].players[nome]) return; // già registrato
    rooms[room].players[nome] = socket.id;
    socket.join(room);
    socket.room = room;
    socket.nome = nome;
    io.to(room).emit('waiting-player', nome);
  });

  // Tesoriere
  socket.on('join-tesoriere', (room) => {
    if (!room || !rooms[room]) return;
    socket.join(room);
  });

  // Approva giocatore
  socket.on('approve-player', ({ room, nome }) => {
    if (!room || !rooms[room] || !nome) return;
    rooms[room].approvati.push(nome);
    const id = rooms[room].players[nome];
    if (id) {
      io.to(id).emit('approved');
    }
  });

  // Risposta da giocatore
  socket.on('answer', ({ room, nome, risposta }) => {
    if (!room || !nome || risposta == null || !rooms[room]) return;
    if (!rooms[room].risposte[nome]) {
      rooms[room].risposte[nome] = risposta;
    }
  });

  // Classifica
  socket.on('show-ranking', (room) => {
    if (!room || !rooms[room]) return;
    const domandaCorrente = rooms[room].domande[rooms[room].corrente - 1];
    const rispostaCorretta = domandaCorrente?.corretta;

    const punteggi = Object.entries(rooms[room].risposte)
      .map(([nome, risposta]) => ({ nome, corretto: risposta === rispostaCorretta }))
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

// ✅ funzione per inviare domanda successiva
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

// ✅ Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server avviato sulla porta', PORT);
});
