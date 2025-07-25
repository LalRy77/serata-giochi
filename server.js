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
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  console.log(msg);
}

function generateRoomCode(len = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/crea-stanza', (req, res) => {
  const quiz = req.query.quiz;
  const filePath = path.join(__dirname, 'quiz', `${quiz}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).send('Quiz non trovato');

  const codice = generateRoomCode();
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  rooms[codice] = {
    domande: data,
    corrente: 0,
    risposte: {},
    giocatori: {},        // socket.id → nome
    usedNames: [],        // tutti i nomi già presi (riservati)
    abilitati: [],        // [nome]
    punteggi: {},         // { nome: punti }
    online: {}            // { nome: true/false }
  };

  log(`[ROOM ${codice}] Creata stanza per quiz ${quiz}`);
  res.redirect(`/host.html?room=${codice}&quiz=${quiz}`);
});

io.on('connection', socket => {
  // TESORIERE
  socket.on('join-tesoriere', room => {
    if (!rooms[room]) {
      return log(`[ERRORE] Tesoriere tenta accesso stanza inesistente: ${room}`);
    }
    socket.join(room);
    socket.emit('players', Object.values(rooms[room].giocatori));
    socket.emit('abilitati', rooms[room].abilitati);
    socket.emit('online', rooms[room].online);
  });

  // JOIN PLAYER
  socket.on('join', ({ room, nome }) => {
    if (!rooms[room]) {
      log(`[ERRORE] join fallito: stanza inesistente ${room}`);
      return;
    }
    // nome riservato?
    if (rooms[room].usedNames.some(n => n.toLowerCase()===nome.toLowerCase())) {
      socket.emit('errore', 'Nome già in uso o riservato!');
      return log(`[ROOM ${room}] Tentativo nome riservato/duplicato: ${nome}`);
    }
    // ok, riserva il nome
    rooms[room].usedNames.push(nome);
    rooms[room].giocatori[socket.id] = nome;
    rooms[room].online[nome] = true;
    socket.join(room);
    log(`[ROOM ${room}] ${nome} (${socket.id}) si è unito`);
    io.to(room).emit('players', Object.values(rooms[room].giocatori));
    io.to(room).emit('online', rooms[room].online);
  });

  // ABILITA / DISABILITA
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
    const i = rooms[room].abilitati.indexOf(nome);
    if (i!==-1) {
      rooms[room].abilitati.splice(i,1);
      log(`[ROOM ${room}] Giocatore disabilitato: ${nome}`);
      io.to(room).emit('abilitati', rooms[room].abilitati);
    }
  });

  // HOST
  socket.on('join-host', room => {
    if (!rooms[room]) {
      return log(`[ERRORE] Host tenta accesso stanza inesistente: ${room}`);
    }
    socket.join(room);
    socket.emit('abilitati', rooms[room].abilitati);
    socket.emit('online', rooms[room].online);
    log(`[ROOM ${room}] Host collegato`);
  });

  // RISPOSTA (la tua logica esistente)
  socket.on('risposta', ({ room, risposta }) => {
    // …
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    for (const r in rooms) {
      if (rooms[r].giocatori[socket.id]) {
        const nome = rooms[r].giocatori[socket.id];
        rooms[r].online[nome] = false;
        delete rooms[r].giocatori[socket.id];
        log(`[ROOM ${r}] ${nome} si è disconnesso`);
        io.to(r).emit('players', Object.values(rooms[r].giocatori));
        io.to(r).emit('online', rooms[r].online);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`✅ Server avviato su porta ${PORT}`));
