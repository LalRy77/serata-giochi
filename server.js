// server.js
const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: "*" } });

// file di log e DB
const LOG_FILE = path.join(__dirname, 'logs',  'server.log');
const DB_FILE  = path.join(__dirname, 'db.json');

// serve tutto ciò che c’è in public (favicon, html, css, immagini…)
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// carica DB dei punteggi persistenti
let punteggi = {};
if (fs.existsSync(DB_FILE)) {
  try {
    punteggi = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error("Errore lettura db.json:", e);
  }
}

// stanze in memoria
let rooms = {};

// helper di logging
function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  console.log(msg);
}

// genera un codice stanza
function generateRoomCode(len = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({length: len}, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

// home + creazione stanza
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/crea-stanza', (req, res) => {
  const quiz     = req.query.quiz;
  const filePath = path.join(__dirname, 'quiz', `${quiz}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Quiz non trovato');
  }
  const codice = generateRoomCode();
  const data   = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  rooms[codice] = {
    domande:   data,
    corrente:  0,
    risposte:  {},
    giocatori: {},   // socket.id → nome
    usedNames: [],   // nomi già presi
    abilitati: [],   // [nome]
    punteggi:  {},   // { nome: punti }
    online:    {}    // { nome: true|false }
  };

  log(`[ROOM ${codice}] Creata stanza per quiz ${quiz}`);
  res.redirect(`/host.html?room=${codice}&quiz=${quiz}`);
});

io.on('connection', socket => {
  // --- TESORIERE ---
  socket.on('join-tesoriere', room => {
    const st = rooms[room];
    if (!st) {
      return log(`[ERRORE] Tesoriere stanza inesistente: ${room}`);
    }
    socket.join(room);
    socket.emit('players',   Object.values(st.giocatori));
    socket.emit('abilitati', st.abilitati);
    socket.emit('online',    st.online);
  });

  // --- PLAYER JOIN ---
  socket.on('join', ({ room, nome }) => {
    const st = rooms[room];
    if (!st) {
      log(`[ERRORE] join stanza inesistente: ${room}`);
      return;
    }
    if (st.usedNames.some(n => n.toLowerCase() === nome.toLowerCase())) {
      socket.emit('errore', 'Nome già in uso o riservato!');
      return log(`[ROOM ${room}] Tentativo nome duplicato: ${nome}`);
    }
    st.usedNames.push(nome);
    st.giocatori[socket.id] = nome;
    st.online[nome] = true;
    socket.join(room);
    log(`[ROOM ${room}] ${nome} si è unito`);
    io.to(room).emit('players', Object.values(st.giocatori));
    io.to(room).emit('online',  st.online);
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
      st.abilitati.splice(i, 1);
      log(`[ROOM ${room}] Disabilitato: ${nome}`);
      io.to(room).emit('abilitati', st.abilitati);
    }
  });

  // --- HOST JOIN ---
  socket.on('join-host', room => {
    const st = rooms[room];
    if (!st) {
      return log(`[ERRORE] Host stanza inesistente: ${room}`);
    }
    socket.join(room);
    socket.emit('abilitati', st.abilitati);
    socket.emit('online',    st.online);
    log(`[ROOM ${room}] Host collegato`);
  });

  // --- START GAME (invia la prima domanda) ---
  socket.on('start-game', room => {
    const st = rooms[room];
    if (!st) {
      return log(`[ERRORE] start-game stanza inesistente: ${room}`);
    }
    log(`[ROOM ${room}] Inizio gioco`);
    sendNextQuestion(room);
  });

  // --- REQUEST INTRO (immagine/video + durata) ---
  socket.on('request-intro', room => {
    const st  = rooms[room];
    const idx = st.corrente - 1;
    if (!st || idx < 0 || idx >= st.domande.length) return;
    const q = st.domande[idx];
    socket.emit('show-intro', {
      immagine: q.immagine,
      video:    q.video || null,
      durata:   q.durataIntro || 3000
    });
  });

  // --- RISPOSTA PLAYER ---
  socket.on('risposta', ({ room, risposta }) => {
    const st = rooms[room];
    if (!st) {
      return log(`[ERRORE] risposta stanza inesistente: ${room}`);
    }
    st.risposte[socket.id] = { risposta, tempo: Date.now() };
    const tutti = Object.keys(st.giocatori).every(id => st.risposte[id]);
    if (tutti) {
      // … qui inserisci la tua logica punteggi / badge …
      sendNextQuestion(room);
    }
  });

  // --- GET RANKING (richiesta classifica) ---
  socket.on('get-ranking', room => {
    const st = rooms[room];
    if (!st) return;
    const arr = Object.entries(st.punteggi)
      .map(([n,p]) => ({ nome: n, punti: p }))
      .sort((a,b) => b.punti - a.punti)
      .slice(0, 10);
    socket.emit('ranking', arr);
  });

  // --- NEXT QUESTION (host chiede la successiva) ---
  socket.on('next-question', room => {
    sendNextQuestion(room);
  });

  // --- DISCONNECT TRACKING ---
  socket.on('disconnect', () => {
    for (const r in rooms) {
      const st = rooms[r];
      if (st.giocatori[socket.id]) {
        const nome = st.giocatori[socket.id];
        st.online[nome] = false;
        delete st.giocatori[socket.id];
        log(`[ROOM ${r}] ${nome} si è disconnesso`);
        io.to(r).emit('players', Object.values(st.giocatori));
        io.to(r).emit('online',  st.online);
      }
    }
  });
});

// invia la prossima domanda (con numero, testo, risposte, immagine, corretta)
function sendNextQuestion(room) {
  const st  = rooms[room];
  const idx = st.corrente;
  if (idx < st.domande.length) {
    const q = st.domande[idx];
    io.to(room).emit('new-question', {
      numero:   idx + 1,
      testo:    q.testo,
      risposte: q.risposte,
      immagine: q.immagine,
      corretta: q.corretta
    });
    log(`[ROOM ${room}] Inviata domanda #${idx+1}`);
    st.corrente++;
    st.risposte = {};
  } else {
    io.to(room).emit('fine-gioco', st.punteggi);
    log(`[ROOM ${room}] Fine gioco`);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`✅ Server in ascolto sulla porta ${PORT}`));
