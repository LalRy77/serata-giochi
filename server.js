const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: "*" } });

const LOG_FILE = path.join(__dirname, 'logs','server.log');
const DB_FILE  = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

let punteggi = {};
if (fs.existsSync(DB_FILE)) {
  try { punteggi = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
  catch(e){ console.error("db.json read error",e); }
}

let rooms = {};

function log(msg){
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  console.log(msg);
}
function genCode(len=6){
  const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array(len).fill().map(_=>cs[Math.floor(Math.random()*cs.length)]).join('');
}

app.get('/', (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/crea-stanza',(req,res)=>{
  const quiz = req.query.quiz;
  const fp   = path.join(__dirname,'quiz',`${quiz}.json`);
  if(!fs.existsSync(fp)) return res.status(404).send('Quiz non trovato');
  const code = genCode(), data = JSON.parse(fs.readFileSync(fp,'utf8'));
  rooms[code]={
    domande: data, corrente:0,
    risposte:{}, giocatori:{}, usedNames:[],
    abilitati:[], punteggi:{}, online:{}
  };
  log(`[ROOM ${code}] Creata per ${quiz}`);
  res.redirect(`/host.html?room=${code}&quiz=${quiz}`);
});

io.on('connection', socket=>{
  socket.on('join-tesoriere', room=>{
    const st=rooms[room]; if(!st) return log(`ERRORE tesoriere:${room}`);
    socket.join(room);
    socket.emit('players', Object.values(st.giocatori));
    socket.emit('abilitati', st.abilitati);
    socket.emit('online', st.online);
  });

  socket.on('join',({room,nome})=>{
    const st=rooms[room]; if(!st) return log(`ERRORE join:${room}`);
    if(st.usedNames.find(n=>n.toLowerCase()===nome.toLowerCase())){
      socket.emit('errore','Nome già in uso!'); return;
    }
    st.usedNames.push(nome);
    st.giocatori[socket.id]=nome;
    st.online[nome]=true;
    socket.join(room);
    log(`[ROOM ${room}] ${nome} joined`);
    io.to(room).emit('players', Object.values(st.giocatori));
    io.to(room).emit('online', st.online);
  });

  socket.on('abilita', ({room,nome})=>{
    const st=rooms[room]; if(!st) return;
    if(!st.abilitati.includes(nome)){
      st.abilitati.push(nome);
      io.to(room).emit('abilitati', st.abilitati);
    }
  });
  socket.on('disabilita', ({room,nome})=>{
    const st=rooms[room]; if(!st) return;
    st.abilitati = st.abilitati.filter(n=>n!==nome);
    io.to(room).emit('abilitati', st.abilitati);
  });

  socket.on('join-host', room=>{
    const st=rooms[room]; if(!st) return;
    socket.join(room);
    socket.emit('abilitati', st.abilitati);
    socket.emit('online', st.online);
  });

  socket.on('start-game', room=>{
    const st=rooms[room]; if(!st) return;
    sendNext(room);
  });
  socket.on('request-intro', room=>{
    const st=rooms[room], idx=st.corrente-1; if(!st||idx<0) return;
    const q=st.domande[idx];
    socket.emit('show-intro',{immagine:q.immagine,video:q.video||null,durata:q.durataIntro||3000});
  });
  socket.on('risposta',({room,risposta})=>{
    const st=rooms[room]; if(!st) return;
    st.risposte[socket.id]={risposta,tempo:Date.now()};
    if(Object.keys(st.giocatori).every(id=>st.risposte[id])){
      // calcola punteggi qui…
      sendNext(room);
    }
  });
  socket.on('get-ranking', room=>{
    const st=rooms[room]; if(!st) return;
    const arr = Object.entries(st.punteggi).map(([n,p])=>({nome:n,punti:p}))
                   .sort((a,b)=>b.punti - a.punti).slice(0,10);
    socket.emit('ranking', arr);
  });

  socket.on('disconnect',()=>{
    for(let r in rooms){
      const st=rooms[r];
      if(st.giocatori[socket.id]){
        const n=st.giocatori[socket.id];
        st.online[n]=false; delete st.giocatori[socket.id];
        io.to(r).emit('players',Object.values(st.giocatori));
        io.to(r).emit('online',st.online);
      }
    }
  });
});

function sendNext(room){
  const st=rooms[room], i=st.corrente;
  if(i<st.domande.length){
    const q=st.domande[i];
    io.to(room).emit('new-question',{numero:i+1,testo:q.testo,risposte:q.risposte,immagine:q.immagine,corretta:q.corretta});
    st.corrente++; st.risposte={};
  } else {
    io.to(room).emit('fine-gioco',st.punteggi);
  }
}

server.listen(process.env.PORT||3000,()=>log('Server online'));
