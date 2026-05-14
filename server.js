const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 托管 public 文件夹里的静态文件
app.use(express.static('public'));

// ---------- 游戏状态 ----------
const WIN_SCORE = 5;
let lightOn = false;
let score1 = 0;
let score2 = 0;
let timeoutId = null;
let gameEnded = false;
let messageText = '等待对手连接...';

function broadcastState() {
  io.emit('game_state', {
    lightOn,
    score1,
    score2,
    gameEnded,
    message: messageText
  });
}

function scheduleLight() {
  if (gameEnded) return;
  const delay = 2000 + Math.random() * 3000;
  timeoutId = setTimeout(() => {
    if (gameEnded) return;
    lightOn = true;
    messageText = '💡 灯亮了！！快拍！';
    broadcastState();

    timeoutId = setTimeout(() => {
      if (lightOn && !gameEnded) {
        lightOn = false;
        messageText = '⏰ 没人拍，重新亮灯...';
        broadcastState();
        scheduleLight();
      }
    }, 5000);
  }, delay);
}

function playerScores(player) {
  if (gameEnded) return;
  if (!lightOn) return;   // 灯没亮，忽略

  lightOn = false;
  clearTimeout(timeoutId);

  if (player === 1) {
    score1++;
    messageText = '🎉 玩家1 拍中！';
  } else {
    score2++;
    messageText = '🎉 玩家2 拍中！';
  }

  if (score1 >= WIN_SCORE) {
    gameEnded = true;
    messageText = '🏆 玩家1 获胜！';
  } else if (score2 >= WIN_SCORE) {
    gameEnded = true;
    messageText = '🏆 玩家2 获胜！';
  }

  broadcastState();
  if (!gameEnded) scheduleLight();
}

// ---------- Socket.IO 连接处理 ----------
io.on('connection', (socket) => {
  console.log('新连接：' + socket.id);

  // 分配角色：先连的是玩家1，第二个是玩家2
  const count = io.sockets.sockets.size;
  let role = 0;
  if (count === 1) role = 1;
  else if (count === 2) role = 2;
  else role = 0; // 旁观

  socket.emit('your_role', role);

  // 如果两个人到齐，开始游戏
  if (count === 2) {
    score1 = 0; score2 = 0;
    lightOn = false;
    gameEnded = false;
    messageText = '两名玩家到齐，准备开始！';
    broadcastState();
    scheduleLight();
  }

  // 发送当前状态给新连上的玩家
  socket.emit('game_state', {
    lightOn, score1, score2, gameEnded, message: messageText
  });

  // 收到拍灯
  socket.on('slap', (player) => {
    playerScores(player);
  });

  // 断开处理
  socket.on('disconnect', () => {
    console.log('玩家断开');
    gameEnded = true;
    clearTimeout(timeoutId);
    messageText = '对手断开，等待重连...';
    broadcastState();
  });
});

// ---------- 启动服务器 ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`裁判就位，端口：${PORT}`);
});