const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// =====================================================================
// CONSTANTES PHYSIQUE — coordonnées normalisées 0→1
// x=0.09 bord gauche terrain, x=0.91 bord droit
// y=0.14 bord haut terrain,   y=0.78 bord bas
// =====================================================================
const FIELD_X1 = 0.09, FIELD_X2 = 0.91;
const FIELD_Y1 = 0.14, FIELD_Y2 = 0.78;
const FIELD_CX = (FIELD_X1 + FIELD_X2) / 2;
const FIELD_CY = (FIELD_Y1 + FIELD_Y2) / 2;

// Cage: valeurs EXACTES du client
// Client: FH=H*0.64, GH=FH*0.3=H*0.192
// gY1 = H*0.14 + H*0.32 - H*0.096 = H*0.364
// gY2 = H*0.556
// Le serveur stocke y en fraction de H → GY1=0.364, GY2=0.556
const GY1 = 0.364;
const GY2 = 0.556;

const BALL_R   = 0.022;  // fraction de W (cohérent avec BR=min(W,H)*0.028 sur 16:9)
const CAR_W    = 0.085;
const CAR_H    = 0.055;
const CAR_R    = 0.040;  // rayon collision voiture
const SPD      = 0.28;   // vitesse max (unités/s)
const BOOST_MUL= 1.85;
const FRIC_PS  = 0.82;
const BNC      = 0.62;
const TICK_MS  = 1000 / 60;
const MAX_DT   = 1 / 30; // plafond dt anti-tunneling

const rooms = {};

// =====================================================================
// PHYSIQUE
// =====================================================================
function createBall() {
  const side = Math.random() > 0.5 ? 0 : Math.PI;
  const angle = side + (Math.random() - 0.5) * 0.9;
  return {
    x: FIELD_CX, y: FIELD_CY,
    vx: Math.cos(angle) * 0.26,
    vy: Math.sin(angle) * 0.20,
    r: BALL_R
  };
}

function resetBall(room) { room.ball = createBall(); }

function resetPlayers(room) {
  const players = Object.values(room.players);
  const teamsCount = [0, 0];
  players.forEach(p => teamsCount[p.team]++);
  const teamsIdx = [0, 0];
  players.forEach(p => {
    const idx = teamsIdx[p.team]++;
    const total = teamsCount[p.team];
    const ySpread = (total > 1) ? (idx / (total - 1) - 0.5) * 0.18 : 0;
    p.x = p.team === 0 ? FIELD_X1 + (FIELD_X2 - FIELD_X1) * 0.22 : FIELD_X2 - (FIELD_X2 - FIELD_X1) * 0.22;
    p.y = FIELD_CY + ySpread;
    p.vx = 0; p.vy = 0;
    p.angle = p.team === 1 ? Math.PI : 0;
  });
}

function ballCollide(car, ball) {
  const dx = ball.x - car.x, dy = ball.y - car.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
  const minD = BALL_R + CAR_R;
  if (dist >= minD) return;
  const nx = dx / dist, ny = dy / dist;
  const rvx = ball.vx - car.vx, rvy = ball.vy - car.vy;
  const dot = rvx * nx + rvy * ny;
  if (dot < 0) {
    const carSpd = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    const imp = -dot * 1.7 + carSpd * 0.55 + 0.10;
    ball.vx += nx * imp;
    ball.vy += ny * imp;
  }
  // Dépénétration
  ball.x = car.x + nx * (minD + 0.003);
  ball.y = car.y + ny * (minD + 0.003);
}

function carCollide(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
  const minD = CAR_R * 2;
  if (dist >= minD) return;
  const nx = dx / dist, ny = dy / dist;
  // Dépénétration douce — pas d'éjection violente
  const overlap = (minD - dist) * 0.5;
  a.x -= nx * overlap; a.y -= ny * overlap;
  b.x += nx * overlap; b.y += ny * overlap;
  // Échange de vitesse minime — juste pour éviter la superposition
  const dot = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (dot > 0) {
    const k = 0.10;
    a.vx -= k * dot * nx; a.vy -= k * dot * ny;
    b.vx += k * dot * nx; b.vy += k * dot * ny;
  }
}

function clampPlayer(p) {
  const mx = CAR_W * 0.5, my = CAR_H * 0.5;
  if (p.x < FIELD_X1 + mx) { p.x = FIELD_X1 + mx; p.vx = Math.abs(p.vx) * 0.25; }
  if (p.x > FIELD_X2 - mx) { p.x = FIELD_X2 - mx; p.vx = -Math.abs(p.vx) * 0.25; }
  if (p.y < FIELD_Y1 + my) { p.y = FIELD_Y1 + my; p.vy = Math.abs(p.vy) * 0.25; }
  if (p.y > FIELD_Y2 - my) { p.y = FIELD_Y2 - my; p.vy = -Math.abs(p.vy) * 0.25; }
}

function tickRoom(room) {
  if (!room.started || room.paused || room._gameOverSent) return;

  // dt dynamique — évite dérive du timer sur serveurs lents/Render
  const now = Date.now();
  const dt = Math.min((now - (room._lastTick || now)) / 1000, MAX_DT);
  room._lastTick = now;

  // ---- Timer ----
  room.timeLeft -= dt;
  if (room.timeLeft <= 0) {
    room.timeLeft = 0;
    room.started = false;
    room._gameOverSent = true;
    clearInterval(room.ticker);
    room.ticker = null;
    broadcastState(room);
    broadcast(room, { type: 'GAME_OVER', scoreA: room.scoreA, scoreB: room.scoreB });
    return;
  }

  // ---- Joueurs ----
  const players = Object.values(room.players);
  players.forEach(p => {
    const inp = p.input || {};
    const boosting = inp.boost && p.boost > 0;
    const spd = SPD * (boosting ? BOOST_MUL : 1.0);
    p.boost = boosting
      ? Math.max(0, p.boost - dt * 0.50)
      : Math.min(1, p.boost + dt * 0.20);

    let ax = 0, ay = 0;
    if (inp.up)    ay -= 1;
    if (inp.down)  ay += 1;
    if (inp.left)  ax -= 1;
    if (inp.right) ax += 1;
    const al = Math.sqrt(ax * ax + ay * ay) || 1;
    p.vx += (ax / al) * spd * dt * 5.5;
    p.vy += (ay / al) * spd * dt * 5.5;

    const fric = Math.pow(FRIC_PS, dt);
    p.vx *= fric; p.vy *= fric;

    const ps = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (ps > spd) { p.vx = (p.vx / ps) * spd; p.vy = (p.vy / ps) * spd; }
    if (ps > 0.005) p.angle = Math.atan2(p.vy, p.vx);

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    clampPlayer(p);
  });

  // ---- Collisions voiture/voiture ----
  for (let i = 0; i < players.length; i++)
    for (let j = i + 1; j < players.length; j++)
      carCollide(players[i], players[j]);

  // ---- Collisions balle/voiture ----
  players.forEach(p => ballCollide(p, room.ball));

  // ---- Physique balle ----
  const b = room.ball;
  const bfric = Math.pow(0.993, dt * 60);
  b.vx *= bfric; b.vy *= bfric;
  b.x += b.vx * dt; b.y += b.vy * dt;

  if (b.y - b.r < FIELD_Y1) { b.y = FIELD_Y1 + b.r; b.vy = Math.abs(b.vy) * BNC; }
  if (b.y + b.r > FIELD_Y2) { b.y = FIELD_Y2 - b.r; b.vy = -Math.abs(b.vy) * BNC; }

  if (b.x - b.r < FIELD_X1) {
    if (b.y > GY1 && b.y < GY2) { room.scoreB++; handleGoal(room, 1); return; }
    b.x = FIELD_X1 + b.r; b.vx = Math.abs(b.vx) * BNC;
  }
  if (b.x + b.r > FIELD_X2) {
    if (b.y > GY1 && b.y < GY2) { room.scoreA++; handleGoal(room, 0); return; }
    b.x = FIELD_X2 - b.r; b.vx = -Math.abs(b.vx) * BNC;
  }

  // ---- Broadcast ~20fps ----
  room._btick = (room._btick || 0) + 1;
  if (room._btick % 3 === 0) broadcastState(room);
}

function handleGoal(room, scoringTeam) {
  room.paused = true;
  broadcast(room, { type: 'GOAL', team: scoringTeam, scoreA: room.scoreA, scoreB: room.scoreB });
  // Reset positions visible rapidement
  setTimeout(() => {
    if (!rooms[room.id]) return;
    resetBall(room); resetPlayers(room); broadcastState(room);
  }, 300);
  // Reprendre à 5000ms — aligné avec le client: 1800ms BUT + 3200ms countdown
  setTimeout(() => {
    if (!rooms[room.id]) return;
    room.paused = false;
    room._lastTick = Date.now(); // évite un saut dt après la pause
    broadcastState(room);
  }, 5000);
}

function broadcastState(room) {
  const msg = {
    type: 'GAME_STATE',
    t: room.timeLeft,
    sA: room.scoreA, sB: room.scoreB,
    b: { x: room.ball.x, y: room.ball.y, vx: room.ball.vx, vy: room.ball.vy },
    p: Object.values(room.players).map(p => ({
      id: p.id, nm: p.name, tm: p.team,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      a: p.angle, bst: p.boost,
      c1: p.c1, c2: p.c2, md: p.model || 0, ws: p.wheelStyle || 0
    }))
  };
  broadcast(room, msg);
}

// =====================================================================
// WEBSOCKET
// =====================================================================
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  let roomId = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // --- Créer une room ---
    if (msg.type === 'CREATE_SERVER') {
      const id = Math.random().toString(36).slice(2, 8).toUpperCase();
      rooms[id] = {
        id, map: msg.map ?? 0, time: msg.time ?? 180,
        players: {}, ball: createBall(),
        scoreA: 0, scoreB: 0, timeLeft: msg.time ?? 180,
        started: false, paused: false, ticker: null,
        _gameOverSent: false, _btick: 0, _lastTick: Date.now()
      };
      rooms[id].players[playerId] = mkPlayer(playerId, ws, msg.name, 0, msg);
      roomId = id;
      send(ws, { type: 'SERVER_CREATED', serverId: id, playerId });
    }

    // --- Rejoindre ---
    if (msg.type === 'JOIN_SERVER') {
      const room = rooms[msg.serverId];
      if (!room)  { send(ws, { type: 'ERROR', msg: 'Serveur introuvable' }); return; }
      if (Object.keys(room.players).length >= 4) { send(ws, { type: 'ERROR', msg: 'Serveur plein (4/4)' }); return; }
      if (room.started) { send(ws, { type: 'ERROR', msg: 'Partie déjà en cours' }); return; }
      const team = Object.keys(room.players).length % 2;
      room.players[playerId] = mkPlayer(playerId, ws, msg.name, team, msg);
      roomId = msg.serverId;
      send(ws, { type: 'JOINED', serverId: roomId, map: room.map, time: room.time, playerId, team });
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }

    // --- Lancer la partie ---
    if (msg.type === 'LAUNCH') {
      const room = rooms[roomId];
      if (!room) return;
      room.started = true; room.timeLeft = room.time;
      room.scoreA = 0; room.scoreB = 0;
      room._gameOverSent = false; room._btick = 0; room._lastTick = Date.now();
      resetBall(room); resetPlayers(room);
      broadcast(room, {
        type: 'GAME_START', map: room.map, time: room.time,
        players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, team: p.team }))
      });
      if (room.ticker) clearInterval(room.ticker);
      room.ticker = setInterval(() => tickRoom(room), TICK_MS);
    }

    // --- Config hôte ---
    if (msg.type === 'HOST_CONFIG') {
      const room = rooms[roomId];
      if (!room) return;
      if (msg.map  !== undefined) room.map  = msg.map;
      if (msg.time !== undefined) { room.time = msg.time; room.timeLeft = msg.time; }
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }

    // --- Inputs joueur (envoyés ~30fps) ---
    // Ping/pong latency
    if (msg.type === 'PING') { send(ws, { type: 'PONG' }); return; }

    if (msg.type === 'INPUT') {
      const room = rooms[roomId];
      if (!room || !room.players[playerId]) return;
      const p = room.players[playerId];
      p.input = msg.i || {};
      // Synchro skin (toutes les N frames)
      if (msg.c1) p.c1 = msg.c1;
      if (msg.c2) p.c2 = msg.c2;
      if (msg.md !== undefined) p.model     = msg.md;
      if (msg.ws !== undefined) p.wheelStyle = msg.ws;
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const leavingPlayer = room.players[playerId];
    const wasStarted = room.started;

    delete room.players[playerId];

    if (Object.keys(room.players).length === 0) {
      // Plus personne — supprimer la room
      if (room.ticker) clearInterval(room.ticker);
      delete rooms[roomId];
    } else if (wasStarted) {
      // Partie en cours : arrêter le jeu, les survivants gagnent par forfait
      if (room.ticker) { clearInterval(room.ticker); room.ticker = null; }
      room.started = false;
      room._gameOverSent = true;
      broadcast(room, {
        type: 'PLAYER_LEFT',
        playerId,
        name: leavingPlayer ? leavingPlayer.name : 'Adversaire',
        scoreA: room.scoreA,
        scoreB: room.scoreB
      });
    } else {
      // En lobby — juste mettre à jour la liste
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }
  });

  ws.on('error', err => console.error(`[WS ERR] ${err.message}`));
});

// ---- Helpers ----
function mkPlayer(id, ws, name, team, msg) {
  return {
    id, ws, name: (name || 'Joueur').slice(0, 18), team,
    x: team === 0 ? 0.28 : 0.72, y: FIELD_CY, vx: 0, vy: 0,
    angle: team === 1 ? Math.PI : 0, boost: 0.8, input: {},
    c1: msg?.c1 || '#1a6fff', c2: msg?.c2 || '#ff6b00',
    model: msg?.model || 0, wheelStyle: msg?.wheelStyle || 0
  };
}
function send(ws, msg)      { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(room, m) { Object.values(room.players).forEach(p => send(p.ws, m)); }
function getPlayerList(r)   { return Object.values(r.players).map(p => ({ id: p.id, name: p.name, team: p.team })); }

// ---- Nettoyage rooms vides ----
setInterval(() => {
  Object.keys(rooms).forEach(id => {
    if (Object.keys(rooms[id].players).length === 0) {
      if (rooms[id].ticker) clearInterval(rooms[id].ticker);
      delete rooms[id];
    }
  });
}, 5 * 60 * 1000);

// ---- Keep-alive WebSocket (évite coupure Railway/Render) ----
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  });
}, 25000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Serveur lancé — port ${PORT}`));
