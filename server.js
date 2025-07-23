const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

const stanze = {};
const pendingPlayers = {};

io.on('connection', (socket) => {
  socket.on('crea-stanza', ({ gioco }, callback) => {
    const codice = Math.random().toString(36).substring(2, 7).toUpperCase();
    stanze[codice] = { gioco, players: [] };
    pendingPlayers[codice] = [];
    callback(codice);
  });

  socket.on('partecipa', ({ codice, nome }, callback) => {
    if (!stanze[codice]) return callback({ ok: false, errore: 'Stanza non trovata' });
    pendingPlayers[codice].push({ id: socket.id, nome });
    callback({ ok: true });
    io.emit('aggiorna-attesa', { codice, giocatori: pendingPlayers[codice] });
  });

  socket.on('richiedi-attesa', (codice) => {
    if (pendingPlayers[codice]) {
      socket.emit('aggiorna-attesa', { codice, giocatori: pendingPlayers[codice] });
    }
  });

  socket.on('approva-giocatore', ({ codice, id }) => {
    const index = pendingPlayers[codice].findIndex(g => g.id === id);
    if (index !== -1) {
      const approvato = pendingPlayers[codice].splice(index, 1)[0];
      stanze[codice].players.push(approvato);
      io.to(id).emit('approvato');
      io.emit('aggiorna-attesa', { codice, giocatori: pendingPlayers[codice] });
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server avviato sulla porta ${PORT}`);
});
