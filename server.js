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

// =====================================================
// PHYSIQUE 100% SERVEUR — coordonnées normalisées 0→1
// Vitesses en unités/seconde
// =====================================================
const GOAL_H  = 0.30;
const BALL_R  = 0.030;
const CAR_W   = 0.09;
const CAR_H   = 0.058;
const CAR_R   = Math.max(CAR_W, CAR_H) * 0.46;
const SPD     = 0.30;
const FRIC_PS = 0.82;   // friction par seconde
const BNC     = 0.62;
const TICK_MS = 1000 / 60;

const rooms = {};

function createBall() {
  const angle = (Math.random() > 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.8;
  return { x: 0.5, y: 0.5, vx: Math.cos(angle) * 0.22, vy: Math.sin(angle) * 0.18, r: BALL_R };
}

function resetBall(room) { room.ball = createBall(); }

function resetPlayers(room) {
  Object.values(room.players).forEach(p => {
    p.x = p.team === 0 ? 0.22 : 0.78;
    p.y = 0.5; p.vx = 0; p.vy = 0;
    p.angle = p.team === 1 ? Math.PI : 0;
  });
}

function ballCollide(car, ball) {
  const dx = ball.x - car.x, dy = ball.y - car.y;
  const dist = Math.sqrt(dx*dx + dy*dy) || 0.001;
  const minD = BALL_R + CAR_R;
  if (dist >= minD) return;
  const nx = dx/dist, ny = dy/dist;
  const rvx = ball.vx - car.vx, rvy = ball.vy - car.vy;
  const dot = rvx*nx + rvy*ny;
  if (dot < 0) {
    const carSpd = Math.sqrt(car.vx*car.vx + car.vy*car.vy);
    const imp = -dot * 1.6 + carSpd * 0.5 + 0.12;
    ball.vx += nx*imp; ball.vy += ny*imp;
  }
  ball.x = car.x + nx*(minD + 0.002);
  ball.y = car.y + ny*(minD + 0.002);
}

function tickRoom(room) {
  if (!room.started || room.paused) return;
  const dt = TICK_MS / 1000;

  // Timer
  room.timeLeft -= dt;
  if (room.timeLeft <= 0) {
    room.timeLeft = 0;
    room.started = false;
    clearInterval(room.ticker);
    broadcast(room, { type: 'GAME_OVER', scoreA: room.scoreA, scoreB: room.scoreB });
    return;
  }

  // Joueurs
  Object.values(room.players).forEach(p => {
    const inp = p.input || {};
    const boosting = inp.boost && p.boost > 0;
    const spd = SPD * (boosting ? 1.88 : 1.0);
    p.boost = boosting ? Math.max(0, p.boost - dt*0.55) : Math.min(1, p.boost + dt*0.18);

    let ax = 0, ay = 0;
    if (inp.up)    ay -= 1;
    if (inp.down)  ay += 1;
    if (inp.left)  ax -= 1;
    if (inp.right) ax += 1;
    const al = Math.sqrt(ax*ax + ay*ay) || 1;
    p.vx += (ax/al) * spd * dt * 5.0;
    p.vy += (ay/al) * spd * dt * 5.0;

    const fric = Math.pow(FRIC_PS, dt);
    p.vx *= fric; p.vy *= fric;

    const ps = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
    if (ps > spd) { p.vx = p.vx/ps*spd; p.vy = p.vy/ps*spd; }
    if (ps > 0.005) p.angle = Math.atan2(p.vy, p.vx);
    p.x += p.vx * dt; p.y += p.vy * dt;

    const mx = CAR_W/2, my = CAR_H/2;
    if (p.x < mx)   { p.x = mx;   p.vx =  Math.abs(p.vx)*0.3; }
    if (p.x > 1-mx) { p.x = 1-mx; p.vx = -Math.abs(p.vx)*0.3; }
    if (p.y < my)   { p.y = my;   p.vy =  Math.abs(p.vy)*0.3; }
    if (p.y > 1-my) { p.y = 1-my; p.vy = -Math.abs(p.vy)*0.3; }
  });

  // Collisions balle
  Object.values(room.players).forEach(p => ballCollide(p, room.ball));

  // Physique balle
  const b = room.ball;
  const bfric = Math.pow(0.994, dt*60);
  b.vx *= bfric; b.vy *= bfric;
  b.x += b.vx * dt; b.y += b.vy * dt;

  if (b.y - b.r < 0)   { b.y = b.r;     b.vy =  Math.abs(b.vy)*BNC; }
  if (b.y + b.r > 1)   { b.y = 1-b.r;   b.vy = -Math.abs(b.vy)*BNC; }

  const gy1 = 0.5 - GOAL_H/2, gy2 = 0.5 + GOAL_H/2;

  if (b.x - b.r < 0) {
    if (b.y > gy1 && b.y < gy2) { room.scoreB++; handleGoal(room, 1); return; }
    b.x = b.r; b.vx = Math.abs(b.vx)*BNC;
  }
  if (b.x + b.r > 1) {
    if (b.y > gy1 && b.y < gy2) { room.scoreA++; handleGoal(room, 0); return; }
    b.x = 1-b.r; b.vx = -Math.abs(b.vx)*BNC;
  }

  room._btick = (room._btick||0) + 1;
  if (room._btick % 2 === 0) broadcastState(room); // ~30fps
}

function handleGoal(room, team) {
  room.paused = true;
  broadcast(room, { type: 'GOAL', team, scoreA: room.scoreA, scoreB: room.scoreB });
  setTimeout(() => {
    if (!rooms[room.id]) return;
    resetBall(room);
    resetPlayers(room);
    room.paused = false;
    broadcastState(room);
  }, 3500);
}

function broadcastState(room) {
  broadcast(room, {
    type: 'GAME_STATE',
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, team: p.team,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      angle: p.angle, boost: p.boost,
      c1: p.c1, c2: p.c2, model: p.model||0, wheelStyle: p.wheelStyle||0
    })),
    ball: { x: room.ball.x, y: room.ball.y, vx: room.ball.vx, vy: room.ball.vy },
    scoreA: room.scoreA, scoreB: room.scoreB, timeLeft: room.timeLeft
  });
}

// =====================================================
// WEBSOCKET
// =====================================================
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  let roomId = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'CREATE_SERVER') {
      const id = Math.random().toString(36).slice(2,8).toUpperCase();
      rooms[id] = {
        id, map: msg.map??0, time: msg.time??180,
        players: {}, ball: createBall(),
        scoreA:0, scoreB:0, timeLeft: msg.time??180,
        started:false, paused:false, ticker:null
      };
      rooms[id].players[playerId] = mkPlayer(playerId, ws, msg.name, 0, msg);
      roomId = id;
      send(ws, { type:'SERVER_CREATED', serverId:id, playerId });
    }

    if (msg.type === 'JOIN_SERVER') {
      const room = rooms[msg.serverId];
      if (!room)  { send(ws, {type:'ERROR', msg:'Serveur introuvable'}); return; }
      if (Object.keys(room.players).length >= 4) { send(ws, {type:'ERROR', msg:'Serveur plein'}); return; }
      if (room.started) { send(ws, {type:'ERROR', msg:'Partie en cours'}); return; }
      const team = Object.keys(room.players).length % 2;
      room.players[playerId] = mkPlayer(playerId, ws, msg.name, team, msg);
      roomId = msg.serverId;
      send(ws, { type:'JOINED', serverId:roomId, map:room.map, time:room.time, playerId, team });
      broadcast(room, { type:'ROOM_UPDATE', players:getPlayerList(room), map:room.map, time:room.time });
    }

    if (msg.type === 'LAUNCH') {
      const room = rooms[roomId];
      if (!room) return;
      room.started=true; room.timeLeft=room.time; room.scoreA=0; room.scoreB=0;
      resetBall(room); resetPlayers(room);
      broadcast(room, {
        type:'GAME_START', map:room.map, time:room.time,
        players: Object.values(room.players).map(p=>({id:p.id, name:p.name, team:p.team}))
      });
      room.ticker = setInterval(()=>tickRoom(room), TICK_MS);
    }

    if (msg.type === 'HOST_CONFIG') {
      const room = rooms[roomId];
      if (!room) return;
      if (msg.map  !== undefined) room.map = msg.map;
      if (msg.time !== undefined) { room.time=msg.time; room.timeLeft=msg.time; }
      broadcast(room, { type:'ROOM_UPDATE', players:getPlayerList(room), map:room.map, time:room.time });
    }

    if (msg.type === 'INPUT') {
      const room = rooms[roomId];
      if (!room || !room.players[playerId]) return;
      const p = room.players[playerId];
      p.input = msg.input || {};
      if (msg.c1) p.c1=msg.c1;
      if (msg.c2) p.c2=msg.c2;
      if (msg.model!==undefined) p.model=msg.model;
      if (msg.wheelStyle!==undefined) p.wheelStyle=msg.wheelStyle;
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    delete room.players[playerId];
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.ticker);
      delete rooms[roomId];
    } else {
      broadcast(room, { type:'ROOM_UPDATE', players:getPlayerList(room), map:room.map, time:room.time });
    }
  });

  ws.on('error', err => console.error(`[ERR] ${err.message}`));
});

function mkPlayer(id, ws, name, team, msg) {
  return {
    id, ws, name: name||'Joueur', team,
    x: team===0?0.22:0.78, y:0.5, vx:0, vy:0,
    angle: team===1?Math.PI:0, boost:0.8, input:{},
    c1: msg?.c1||'#1a6fff', c2: msg?.c2||'#ff6b00',
    model: msg?.model||0, wheelStyle: msg?.wheelStyle||0
  };
}
function send(ws, msg) { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { Object.values(room.players).forEach(p=>send(p.ws,msg)); }
function getPlayerList(room) { return Object.values(room.players).map(p=>({id:p.id,name:p.name,team:p.team})); }

setInterval(()=>{
  Object.keys(rooms).forEach(id=>{
    if(Object.keys(rooms[id].players).length===0){ clearInterval(rooms[id].ticker); delete rooms[id]; }
  });
}, 10*60*1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, ()=>console.log(`✅ Serveur lancé sur port ${PORT}`));
