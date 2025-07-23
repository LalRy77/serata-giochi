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

let rooms = {}; // Ogni stanza rappresenta un quiz in corso

function generateRoomCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Home → apre host.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'host.html'));
});

// Creazione stanza quiz
app.get('/crea-stanza', (req, res) => {
  const quiz = req.query.quiz;
  const filePath = path.join(__dirname, 'quiz', quiz + '.json');

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Quiz non trovato');
  }

  const codice = generateRoomCode();
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  rooms[codice] = {
    domande: data,
    corrente: 0,
    risposte: {},
    giocatori: {},
    abilitati: []
  };

  res.redirect(`/host.html?room=${codice}`);
});

// Socket: connessione giocatori
io.on('connection', socket => {
  socket.on('join', ({ room, nome }) => {
    if (!rooms[room]) return;
    socket.join(room);
    rooms[room].giocatori[socket.id] = nome;

    io.to(room).emit('players', Object.values(rooms[room].giocatori));
  });

  socket.on('abilita', ({ room, nome }) => {
    if (!rooms[room]) return;
    if (!rooms[room].abilitati.includes(nome)) {
      rooms[room].abilitati.push(nome);
    }
    io.to(room).emit('abilitati', rooms[room].abilitati);
  });

  socket.on('risposta', ({ room, risposta }) => {
    if (!rooms[room]) return;
    rooms[room].risposte[socket.id] = risposta;

    const domande = rooms[room].domande;
    const index = rooms[room].corrente;
    const corretta = domande[index].corretta;

    const tuttiRisposto = Object.keys(rooms[room].giocatori).every(id =>
      rooms[room].risposte.hasOwnProperty(id)
    );

    if (tuttiRisposto) {
      const risposte = rooms[room].risposte;
      const risultati = Object.entries(risposte).map(([id, risposta]) => ({
        id,
        nome: rooms[room].giocatori[id],
        corretta: risposta === corretta,
        tempo: Math.random()
      }));

      risultati.sort((a, b) => {
        if (a.corretta && !b.corretta) return -1;
        if (!a.corretta && b.corretta) return 1;
        return a.tempo - b.tempo;
      });

      const premiati = risultati.filter(r => r.corretta);
      premiati.forEach((r, i) => {
        let msg = '';
        if (i === 0) msg = '🥇 Primo classificato<br>Stanza ' + room + '<br>Giocatore: ' + r.nome;
        else if (i === 1) msg = '🥈 Secondo classificato<br>Stanza ' + room + '<br>Giocatore: ' + r.nome;
        else if (i === 2) msg = '🥉 Terzo classificato<br>Stanza ' + room + '<br>Giocatore: ' + r.nome;
        else msg = '❌ Ops! Ritenta<br>Stanza ' + room + '<br>Giocatore: ' + r.nome;

        io.to(r.id).emit('badge', msg);
      });

      sendNextQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    for (const room in rooms) {
      if (rooms[room].giocatori[socket.id]) {
        delete rooms[room].giocatori[socket.id];
        io.to(room).emit('players', Object.values(rooms[room].giocatori));
      }
    }
  });
});

// Manda la prossima domanda
function sendNextQuestion(room) {
  const domande = rooms[room].domande;
  const index = rooms[room].corrente;

  if (index < domande.length) {
    const domanda = domande[index];
    io.to(room).emit('new-question', domanda);
    rooms[room].corrente++;
    rooms[room].risposte = {};
  } else {
    io.to(room).emit('fine-gioco');
  }
}

// Avvia server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server avviato su porta ${PORT}`);
});
