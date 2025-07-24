const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const LOG_FILE = path.join(__dirname, 'logs', 'server.log');
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Carica punteggi salvati
let punteggi = {};
if (fs.existsSync(DB_FILE)) {
  try {
    punteggi = JSON.parse(fs.readFileSync(DB_FILE));
  } catch (e) {
    console.error("Errore nel leggere db.json:", e);
  }
}

let rooms = {};

function log(msg) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
  console.log(msg);
}

function generateRoomCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/crea-stanza', (req, res) => {
  const quiz = req.query.quiz;
  const filePath = path.join(__dirname, 'quiz', `${quiz}.json`);

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
    abilitati: [],
    punteggi: {}
  };

  log(`[ROOM ${codice}] Creata stanza per quiz ${quiz}`);
  res.redirect(`/host.html?room=${codice}`);
});

io.on('connection', socket => {

  socket.on('join-tesoriere', room => {
    if (rooms[room]) {
      socket.join(room);
      socket.emit('players', Object.values(rooms[room].giocatori));
    } else {
      log(`[ERRORE] Tesoriere tenta accesso a room non esistente: ${room}`);
    }
  });

  socket.on('join', ({ room, nome }) => {
    if (!rooms[room]) {
      log(`[ERRORE] join fallito: room ${room} non esiste`);
      return;
    }

    const nomeGiaUsato = Object.values(rooms[room].giocatori).some(n => n === nome);
    if (nomeGiaUsato) {
      socket.emit('errore', 'Nome già in uso nella stanza!');
      log(`[ROOM ${room}] NOME DUPLICATO tentato: ${nome}`);
      return;
    }

    socket.join(room);
    rooms[room].giocatori[socket.id] = nome;
    log(`[ROOM ${room}] ${nome} (${socket.id}) si è unito`);
    io.to(room).emit('players', Object.values(rooms[room].giocatori));
  });

  socket.on('abilita', ({ room, nome }) => {
    if (!rooms[room]) {
      log(`[ERRORE] Abilita fallito, room ${room} non trovata`);
      return;
    }
    if (!rooms[room].abilitati.includes(nome)) {
      rooms[room].abilitati.push(nome);
    }
    log(`[ROOM ${room}] Giocatore abilitato: ${nome}`);
    io.to(room).emit('abilitati', rooms[room].abilitati);
  });

  socket.on('risposta', ({ room, risposta }) => {
    if (!rooms[room]) {
      log(`[ERRORE] ${socket.id} ha tentato risposta in room NON ESISTENTE: ${room}`);
      return;
    }

    rooms[room].risposte[socket.id] = {
      risposta,
      tempo: Date.now()
    };

    const domande = rooms[room].domande;
    const index = rooms[room].corrente;
    const corretta = domande[index].corretta;

    const tuttiRisposto = Object.keys(rooms[room].giocatori).every(id =>
      rooms[room].risposte.hasOwnProperty(id)
    );

    if (tuttiRisposto) {
      const risposte = rooms[room].risposte;
      const risultati = Object.entries(risposte).map(([id, r]) => ({
        id,
        nome: rooms[room].giocatori[id],
        corretta: r.risposta === corretta,
        tempo: r.tempo
      }));

      const corretti = risultati.filter(r => r.corretta);
      corretti.sort((a, b) => a.tempo - b.tempo);

      corretti.forEach((r, i) => {
        let bonus = 0;
        if (i === 0) bonus = 20;
        const punti = 50 + bonus;

        rooms[room].punteggi[r.nome] = (rooms[room].punteggi[r.nome] || 0) + punti;

        let msg = '';
        if (i === 0) msg = `🥇 Primo classificato<br>Giocatore: ${r.nome}<br>+${punti} punti`;
        else if (i === 1) msg = `🥈 Secondo classificato<br>${r.nome}<br>+${punti} punti`;
        else if (i === 2) msg = `🥉 Terzo classificato<br>${r.nome}<br>+${punti} punti`;
        else msg = `✅ Corretto<br>${r.nome}<br>+${punti} punti`;

        io.to(r.id).emit('badge', msg);
      });

      punteggi[room] = rooms[room].punteggi;
      fs.writeFileSync(DB_FILE, JSON.stringify(punteggi, null, 2));
      sendNextQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    for (const room in rooms) {
      if (rooms[room].giocatori[socket.id]) {
        const nome = rooms[room].giocatori[socket.id];
        log(`[ROOM ${room}] ${nome} (${socket.id}) si è disconnesso`);
        delete rooms[room].giocatori[socket.id];
        io.to(room).emit('players', Object.values(rooms[room].giocatori));
      }
    }
  });
});

function sendNextQuestion(room) {
  const domande = rooms[room].domande;
  const index = rooms[room].corrente;

  if (index < domande.length) {
    const domanda = domande[index];
    io.to(room).emit('new-question', domanda);
    log(`[ROOM ${room}] Inviata domanda ${index + 1}`);
    rooms[room].corrente++;
    rooms[room].risposte = {};
  } else {
    io.to(room).emit('fine-gioco', rooms[room].punteggi);
    log(`[ROOM ${room}] Fine gioco`);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`✅ Server avviato su porta ${PORT}`);
});