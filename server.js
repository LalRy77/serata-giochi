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
    punteggi: {},
    online: {}
  };

  log(`[ROOM ${codice}] Creata stanza per quiz ${quiz}`);
  res.redirect(`/host.html?room=${codice}&quiz=${quiz}`);
});

io.on('connection', socket => {

  socket.on('join-tesoriere', room => {
    if (rooms[room]) {
      socket.join(room);
      socket.emit('players', Object.values(rooms[room].giocatori));
      socket.emit('abilitati', rooms[room].abilitati);
      socket.emit('online', rooms[room].online);
    } else {
      log(`[ERRORE] Tesoriere tenta accesso a room non esistente: ${room}`);
    }
  });

  socket.on('join', ({ room, nome }) => {
    if (!rooms[room]) {
      log(`[ERRORE] join fallito: room ${room} non esiste`);
      return;
    }

    const nomeGiaUsato = Object.values(rooms[room].giocatori).some(n => n.toLowerCase() === nome.toLowerCase());
    if (nomeGiaUsato) {
      socket.emit('errore', 'Nome già in uso nella stanza!');
      log(`[ROOM ${room}] NOME DUPLICATO tentato: ${nome}`);
      return;
    }

    socket.join(room);
    rooms[room].giocatori[socket.id] = nome;
    rooms[room].online[nome] = true;
    log(`[ROOM ${room}] ${nome} (${socket.id}) si è unito`);
    io.to(room).emit('players', Object.values(rooms[room].giocatori));
    io.to(room).emit('online', rooms[room].online);
  });

  socket.on('abilita', ({ room, nome }) => {
    if (!rooms[room]) return;
    if (!rooms[room].abilitati.includes(nome)) {
      rooms[room].abilitati.push(nome);
      log(`[ROOM ${room}] Giocatore abilitato: ${nome}`);
      io.to(room).emit('abilitati', rooms[room].abilitati);
    }
  });

  socket.on('disabilita', ({ room, nome }) => {
    if (!rooms[room]) return;
    const index = rooms[room].abilitati.indexOf(nome);
    if (index !== -1) {
      rooms[room].abilitati.splice(index, 1);
      log(`[ROOM ${room}] Giocatore DISABILITATO: ${nome}`);
      io.to(room).emit('abilitati', rooms[room].abilitati);
    }
  });

  socket.on('join-host', room => {
    if (rooms[room]) {
      socket.join(room);
      socket.emit('abilitati', rooms[room].abilitati);
      socket.emit('online', rooms[room].online);
      log(`[ROOM ${room}] Host si è collegato e riceve lista abilitati e stato online`);
    } else {
      log(`[ERRORE] Host tenta accesso a room non esistente: ${room}`);
    }
  });

  socket.on('disconnect', () => {
    for (const r in rooms) {
      if (rooms[r].giocatori[socket.id]) {
        const nome = rooms[r].giocatori[socket.id];
        rooms[r].online[nome] = false;
        delete rooms[r].giocatori[socket.id];
        log(`[ROOM ${r}] ${nome} (${socket.id}) si è disconnesso`);
        io.to(r).emit('players', Object.values(rooms[r].giocatori));
        io.to(r).emit('online', rooms[r].online);
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
