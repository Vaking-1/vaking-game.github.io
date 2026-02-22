const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

const SPD = 0.30;
const BOOST_MULT = 1.35;
const ACCEL = 3.0;
const FRICTION = 0.85;
const BOUNCE = 0.7;
const GOAL_HEIGHT = 0.3;

const rooms = {};

function createBall() {
  const angle = Math.random() * Math.PI * 2;
  return {
    x: 0.5,
    y: 0.5,
    vx: Math.cos(angle) * 0.2,
    vy: Math.sin(angle) * 0.2,
    r: 0.03
  };
}

function createPlayer(id, ws, name, team) {
  return {
    id,
    ws,
    name,
    team,
    x: team === 0 ? 0.3 : 0.7,
    y: 0.5,
    vx: 0,
    vy: 0,
    angle: 0,
    boost: 1,
    input: {}
  };
}

function broadcast(room, data) {
  Object.values(room.players).forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(data));
    }
  });
}

function tick(room) {
  if (!room.started) return;

  const dt = 1 / TICK_RATE;

  room.timeLeft -= dt;
  if (room.timeLeft <= 0) {
    room.timeLeft = 0;
    room.started = false;
    clearInterval(room.loop);
    room.loop = null;
    broadcast(room, { type: 'GAME_OVER', scoreA: room.scoreA, scoreB: room.scoreB });
    return;
  }

  Object.values(room.players).forEach(p => {
    const inp = p.input;
    let ax = 0, ay = 0;

    if (inp.up) ay -= 1;
    if (inp.down) ay += 1;
    if (inp.left) ax -= 1;
    if (inp.right) ax += 1;

    const len = Math.hypot(ax, ay) || 1;
    const boosting = inp.boost && p.boost > 0;
    const speed = SPD * (boosting ? BOOST_MULT : 1);

    p.vx += (ax / len) * speed * dt * ACCEL;
    p.vy += (ay / len) * speed * dt * ACCEL;

    p.vx *= FRICTION;
    p.vy *= FRICTION;

    const max = speed;
    const vel = Math.hypot(p.vx, p.vy);
    if (vel > max) {
      p.vx = (p.vx / vel) * max;
      p.vy = (p.vy / vel) * max;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    p.x = Math.max(0.1, Math.min(0.9, p.x));
    p.y = Math.max(0.15, Math.min(0.85, p.y));

    if (vel > 0.01) p.angle = Math.atan2(p.vy, p.vx);

    if (boosting) {
      p.boost = Math.max(0, p.boost - dt * 0.5);
    } else {
      p.boost = Math.min(1, p.boost + dt * 0.2);
    }
  });

  const b = room.ball;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  b.vx *= 0.995;
  b.vy *= 0.995;

  if (b.y < 0.15 || b.y > 0.85) b.vy *= -BOUNCE;

  const goalTop = 0.5 - GOAL_HEIGHT / 2;
  const goalBottom = 0.5 + GOAL_HEIGHT / 2;

  if (b.x < 0.1) {
    if (b.y > goalTop && b.y < goalBottom) {
      room.scoreB++;
      reset(room);
      return;
    }
    b.vx *= -BOUNCE;
  }

  if (b.x > 0.9) {
    if (b.y > goalTop && b.y < goalBottom) {
      room.scoreA++;
      reset(room);
      return;
    }
    b.vx *= -BOUNCE;
  }

  broadcast(room, {
    type: 'GAME_STATE',
    players: Object.values(room.players),
    ball: room.ball,
    scoreA: room.scoreA,
    scoreB: room.scoreB,
    timeLeft: room.timeLeft
  });
}

function reset(room) {
  room.ball = createBall();
  Object.values(room.players).forEach(p => {
    p.x = p.team === 0 ? 0.3 : 0.7;
    p.y = 0.5;
    p.vx = 0;
    p.vy = 0;
  });
}

wss.on('connection', ws => {
  const playerId = uuidv4();
  let currentRoom = null;

  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    if (msg.type === 'CREATE') {
      const id = Math.random().toString(36).slice(2, 6).toUpperCase();
      rooms[id] = {
        id,
        players: {},
        ball: createBall(),
        scoreA: 0,
        scoreB: 0,
        timeLeft: 180,
        started: false
      };
      currentRoom = rooms[id];
      currentRoom.players[playerId] = createPlayer(playerId, ws, msg.name, 0);
      ws.send(JSON.stringify({ type: 'CREATED', id }));
    }

    if (msg.type === 'JOIN') {
      const room = rooms[msg.id];
      if (!room) return;
      currentRoom = room;
      const team = Object.keys(room.players).length % 2;
      room.players[playerId] = createPlayer(playerId, ws, msg.name, team);
    }

    if (msg.type === 'START') {
      currentRoom.started = true;
      currentRoom.timeLeft = 180;
      currentRoom.loop = setInterval(() => tick(currentRoom), TICK_MS);
    }

    if (msg.type === 'INPUT') {
      if (!currentRoom) return;
      const p = currentRoom.players[playerId];
      if (p) p.input = msg.input;
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      delete currentRoom.players[playerId];
    }
  });
});

server.listen(process.env.PORT || 3000);
