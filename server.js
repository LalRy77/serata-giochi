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
    giocatori: {},     // socket.id → nome
    usedNames: [],     // tutti i nomi presi
    abilitati: [],     // [nome]
    punteggi: {},      // { nome: punti }
    online: {}         // { nome: true/false }
  };

  log(`[ROOM ${codice}] Creata stanza per quiz ${quiz}`);
  res.redirect(`/host.html?room=${codice}&quiz=${quiz}`);
});

io.on('connection', socket => {
  // --- TESORIERE ---
  socket.on('join-tesoriere', room => {
    const stanza = rooms[room];
    if (!stanza) {
      return log(`[ERRORE] Tesoriere stanza inesistente: ${room}`);
    }
    socket.join(room);
    socket.emit('players', Object.values(stanza.giocatori));
    socket.emit('abilitati', stanza.abilitati);
    socket.emit('online', stanza.online);
  });

  // --- PLAYER JOIN ---
  socket.on('join', ({ room, nome }) => {
    const stanza = rooms[room];
    if (!stanza) {
      log(`[ERRORE] join fallito stanza inesistente: ${room}`);
      return;
    }
    // nome già riservato?
    if (stanza.usedNames.some(n => n.toLowerCase() === nome.toLowerCase())) {
      socket.emit('errore', 'Nome già in uso o riservato!');
      return log(`[ROOM ${room}] Nome duplicato/riservato: ${nome}`);
    }
    stanza.usedNames.push(nome);
    stanza.giocatori[socket.id] = nome;
    stanza.online[nome] = true;
    socket.join(room);
    log(`[ROOM ${room}] ${nome} (${socket.id}) si è unito`);
    io.to(room).emit('players', Object.values(stanza.giocatori));
    io.to(room).emit('online', stanza.online);
  });

  // --- ABILITA / DISABILITA ---
  socket.on('abilita', ({ room, nome }) => {
    const st = rooms[room];
    if (!st) return;
    if (!st.abilitati.includes(nome)) {
      st.abilitati.push(nome);
      log(`[ROOM ${room}] Abilitato: ${nome}`);
      io.to(room).emit('abilitati', st.abilitati);
    }
  });
  socket.on('disabilita', ({ room, nome }) => {
    const st = rooms[room];
    if (!st) return;
    const i = st.abilitati.indexOf(nome);
    if (i !== -1) {
      st.abilitati.splice(i,1);
      log(`[ROOM ${room}] Disabilitato: ${nome}`);
      io.to(room).emit('abilitati', st.abilitati);
    }
  });

  // --- HOST JOIN ---
  socket.on('join-host', room => {
    const stanza = rooms[room];
    if (!stanza) {
      return log(`[ERRORE] Host stanza inesistente: ${room}`);
    }
    socket.join(room);
    socket.emit('abilitati', stanza.abilitati);
    socket.emit('online', stanza.online);
    log(`[ROOM ${room}] Host collegato`);
  });

  // --- INIZIA IL GIOCO (prima domanda) ---
  socket.on('start-game', room => {
    const stanza = rooms[room];
    if (!stanza) {
      return log(`[ERRORE] start-game stanza inesistente: ${room}`);
    }
    log(`[ROOM ${room}] Inizio gioco`);
    sendNextQuestion(room);
  });

  // --- RISPOSTA GIOCATORE ---
  socket.on('risposta', ({ room, risposta }) => {
    const st = rooms[room];
    if (!st) {
      log(`[ERRORE] risposta stanza inesistente: ${room}`);
      return;
    }
    st.risposte[socket.id] = { risposta, tempo: Date.now() };

    const index = st.corrente;
    const corretta = st.domande[index].corretta;
    const tutti = Object.keys(st.giocatori).every(id => st.risposte.hasOwnProperty(id));

    if (tutti) {
      // logica esatta come l’avevi già
      // …
      // poi:
      sendNextQuestion(room);
    }
  });

  // --- DISCONNECT TRACKING ---
  socket.on('disconnect', () => {
    for (const room in rooms) {
      const st = rooms[room];
      if (st.giocatori[socket.id]) {
        const nome = st.giocatori[socket.id];
        st.online[nome] = false;
        delete st.giocatori[socket.id];
        log(`[ROOM ${room}] ${nome} si è disconnesso`);
        io.to(room).emit('players', Object.values(st.giocatori));
        io.to(room).emit('online', st.online);
      }
    }
  });

}); // fine io.on

// --- FUNZIONE INVIO DOMANDA ---
function sendNextQuestion(room) {
  const st = rooms[room];
  const idx = st.corrente;
  if (idx < st.domande.length) {
    const q = st.domande[idx];
    io.to(room).emit('new-question', q);
    log(`[ROOM ${room}] Inviata domanda #${idx+1}`);
    st.corrente++;
    st.risposte = {};
  } else {
    io.to(room).emit('fine-gioco', st.punteggi);
    log(`[ROOM ${room}] Fine gioco`);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`✅ Server avviato su porta ${PORT}`));
