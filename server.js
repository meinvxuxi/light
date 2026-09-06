const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  allowEIO3: true,
  pingTimeout: 30000,
  pingInterval: 10000,
});

// 开发期禁用缓存：保证页面/脚本改动后刷新即为最新（避免“已修复但仍看到旧效果”）
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

const HEARTBEAT_TIMEOUT = 30000;

const VALID_KEYS = {
  'aaaa': '玩家1',
  'bbbb': '玩家2',
  'cccc': '玩家3',
  'dddd': '玩家4',
  'test1': '测试者1',
  'test2': '测试者2',
  'test3': '测试者3',
  'test4': '测试者4'
};
const TEST_NAMES = ['测试者1', '测试者2', '测试者3', '测试者4']; // 测试账号（开发者工具/数据跳过落盘用）
const OFFICIAL_PLAYERS = Object.values(VALID_KEYS);
const GUEST_KEY = '12345'; // 🎒 游客通道口令（暂定，之后可改；防外人随意进入游客区）

const onlineUsers = new Map();
const socketToUser = new Map();
const userLastOnline = new Map();
const userLastHeartbeat = new Map();

const GAME_ROOMS = {
  yahtzee: {
    roomId: 'yahtzee_001',
    gameType: 'yahtzee',
    hostName: null,
    maxPlayers: 4,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  },
  drawing: {
    roomId: 'drawing_001',
    gameType: 'drawing',
    hostName: null,
    maxPlayers: 4,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  },
  light: {
    roomId: 'light_001',
    gameType: 'light',
    hostName: null,
    maxPlayers: 4,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  }
};

const offlineTimers = new Map();
const gameEndTimers = {}; // roomId -> 结算后自动清理对局的定时器（防止误删新开对局）

// ========== 成就系统：集中式成就总管 ==========
const DATA_DIR = path.join(__dirname, 'data');
const ACH_FILE = path.join(DATA_DIR, 'achievements.json');        // 正式玩家成就
const ACH_TEST_FILE = path.join(DATA_DIR, 'test-achievements.json'); // 测试账号成就（不影响正式数据）
const USERS_FILE = path.join(DATA_DIR, 'users.json');              // 正式玩家档案（昵称/主题）
const TIMELINE_FILE = path.join(DATA_DIR, 'timeline.json');        // 时光墙记录（正式玩家比赛+成就时刻）

// ========== 时光墙 ==========
// 持久化模式由环境变量控制（开发默认内存/重启清空；正式部署时设置环境变量 PERSIST_TIMELINE=true 即落盘）
const PERSIST_TIMELINE = process.env.PERSIST_TIMELINE === 'true';
const TIMELINE_MAX = 300;
let timelineEntries = [];

function addTimeline(entry) {
  timelineEntries.push(entry);
  if (timelineEntries.length > TIMELINE_MAX) timelineEntries.shift();
  if (PERSIST_TIMELINE) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TIMELINE_FILE, JSON.stringify(timelineEntries, null, 2));
    } catch (e) { console.error('❌ 时光墙写入失败：', e.message); }
  }
}
// 玩家是否为"可入时光墙"的正式账号
function isOfficialPlayer(name) { return OFFICIAL_ACCOUNT_NAMES.includes(name); }

// ===== 成就头衔 =====
// 头衔按品质逐步解锁：解锁含 common 即得「快艇新秀」，再含 rare 得「快艇好手」……（可累积多个）；
// 仅 hidden 成就时兜底得「快艇怪人」。
// 展示：玩家可在"已解锁头衔"里自由选择（档案 usersData.title 存档）；未选择 = 自动显示最高已解锁。
const ACH_TITLES = { common: '快艇新秀', rare: '快艇好手', epic: '快艇高手', legend: '快艇大师', hidden: '快艇怪人' };
const ACH_TITLE_ORDER = ['common', 'rare', 'epic', 'legend'];
// 该玩家当前已解锁的可选头衔（低→高；测试账号按自己内存中的测试成就算）
function playerUnlockedTitles(name) {
  if (!OFFICIAL_ACCOUNT_NAMES.includes(name) && !TEST_NAMES.includes(name)) return [];
  const records = isTestAccount(name) ? achTestRecords : achRecords;
  const qs = records
    .filter(r => r.playerName === name)
    .map(r => ACHIEVEMENTS[r.achievementId] && ACHIEVEMENTS[r.achievementId].quality)
    .filter(Boolean);
  if (!qs.length) return [];
  const out = [];
  for (const q of ACH_TITLE_ORDER) if (qs.includes(q)) out.push(ACH_TITLES[q]);
  if (qs.includes('hidden')) out.push(ACH_TITLES.hidden); // 触发隐藏成就也解锁「快艇怪人」
  return out;
}
// 当前实际展示的头衔：玩家手动选择了某个已解锁头衔才展示；默认不佩戴
function playerTitle(name) {
  const unlocked = playerUnlockedTitles(name);
  if (!unlocked.length) return '';
  const choice = usersData[name] && usersData[name].title;
  return (choice && unlocked.includes(choice)) ? choice : '';
}

// ===== 个人空间战绩统计（依据时光墙比赛记录） =====
// filter 可选：仅统计满足条件的对局（如指定游戏/模式）
function summarizeProfileStats(name, filter) {
  let games = 0, wins = 0, totalScore = 0, best = 0;
  for (const e of timelineEntries) {
    if (e.type !== 'game') continue;
    const my = (e.results || []).find(r => r.name === name);
    if (!my) continue;
    if (filter && !filter(e)) continue;
    games++;
    totalScore += my.score;
    if (my.score > best) best = my.score;
    if (my.rank === 1) wins++;
  }
  return { games, wins, winRate: games ? Math.round(wins / games * 100) : 0, totalScore, best };
}
// 某玩家参与的时光墙对局里出现过的游戏，及其各模式（人数）统计
function buildProfileByGame(name) {
  const games = {};   // gameKey -> { 模式key -> {..} }
  const order = [];
  for (const e of timelineEntries) {
    if (e.type !== 'game') continue;
    const my = (e.results || []).find(r => r.name === name);
    if (!my) continue;
    const gk = e.game || 'other';
    if (!games[gk]) { games[gk] = {}; order.push(gk); }
    const mk = (e.totalPlayers ? `${e.totalPlayers}人` : '普通');
    const m = games[gk][mk] || { games: 0, wins: 0, totalScore: 0, best: 0 };
    m.games++;
    m.totalScore += my.score;
    if (my.score > m.best) m.best = my.score;
    if (my.rank === 1) m.wins++;
    games[gk][mk] = m;
  }
  return order.map(gk => ({
    game: gk,
    modes: Object.keys(games[gk])
      .map(mode => { const s = games[gk][mode]; return { mode, games: s.games, wins: s.wins, winRate: s.games ? Math.round(s.wins / s.games * 100) : 0, totalScore: s.totalScore, best: s.best }; })
      .sort((a, b) => { const na = parseInt(a.mode, 10) || Infinity; const nb = parseInt(b.mode, 10) || Infinity; return na - nb; })
  }));
}

// ===== 快艇排行榜：单局最高分（正式/测试/游客的真实对局都会记录；开发期内存，重启清空） =====
let highScoreBoard = new Map(); // 玩家名 -> 单局最高总分
function recordHighScores(totals) {
  if (!totals) return;
  for (const [name, t] of Object.entries(totals)) {
    if (!t || typeof t.total !== 'number') continue;
    const cur = highScoreBoard.get(name) || 0;
    if (t.total > cur) highScoreBoard.set(name, t.total);
  }
}

// ===== 测试个人空间：仅测试者自己可见的模拟战绩（内存种子，方便预览页面，无需真实打局） =====
const testProfileSeeds = new Map();
function seedTestProfile(name) {
  const byGame = [{
    game: 'yahtzee',
    modes: [
      { mode: '2人', games: 2, wins: 1, winRate: 50, totalScore: 486, best: 312 },
      { mode: '3人', games: 3, wins: 2, winRate: 67, totalScore: 980, best: 336 },
      { mode: '4人', games: 1, wins: 0, winRate: 0, totalScore: 278, best: 278 }
    ]
  }];
  const totals = { games: 6, wins: 3, winRate: 50, totalScore: 1744, best: 336 };
  testProfileSeeds.set(name, { totals, byGame });
  return { totals, byGame };
}

// 正式玩家档案（内存态 + users.json 落盘）：开发期也落盘，便于测试改昵称/主题
let usersData = {};
const THEMES = ['initial', 'p1', 'p2', 'p3', 'p4', 'pomelo']; // 已知主题集合
// 专属主题归属：每位正式玩家可拥有 1~N 个素材主题（玩家3 现拥有 摸鱼ing=p3 与 pomelo 两套）；测试账号可体验 p1
const OWNER_THEMES = { '玩家1': ['p1'], '玩家2': ['p2'], '玩家3': ['p3', 'pomelo'], '玩家4': ['p4'] };

// ⚙️ 持久化开关（环境变量控制）：默认开发/测试期=false（成就只存内存，重启即刷新、不写 data/）；
// 正式部署时设置环境变量 PERSIST_ACHIEVEMENTS=true，即自动恢复"读入 + 写入 data/ 文件"。
const PERSIST_ACHIEVEMENTS = process.env.PERSIST_ACHIEVEMENTS === 'true';

// 成就定义：id -> { name, quality, game }
const ACHIEVEMENTS = {
  yahtzee_roll:     { name: 'Yahtzee！',        quality: 'common', game: 'yahtzee' },
  upper_bonus:      { name: '上层建筑',          quality: 'common', game: 'yahtzee' },
  slow_fill:        { name: '龟速填分',          quality: 'common', game: 'yahtzee' },
  reroll_master:    { name: '重掷大师',          quality: 'common', game: 'yahtzee' },
  fullhouse_brothers: { name: '葫芦兄弟',        quality: 'rare', game: 'yahtzee' },
  score_250:        { name: '250来袭！',         quality: 'rare', game: 'yahtzee' },
  same_score:       { name: '同分异构',          quality: 'rare', game: 'yahtzee' },
  score_300:        { name: '快艇领域大神',       quality: 'epic', game: 'yahtzee' },
  seat_full:        { name: '座无虚席',          quality: 'epic', game: 'yahtzee' },
  yahtzee_twice:    { name: '？！艇艇！？',       quality: 'epic', game: 'yahtzee' },
  first_roll:       { name: '一发入魂',          quality: 'legend', game: 'yahtzee' },
  low_score:        { name: '认真的吗？',        quality: 'hidden', game: 'yahtzee' }
};
const ACH_QUALITY_NO = { common: 1, rare: 2, epic: 3, legend: 4, hidden: 5 };

// 内存中的成就记录（启动时从 data/ 读入）
let achRecords = [];
let achTestRecords = [];

function isTestAccount(name) { return !!name && name.startsWith('测试者'); }

function loadAchRecords(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; }
  catch (e) { return fallback; }
}
function saveAchRecords(file, list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (e) { console.error('❌ 成就写入失败：', e.message); }
}

// 记录一次成就（正式玩家 -> achievements.json；测试账号 -> test-achievements.json）
function recordAchievement(playerName, achievementId) {
  const isTest = isTestAccount(playerName);
  const file = isTest ? ACH_TEST_FILE : ACH_FILE;
  const list = isTest ? achTestRecords : achRecords;
  const now = Date.now();
  const rec = list.find(r => r.achievementId === achievementId && r.playerName === playerName);
  if (rec) {
    rec.count++;
    rec.lastTime = now;
    // 历史明细：每次触发时间（旧数据无 events 则忽略，新触发开始累积）
    if (rec.events) rec.events.push(now);
  } else {
    list.push({
      achievementId,
      playerName,
      count: 1,
      firstTime: now,
      lastTime: now,
      events: [now],                 // 荣誉墙"▸ 展开每次触发时间"用
      highestTier: ACH_QUALITY_NO[ACHIEVEMENTS[achievementId]?.quality] || 1
    });
  }
  if (isTest) achTestRecords = list; else achRecords = list;
  // 落盘规则：
  //  - 正式玩家：仅在 PERSIST_ACHIEVEMENTS=true 时写 data/achievements.json（开发期只内存）
  //  - 测试账号：永远只存内存（重启即刷新），不写任何文件
  if (!isTest && PERSIST_ACHIEVEMENTS) saveAchRecords(ACH_FILE, achRecords);
}

// 统一解锁入口：记录 + 本局去重播报 + 汇总。
// repeatable=true 表示"同局多次可重复累积次数，但只播报一次"（如每次投出快艇）。
function announceAchievement(game, roomId, playerName, achievementId, repeatable) {
  if (!game || game.mock) return;
  const meta = ACHIEVEMENTS[achievementId];
  if (!meta) return;
  if (!game.achievementsByPlayer) game.achievementsByPlayer = {};
  if (!game.achievementsByPlayer[playerName]) game.achievementsByPlayer[playerName] = [];
  const byPlayer = game.achievementsByPlayer[playerName];
  const already = byPlayer.includes(achievementId);

  if (already && !repeatable) return;          // 一次性成就：本局已拿过就不重复记录
  recordAchievement(playerName, achievementId); // 每次事件都累积次数
  if (!already) {
    byPlayer.push(achievementId);
    // 时光墙：正式玩家每次"新解锁/再次达成"记录一条成就时刻
    if (isOfficialPlayer(playerName)) {
      addTimeline({ ts: Date.now(), type: 'achievement', player: playerName, achievementId, achievementName: meta.name, quality: meta.quality });
    }
  }
  if (already && repeatable) return;           // 已播报过，仅累积次数

  if (meta.quality === 'hidden') return;        // 隐藏成就只进结算汇总，不实时播报
  io.to(roomId).emit('achievement_unlocked', {
    id: achievementId, name: meta.name, quality: meta.quality, playerName
  });
}

// ========== 用户档案（昵称 / 主题） ==========
const OFFICIAL_ACCOUNT_NAMES = ['玩家1', '玩家2', '玩家3', '玩家4']; // 可配置档案的正式账号
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function saveUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
  } catch (e) { console.error('❌ 用户档案写入失败：', e.message); }
}
// 取显示名（设置了昵称则用昵称，否则用原名）
function getDisplayName(name) {
  const u = usersData[name];
  return (u && u.nickname && u.nickname.trim()) ? u.nickname.trim() : name;
}
// 规范昵称：null 表示非法
function normalizeNickname(raw) {
  const n = String(raw || '').trim();
  if (!n) return ''; // 空 = 清除昵称，回到原名
  if (n.length > 12) return null;
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_·\s]{1,12}$/.test(n)) return null;
  return n;
}

// 结算：对每名玩家广播"本局成就汇总"（含即时成就，标明达成玩家）
function broadcastAchievementSummary(roomId, game) {
  if (!game || game.mock) return;
  const byPlayer = game.achievementsByPlayer || {};
  const players = {};
  for (const [name, ids] of Object.entries(byPlayer)) {
    if (!ids || !ids.length) continue;
    players[name] = ids.map(id => ({
      id,
      name: (ACHIEVEMENTS[id] && ACHIEVEMENTS[id].name) || id,
      quality: (ACHIEVEMENTS[id] && ACHIEVEMENTS[id].quality) || 'common'
    }));
  }
  if (Object.keys(players).length) io.to(roomId).emit('achievement_summary', { players });
}

const GAME_URL_MAP = {
  yahtzee: '/yahtzee.html',
  light: '/light.html',
  drawing: '/drawing.html'
};

const yahtzeeGames = {};
const drawingGames = {}; // 画猜接龙（drawing）对局
const drawingAtGame = new Map(); // playerName -> 当前正打开“画猜接龙游戏页”的 socket.id（用于判定谁真正在对局内）
// 通用取"某房间当前进行中的对局"（yahtzee / light / drawing 共用）
function activeGameOf(room) {
  if (!room) return null;
  return room.gameType === 'drawing' ? (drawingGames[room.roomId] || null) : (yahtzeeGames[room.roomId] || null);
}

// ============================================================
// 画猜接龙 v2（四链并行 + 判定/投票版）
// 每轮四条链并行：第1棒写词并画自己词；随后全员同步做第2~4棒；
// 猜词/作画按"上一棒起始链"轮流承接；逐链展示后全员判定(≥3匹配)再 MVP/罪魁投票，按积分排名。
// ============================================================
const DG_STAGES = ['writeDraw', 'guessA', 'picG', 'guessF'];
function dgOwnerAt(order, idx, off) {
  const n = order.length;
  return order[((idx + off) % n + n) % n];
}
function dgInit(roomId, names) {
  const chains = {};
  names.forEach(n => { chains[n] = { word: null, picW: [], guessA: null, picG: [], guessF: null, match: null, matchVotes: 0 }; });
  const game = { gameType: 'drawing', roomId, order: names.slice(), playerOrder: names.slice(), round: 1, chains, points: {}, done: {}, stage: 'writeDraw', reviewIdx: 0, voted: [], chainVotes: [], cancelVotes: [], settled: [] };
  names.forEach(n => { game.points[n] = 0; game.done[n] = false; });
  drawingGames[roomId] = game;
  return game;
}
function dgTarget(g, name, stage) {
  const idx = g.order.indexOf(name);
  if (stage === 'writeDraw') return name;                              // 自己的链（写词+画，一步完成）
  if (stage === 'guessA') return dgOwnerAt(g.order, idx, -1);          // 上一位起始的链
  if (stage === 'picG') return dgOwnerAt(g.order, idx, -2);            // 上上位起始的链
  return dgOwnerAt(g.order, idx, -3);
}
function dgStageText(stage) {
  return {
    writeDraw: '第 1 棒：写一个词并画出来（一步完成）',
    guessA: '第 2 棒：看上一棒（上一位玩家）的画，猜他写的词', picG: '第 3 棒：画出第 2 棒猜到的词',
    guessF: '第 4 棒：看第 3 棒的画，做最后猜词',
    judge: '逐链展示并判定：原词与最终猜词是否匹配', reward: 'MVP / 罪魁投票', result: '本轮结算'
  }[stage] || '';
}
function dgAllDone(g) { return g.order.every(n => !!g.done[n]); }
function dgResetTurn(g) {
  g.done = {}; g.order.forEach(n => { g.done[n] = false; });
  g.voted = [];
}
function dgAdvance(g, room) {
  const idx = DG_STAGES.indexOf(g.stage);
  if (idx >= 0 && idx < DG_STAGES.length - 1) {
    g.stage = DG_STAGES[idx + 1];
    dgResetTurn(g);
  } else if (g.stage === 'guessF') {
    // 全部第 4 棒猜完 → 进入第 1 条链的展示与判定（复位每人状态以便投票）
    g.stage = 'judge'; g.reviewIdx = 0;
    dgResetTurn(g);
  } else if (g.stage === 'judge') {
    // 判定票收齐（match 已算好）→ 该链投 MVP/罪魁
    g.stage = 'reward';
    dgResetTurn(g);
  } else if (g.stage === 'reward') {
    g.reviewIdx++;
    if (g.reviewIdx >= g.order.length) { g.stage = 'result'; }
    else { g.stage = 'judge'; dgResetTurn(g); }
  }
  dgBroadcast(room);
}
function dgVoteFinishMatch(g) {
  if (!dgAllDone(g)) return; // 匹配与否在 4 票收齐后一次性判定
  const owner = g.order[g.reviewIdx];
  const chain = g.chains[owner];
  const matched = (g.voted || []).filter(v => v.choice === true).length;
  chain.match = matched >= 3; // ≥3 人选"匹配"即成功
  chain.matchVotes = matched;
  g.chainVotes[g.reviewIdx] = { match: chain.match, matchedVotes: matched };
}
function dgApplyReward(g) {
  // 本链 4 票收齐后才结算一次（MVP/罪魁投票须全员提交后统一计票）
  if (g.settled[g.reviewIdx] || !dgAllDone(g)) return;
  g.settled[g.reviewIdx] = true;
  // 本链 4 人投票收齐后只结算一次：按被投票数累计（1 票=1，2 票=3，3 票=6）
  const tally = {};
  (g.voted || []).forEach(v => { tally[v.target] = (tally[v.target] || 0) + 1; });
  const chain = g.chains[g.order[g.reviewIdx]] || {};
  const sign = chain.match === true ? 1 : -1;
  for (const [target, n] of Object.entries(tally)) {
    g.points[target] = (g.points[target] || 0) + sign * (n * (n + 1) / 2);
  }
}
// 画猜“在线”= 心跳新鲜 且 该玩家正开着画猜游戏页（在房间页/大厅者不算在线，不阻塞取消）
function dgPlayerOnline(room, n) {
  const hb = userLastHeartbeat.get(n);
  const sid = room.playerMap.get(n);
  return !!(hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && drawingAtGame.get(n) === sid && io.sockets.sockets.has(sid));
}
function dgBroadcast(room) {
  const g = drawingGames[room.roomId];
  if (!g) return;
  const stageText = dgStageText(g.stage);
  const chainOwner = g.order[g.reviewIdx] || null;
  const chain = chainOwner ? (g.chains[chainOwner] || {}) : null;
  const send = (name, view) => {
    const sid = room.playerMap.get(name);
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('dg_state', view);
  };
  const online = {};
  for (const n of g.order) {
    online[n] = dgPlayerOnline(room, n);
  }
  const cancelOnline = g.order.filter(n => online[n]).length;
  for (const name of g.order) {
    const view = {
      gameType: 'drawing', stage: g.stage, stageText, round: g.round,
      points: g.points, order: g.order.slice(), you: name, youReady: !!g.done[name],
      done: g.order.map(n => !!g.done[n]),
      chainIndex: g.reviewIdx, isHost: room.hostName === name,
      online, cancelVotes: (g.cancelVotes || []).slice(), cancelOnline
    };
    if (DG_STAGES.includes(g.stage)) {
      view.target = dgTarget(g, name, g.stage);
      const targetChain = g.chains[view.target] || {};
      if (g.stage === 'guessA') { view.myPic = targetChain.picW || []; view.hintLen = targetChain.word ? [...targetChain.word].length : 0; }
      if (g.stage === 'picG') view.myGuessText = targetChain.guessA;                 // 画第2棒猜的词
      if (g.stage === 'guessF') { view.myPic = targetChain.picG || []; view.hintLen = targetChain.guessA ? [...targetChain.guessA].length : 0; }
    }
    if (g.stage === 'judge' || g.stage === 'reward' || g.stage === 'result') {
      view.chainOwner = chainOwner;
      view.chainData = chain ? { word: chain.word, picW: chain.picW || [], guessA: chain.guessA, picG: chain.picG || [], guessF: chain.guessF, match: chain.match, matchVotes: chain.matchVotes } : null;
      // 链角色：第1棒=写词+画，第2棒=猜，第3棒=画，第4棒=最终猜
      const ownerIdx = chainOwner ? g.order.indexOf(chainOwner) : -1;
      view.chainRoles = chainOwner && ownerIdx >= 0
        ? { writer: chainOwner, guessA: dgOwnerAt(g.order, ownerIdx, 1), drawer: dgOwnerAt(g.order, ownerIdx, 2), guessB: dgOwnerAt(g.order, ownerIdx, 3) }
        : { writer: chainOwner, guessA: '', drawer: '', guessB: '' };
    }
    if (g.stage === 'judge' && !g.done[name]) {
      view.needAction = true;
      view.others = g.order.filter(o => o !== name);
      view.chainOwner = chainOwner;
    }
    if (g.stage === 'reward') {
      view.matched = !!(chain && chain.match === true);
      view.needReward = !g.done[name];
      view.others = g.order.filter(o => o !== name);
      view.chainOwner = chainOwner;
    }
    if (g.stage === 'result') {
      view.finalOrder = g.order.slice().sort((a, b) => (g.points[b] || 0) - (g.points[a] || 0));
      view.chainVotes = g.chainVotes || [];
    }
    send(name, view);
  }
}
// ========== 画猜接龙（drawing）：四人一轮一链，棒次轮转 ==========
// 一轮链条：写词(第1棒·自己画原词) → 猜图(第2棒) → 画猜词(第3棒·看到第2棒猜的词来画) → 猜图(第4棒) → 揭晓对照
// 第2棒猜的是"第1棒的画"，第4棒猜的是"第3棒的画"；成功 = 第4棒猜词 === 第1棒原词。
function drawingRoles(g, round) {
  const n = g.order.length;
  const base = ((round || 1) - 1) % n;
  return {
    writer: g.order[base % n],
    guessA: g.order[(base + 1) % n],
    drawer: g.order[(base + 2) % n],
    guessB: g.order[(base + 3) % n]
  };
}
function drawingStageSeq() {
  return ['word', 'draw1', 'guessA', 'draw2', 'guessB', 'reveal'];
}
function drawingActorFor(g, stage) {
  const roles = drawingRoles(g, g.round);
  if (stage === 'word' || stage === 'draw1') return roles.writer;
  if (stage === 'guessA') return roles.guessA;
  if (stage === 'guessB') return roles.guessB;
  if (stage === 'draw2') return roles.drawer;
  return null;
}
function initDrawingGame(roomId, playerNames) {
  const game = {
    roomId,
    gameType: 'drawing',
    order: playerNames,
    round: 1,
    stage: 'word',
    word: null,
    pic1: [],
    guessA: null,
    pic2: [],
    guessB: null,
    lastReveal: null
  };
  drawingGames[roomId] = game;
  return game;
}
function drawingNorm(s) { return String(s || '').trim().replace(/\s+/g, ''); }
function drawingRoleName(g) {
  const roles = drawingRoles(g, g.round);
  return { writer: roles.writer, guessA: roles.guesser, drawer: roles.drawer, guessB: roles.guesserB };
}
function drawingAdvance(g, room) {
  const seq = drawingStageSeq();
  const idx = seq.indexOf(g.stage);
  g.stage = idx >= 0 && idx < seq.length - 1 ? seq[idx + 1] : g.stage;
  if (g.stage === 'reveal') {
    const normB = drawingNorm(g.guessB);
    const normA = drawingNorm(g.guessA);
    g.lastReveal = {
      word: g.word, guessA: g.guessA, guessB: g.guessB,
      success: !!normB && normB === drawingNorm(g.word),
      firstLink: !!normA && normA === drawingNorm(g.word),
      round: g.round,
      roles: drawingRoles(g, g.round)
    };
  }
  broadcastDrawingState(room);
}
function broadcastDrawingState(room) {
  const g = drawingGames[room.roomId];
  if (!g) return;
  const roles = drawingRoles(g, g.round);
  const stage = g.stage;
  const isReveal = stage === 'reveal';
  const publicText = {
    word: '第 1 棒 · 写词（并画出这个词）',
    draw1: '第 1 棒 · 正在画这个词',
    guessA: '第 2 棒 · 看图猜词',
    draw2: '第 3 棒 · 正在画第 2 棒猜到的词',
    guessB: '第 4 棒 · 看图猜词',
    reveal: '本轮揭晓'
  };
  const sendTo = (name, view) => {
    const sid = room.playerMap.get(name);
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('drawing_update', view);
  };
  for (const name of g.order) {
    const view = {
      gameType: 'drawing',
      round: g.round,
      stage,
      you: name,
      isHost: room.hostName === name,
      roles: { writer: roles.writer, guessA: roles.guessA, drawer: roles.drawer, guessB: roles.guessB },
      stageText: publicText[stage] || '',
      actor: isReveal ? '' : drawingActorFor(g, stage),
      isActor: !isReveal && drawingActorFor(g, stage) === name
    };
    if (isReveal) {
      view.reveal = g.lastReveal || { word: g.word, guessA: g.guessA, guessB: g.guessB, success: false, firstLink: false, round: g.round, roles };
    } else {
      // 分角色保密：只有当前环节需要的可见内容会下发
      view.wordVisible = stage === 'word' || stage === 'draw1';           // 写词/画第一棒：写词者需要词
      if (view.wordVisible && name === roles.writer) view.myWord = g.word;
      if (stage === 'guessA' && name === roles.guessA) view.pic1 = g.pic1;
      if (stage === 'draw2' && name === roles.drawer) view.guessA = g.guessA; // 画第3棒：看到第2棒猜的词
      if (stage === 'guessB' && name === roles.guesserB) view.pic2 = g.pic2;
      // 已完成的中间结果在对应环节只给下一步执行者看（保密传递）
    }
    sendTo(name, view);
  }
  // 观战者：只发进度
  for (const sp of room.spectators) {
    const sid = room.playerMap.get(sp);
    if (sid && io.sockets.sockets.has(sid)) {
      io.to(sid).emit('drawing_update', { gameType: 'drawing', round: g.round, stage, stageText: publicText[stage] || '', spectator: true });
    }
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,0)}-${String(d.getDate()).padStart(2,0)} ${String(d.getHours()).padStart(2,0)}:${String(d.getMinutes()).padStart(2,0)}`;
}

let timer;
function broadcast() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const list = [];
    for (const user of onlineUsers.values()) {
      const isReallyOnline = userLastHeartbeat.has(user.name) && (Date.now() - userLastHeartbeat.get(user.name) < HEARTBEAT_TIMEOUT);
      list.push({ 
        name: user.name, 
        isGuest: user.isGuest, 
        status: isReallyOnline ? '在线' : '离线（无心跳）', 
        lastSeen: user.lastSeen,
        title: playerTitle(user.name)
      });
    }
    for (const [name, ts] of userLastOnline) {
      if (!onlineUsers.has(name)) {
        list.push({ name, isGuest: false, status: `离线 ${formatTime(ts)}`, lastSeen: ts, title: playerTitle(name) });
      }
    }
    io.emit('online_users', list);
  }, 200);
}

function transferHost(room) {
  const seatedPlayers = Object.values(room.seats).filter(Boolean);
  const newHost = seatedPlayers[0]?.name;

  if (newHost && newHost !== room.hostName) {
    room.hostName = newHost;
    io.to(room.roomId).emit('host_changed', { newHost });
    console.log(`🔄 房主自动转移给：${newHost}`);
  } else if (!newHost) {
    room.hostName = null;
    console.log('🔄 房间无玩家，房主清空');
  }
}

function syncRoomState(room, selfName) {
  const mySeat = Object.entries(room.seats).find(([k, v]) => v?.name === selfName)?.[0] || null;
  const nowGame = activeGameOf(room);
  const data = {
    roomId: room.roomId, hostName: room.hostName, maxPlayers: room.maxPlayers,
    seats: room.seats, spectators: room.spectators, mySeat,
    myReady: mySeat ? room.seats[mySeat].ready : false,
    gameStarted: !!nowGame,
    gamePlayers: nowGame ? (nowGame.playerOrder || []) : []
  };
  const sid = room.playerMap.get(selfName);
  if (sid && io.sockets.sockets.has(sid)) {
    io.to(sid).emit('room_update', data);
  }
}

function broadcastRoom(room) {
  transferHost(room);
  const nowGame = activeGameOf(room);
  const gameStarted = !!nowGame;
  const gamePlayers = nowGame ? (nowGame.playerOrder || []) : [];
  io.to(room.roomId).emit('room_update', {
    roomId: room.roomId,
    hostName: room.hostName,
    maxPlayers: room.maxPlayers,
    seats: room.seats,
    spectators: room.spectators,
    gameStarted,
    gamePlayers
  });
  room.playerMap.forEach((_, uname) => {
    const mySeat = Object.entries(room.seats).find(([k, v]) => v?.name === uname)?.[0] || null;
    const sid = room.playerMap.get(uname);
    if (sid && io.sockets.sockets.has(sid)) {
      io.to(sid).emit('room_update', {
        roomId: room.roomId,
        hostName: room.hostName,
        maxPlayers: room.maxPlayers,
        seats: room.seats,
        spectators: room.spectators,
        mySeat,
        myReady: mySeat ? room.seats[mySeat].ready : false,
        gameStarted,
        gamePlayers
      });
    }
  });
}

// ========== 房间重置：当房间里所有玩家（含观战）都离线后，把房间彻底还原成可重新开局的状态 ==========
function resetRoom(room) {
  if (room.playerMap.size > 0) return; // 还有人则不动
  room.maxPlayers = 4;
  room.hostName = null;
  room.seats = { 1: null, 2: null, 3: null, 4: null };
  room.spectators = [];
  room.playerMap.clear();
  for (const k of Object.keys(room.leaveTimers || {})) {
    clearTimeout(room.leaveTimers[k]);
    delete room.leaveTimers[k];
  }
  if (yahtzeeGames[room.roomId]) {
    delete yahtzeeGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的进行中对局已清除`);
  }
  if (drawingGames[room.roomId]) {
    delete drawingGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的画猜接龙已清除`);
  }
  if (gameEndTimers[room.roomId]) {
    clearTimeout(gameEndTimers[room.roomId]);
    delete gameEndTimers[room.roomId];
  }
  console.log(`🔄 房间 ${room.roomId} 玩家已全部离线，房间已重置`);
  broadcastRoom(room);
}

// ========== 核心修复：彻底移除离线玩家 ==========
// force=true 表示玩家主动退出房间，必须无条件移除；
// force 缺省时先做保险检查：若该玩家名当前映射的 socket 还活着
// （例如页面刷新 / 从房间页跳转到游戏页 / 后台标签心跳被浏览器节流），
// 说明只是"误判离线"，此时不真移除，只清掉移除计时器。
function removeOfflinePlayer(room, playerName, force) {
  // 画猜接龙：离线只标记不除名——座位/对局保留、可随时重进；仅当房间内所有人均无心跳才重置房间
  if (room.gameType === 'drawing' && drawingGames[room.roomId]) {
    if (room.leaveTimers[playerName]) {
      clearTimeout(room.leaveTimers[playerName]);
      delete room.leaveTimers[playerName];
    }
    const allOff = [...room.playerMap.keys()].every(n => {
      const hb = userLastHeartbeat.get(n);
      return !hb || (Date.now() - hb) > HEARTBEAT_TIMEOUT;
    });
    if (allOff) resetRoom(room);
    else broadcastRoom(room);
    return;
  }
  if (!force) {
    const curSid = room.playerMap.get(playerName);
    if (curSid && io.sockets.sockets.has(curSid)) {
      if (room.leaveTimers[playerName]) {
        clearTimeout(room.leaveTimers[playerName]);
        delete room.leaveTimers[playerName];
      }
      console.log(`⏳ ${playerName} 的 socket 仍在线，跳过离线移除（疑似刷新/跳转中）`);
      return;
    }
  }
  // 移除座位
  for (let i in room.seats) {
    if (room.seats[i]?.name === playerName) delete room.seats[i];
  }
  // 移除观战
  room.spectators = room.spectators.filter(n => n !== playerName);
  // 移除玩家映射
  room.playerMap.delete(playerName);
  // 清理计时器
  if (room.leaveTimers[playerName]) {
    clearTimeout(room.leaveTimers[playerName]);
    delete room.leaveTimers[playerName];
  }
  // 🆕 清理心跳和在线记录（防止脏数据）
  userLastHeartbeat.delete(playerName);
  userLastOnline.delete(playerName);
  
  console.log(`❌ 移除离线玩家：${playerName}`);
  // 画猜接龙：有人中途退出/掉线则终止本局（避免其它玩家卡死在等待），并让对局页跳回房间
  if (room.gameType === 'drawing' && drawingGames[room.roomId]) {
    delete drawingGames[room.roomId];
    io.to(room.roomId).emit('dg_cancel', { reason: 'player-left' });
    Object.keys(room.seats).forEach(seatId => { if (room.seats[seatId]) room.seats[seatId].ready = false; });
  }
  transferHost(room);
  if (room.playerMap.size === 0) {
    resetRoom(room); // 全员离线（含观战）：重置房间与残留对局，下批玩家进房从零开始
  } else {
    broadcastRoom(room);
  }
}

const UPPER_CATS = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
const LOWER_CATS = ['threeOfAKind', 'fourOfAKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'];

// 从骰子中提取葫芦点数组 {t: 三元点数, p: 对子点数}；不是葫芦（无 3+2）返回 null
function getFullHouseCombo(dice) {
  const counts = {};
  dice.forEach(d => counts[d] = (counts[d] || 0) + 1);
  const triple = Object.keys(counts).find(d => counts[d] === 3);
  const pair = Object.keys(counts).find(d => counts[d] === 2);
  return (triple && pair) ? { t: Number(triple), p: Number(pair) } : null;
}

// 掷骰完成后的即时成就检测（真实掷骰与开发者工具的"自定义骰子"共用）
function afterYahtzeeRoll(game, roomId, name) {
  const p = game.players[name];
  if (!p) return;
  if (new Set(p.dice).size === 1) {
    p.yahtzeeCount = (p.yahtzeeCount || 0) + 1;
    announceAchievement(game, roomId, name, 'yahtzee_roll', true);  // 可重复累积
    if (p.rollCount === 1) announceAchievement(game, roomId, name, 'first_roll');   // 一发入魂
    if (p.yahtzeeCount === 2) announceAchievement(game, roomId, name, 'yahtzee_twice'); // ？！艇艇！？
  }
}

// 结算时判定：250 / 300 / 低分(<100) / 座无虚席 / 同分异构
function evaluateSettlementAchievements(game, roomId) {
  const totals = {};
  game.playerOrder.forEach(name => {
    const p = game.players[name];
    const upper = UPPER_CATS.reduce((s, c) => s + (p.scores[c] || 0), 0);
    const bonus = upper >= 63 ? 35 : 0;
    const lower = LOWER_CATS.reduce((s, c) => s + (p.scores[c] || 0), 0);
    const yahtzeeBonus = p.yahtzeeBonus || 0;
    totals[name] = { upper, bonus, lower, yahtzeeBonus, total: upper + bonus + lower + yahtzeeBonus };
  });

  game.playerOrder.forEach(name => {
    const t = totals[name].total;
    if (t >= 300) announceAchievement(game, roomId, name, 'score_300');
    if (t >= 250) announceAchievement(game, roomId, name, 'score_250');
    if (t < 100) announceAchievement(game, roomId, name, 'low_score'); // 一律算非故意
    if ((game.players[name].yahtzeeCount || 0) >= 1 && totals[name].upper >= 63) {
      announceAchievement(game, roomId, name, 'seat_full');
    }
  });

  // 同分异构：总分完全相同的玩家 ≥2 则全部解锁
  const byTotal = {};
  game.playerOrder.forEach(n => {
    const t = totals[n].total;
    (byTotal[t] = byTotal[t] || []).push(n);
  });
  Object.values(byTotal).forEach(names => {
    if (names.length >= 2) names.forEach(n => announceAchievement(game, roomId, n, 'same_score'));
  });

  // ===== 时光墙：记录"正式玩家"的比赛（对局结束真实局） =====
  const officials = game.playerOrder.filter(isOfficialPlayer);
  if (officials.length) {
    const orderAll = game.playerOrder.slice().sort((a, b) => totals[b].total - totals[a].total);
    addTimeline({
      ts: Date.now(),
      type: 'game',
      game: roomId.indexOf('yahtzee') >= 0 ? 'yahtzee' : 'other',
      totalPlayers: game.playerOrder.length,
      players: officials, // 参与时光墙的正式玩家（内部名）
      results: officials.map(n => ({
        name: n,
        score: totals[n].total,
        rank: orderAll.indexOf(n) + 1
      }))
    });
  }

  // ===== 快艇排行榜：记录单局最高分（正式/测试/游客都记） =====
  recordHighScores(totals);
}

function initYahtzeeGame(roomId, playerNames, isMock) {
  const game = {
    roomId, players: {}, playerOrder: playerNames,
    currentPlayerIndex: 0, phase: 'playing', round: 1,
    mock: isMock === true,      // 开发者工具生成的模拟局：不判定/不记录成就
    comboMap: {},               // 葫芦组合 key "三元-对子" -> [玩家名]
    achievementsByPlayer: {},   // 玩家名 -> 本局已达成成就 id 列表
    cancelVotes: []             // 取消对局：已点"同意取消"的玩家名（全员同意即取消）
  };
  playerNames.forEach(name => {
    game.players[name] = {
      dice: [1,1,1,1,1], kept: [false,false,false,false,false],
      rollCount: 0, scores: {}, previewScores: {},
      yahtzeeBonus: 0,  // 重复快艇 +100 累计（随总分结算）
      yahtzeeCount: 0,  // 本局投出快艇次数
      submitLog: []     // 每轮提交记录 { category, rollCount }
    };
  });
  yahtzeeGames[roomId] = game;
  return game;
}

function getYahtzeeScores(dice) {
  const sum = (arr) => arr.reduce((a,b)=>a+b,0);
  const count = (n) => dice.filter(d=>d===n).length * n;
  
  const counts = {};
  dice.forEach(d => counts[d] = (counts[d]||0)+1);
  const vals = Object.values(counts).sort((a,b)=>b-a);
  const uniqueVals = [...new Set(dice)].sort((a,b)=>a-b);
  const uniqueCount = uniqueVals.length;

  return {
    ones: count(1), twos: count(2), threes: count(3), 
    fours: count(4), fives: count(5), sixes: count(6),
    threeOfAKind: vals.some(v=>v>=3) ? sum(dice) : 0,
    fourOfAKind: vals.some(v => v >= 4) ? sum(dice) : 0,
    fullHouse: (uniqueCount === 2 && vals[0] === 3 && vals[1] === 2) ? 25 : 0,
    smallStraight: [
      [1,2,3,4], [2,3,4,5], [3,4,5,6]
    ].some(seq => seq.every(num => dice.includes(num))) ? 30 : 0,
    largeStraight: (uniqueCount === 5 && uniqueVals[4] - uniqueVals[0] === 4) ? 40 : 0,
    yahtzee: vals[0] === 5 ? 50 : 0,
    chance: sum(dice)
  };
}

// ========== 开发者工具辅助：把"想展示的总分"摊成一张模拟计分卡 ==========
// 仅供测试胜利/结算界面使用，类别分数为"按该类别合理上限加权分配"的模拟值，
// 13 格之和一定等于 total。前 12 类有上限，超出部分全部放进"机会"（无上限）。
function buildMockScores(total) {
  const ids = ['ones','twos','threes','fours','fives','sixes',
    'threeOfAKind','fourOfAKind','fullHouse','smallStraight','largeStraight','yahtzee','chance'];
  const caps = [5,10,15,20,25,30,30,30,25,30,40,50]; // 前 12 类的"数值上限"
  const sumCaps = caps.reduce((a,b)=>a+b,0);
  const base = Math.min(Math.max(0, total), sumCaps);   // 分配给前 12 类的部分
  const extra = Math.max(0, total - sumCaps);           // 超出部分 → 机会

  // 按权重摊到前 12 类（向下取整）
  const arr = caps.map(c => Math.floor(base * c / sumCaps));
  // 把取整丢掉的余数随机补回去（每格最多到上限）
  let rem = base - arr.reduce((a,b)=>a+b,0);
  const order = [...caps.keys()].sort(() => Math.random() - 0.5);
  for (const i of order) {
    if (rem <= 0) break;
    if (arr[i] < caps[i]) { arr[i]++; rem--; }
  }
  arr.push(extra); // 第 13 格 = 机会

  const scores = {};
  ids.forEach((id, i) => { scores[id] = arr[i]; });
  return scores;
}

function broadcastYahtzeeState(roomId) {
  const game = yahtzeeGames[roomId];
  if (!game) return;
  io.to(roomId).emit('game_state', {
    players: game.players,
    playerOrder: game.playerOrder,
    currentPlayer: game.playerOrder[game.currentPlayerIndex],
    phase: game.phase, 
    round: game.round,
    allDice: Object.fromEntries(Object.entries(game.players).map(([name, p]) => [name, p.dice])),
    allScores: Object.fromEntries(Object.entries(game.players).map(([name, p]) => [name, p.scores])),
    allPreviewScores: Object.fromEntries(Object.entries(game.players).map(([name, p]) => [name, p.previewScores])),
    cancelVotes: game.cancelVotes || []
  });
}

// 定时检测心跳超时
function checkOfflinePlayersByHeartbeat() {
  const now = Date.now();
  for (const room of Object.values(GAME_ROOMS)) {
    for (const [playerName] of room.playerMap) {
      const lastHb = userLastHeartbeat.get(playerName) || 0;
      if (now - lastHb > HEARTBEAT_TIMEOUT) {
        removeOfflinePlayer(room, playerName);
      }
    }
  }
}
setInterval(checkOfflinePlayersByHeartbeat, 10000);

io.on('connection', (socket) => {
  console.log(`\n🟢 新连接 | socketID = ${socket.id}`);

  // 主动退出房间
  socket.on('leave_room', (gameType, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || !gameType) {
      if (cb) cb({ success: false, msg: '参数错误' });
      return;
    }
    const room = GAME_ROOMS[gameType];
    if (!room) {
      if (cb) cb({ success: false, msg: '房间不存在' });
      return;
    }
    removeOfflinePlayer(room, name, true); // 主动退出房间：强制移除（不走"在线就跳过"的保险）
    onlineUsers.delete(name);
    userLastOnline.set(name, Date.now());
    userLastHeartbeat.delete(name);
    broadcast();
    if (cb) cb({ success: true, msg: '已退出房间' });
    console.log(`🚪 玩家主动退出房间：${name} (${gameType})`);
  });

  // ========== 心跳处理（兼"身份自动续接"，核心修复） ==========
  // 玩家从房间页跳转到游戏页 / 刷新页面时，浏览器会断开旧连接并建立一条新 socket，
  // 这条新连接默认不被服务器认识。心跳到这里时统一做"续接"：
  //   1) 记录 名字 <-> 新 socket.id（让 yahtzee_action 等操作能找到操作者）；
  //   2) 若玩家因旧连接断开被移出 onlineUsers，则重新登记为在线；
  //   3) 若来自房间上下文页面（inRoom === true），把该玩家所在房间的 playerMap
  //      指向新 socket、加入 socket.io 房间，并取消 30 秒的离线移除计时器，
  //      避免跳转后 30 秒被 removeOfflinePlayer 误踢。
  // 参数：playerName 玩家名；isTest 是否测试者；inRoom 当前页面是否属于房间上下文。
  socket.on('heartbeat', (playerName, isTest, inRoom) => {
    if (!playerName) return;

    socketToUser.set(socket.id, playerName);

    const isOfficialPlayer = Object.values(VALID_KEYS).includes(playerName);
    const isGuestUser = playerName.startsWith('游客');
    if (isOfficialPlayer || isGuestUser) {
      const user = onlineUsers.get(playerName);
      if (user) {
        user.lastSeen = Date.now();
        onlineUsers.set(playerName, user);
      } else {
        onlineUsers.set(playerName, {
          name: playerName,
          isGuest: isGuestUser,
          isTest: isTest === true,
          lastSeen: Date.now()
        });
      }
      userLastOnline.delete(playerName);
    }

    if (inRoom === true) {
      for (const room of Object.values(GAME_ROOMS)) {
        if (room.playerMap.has(playerName)) {
          room.playerMap.set(playerName, socket.id);
          socket.join(room.roomId);
          if (room.leaveTimers[playerName]) {
            clearTimeout(room.leaveTimers[playerName]);
            delete room.leaveTimers[playerName];
          }
          // 画猜对局中：任何人（重新）进入即推一版全状态——对方看得到你在线/离线，重进页不再卡在“加载中”
          if (room.gameType === 'drawing' && drawingGames[room.roomId]) dgBroadcast(room);
          break;
        }
      }
    }

    userLastHeartbeat.set(playerName, Date.now());
    broadcast();
    socket.emit('heartbeat_ack', { success: true });
  });

  // 主动拉取游戏状态
  // 【修复】返回方式：直接 socket.emit('game_state')，与广播的结构完全一致。
  // 前端 yahtzee.html 只监听 'game_state' 事件（没传 cb），若只走 cb 回传会导致永远收不到状态。
  socket.on('get_game_state', (roomId, cb) => {
    const game = yahtzeeGames[roomId];
    if (!game) {
      if (cb) cb({ success: false, msg: '游戏未开始' });
      return;
    }
    socket.emit('game_state', {
      players: game.players,
      playerOrder: game.playerOrder,
      currentPlayer: game.playerOrder[game.currentPlayerIndex],
      phase: game.phase,
      round: game.round,
      allDice: Object.fromEntries(Object.entries(game.players).map(([name, p]) => [name, p.dice])),
      allScores: Object.fromEntries(Object.entries(game.players).map(([name, p]) => [name, p.scores])),
      allPreviewScores: Object.fromEntries(Object.entries(game.players).map(([name, p]) => [name, p.previewScores]))
    });
    if (cb) cb({ success: true });
  });

  socket.on('leave_spectate', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name)) {
        room = r;
        break;
      }
    }
    if (!room) return;
    room.spectators = room.spectators.filter(n => n !== name);
    broadcastRoom(room);
  });

  // 登录逻辑
  socket.on('login', (key, cb) => {
    const name = VALID_KEYS[key];
    if (!name) {
      if (typeof cb === 'function') cb({ success: false, message: '密钥错误' });
      return;
    }
    const existingTimer = offlineTimers.get(name);
    if (existingTimer) { clearTimeout(existingTimer); offlineTimers.delete(name); }
    onlineUsers.delete(name);
    socketToUser.set(socket.id, name);
    const isTestKey = key.startsWith('test'); // test1~test4 都算测试账号
    onlineUsers.set(name, { name, isGuest: false, isTest: isTestKey, lastSeen: Date.now() });
    userLastOnline.delete(name);
    userLastHeartbeat.set(name, Date.now());
    socket.isTest = isTestKey;
    if (typeof cb === 'function') cb({ success: true, name, isTest: isTestKey });
    broadcast();
  });

  socket.on('guest_login', (name, key, cb) => {
    // 兼容旧式调用 guest_login(name, cb)
    if (typeof key === 'function') { cb = key; key = undefined; }
    // 游客通道需口令（仅一个口令，不区分游客）
    if (key !== GUEST_KEY) {
      if (typeof cb === 'function') cb({ success: false, message: '游客口令错误' });
      return;
    }
    if (!name) name = `游客${Math.floor(Math.random() * 900 + 100)}`;
    const existingTimer = offlineTimers.get(name);
    if (existingTimer) { clearTimeout(existingTimer); offlineTimers.delete(name); }
    onlineUsers.delete(name);
    socketToUser.set(socket.id, name);
    onlineUsers.set(name, { name, isGuest: true, lastSeen: Date.now() });
    userLastHeartbeat.set(name, Date.now());
    if (typeof cb === 'function') cb({ success: true, name });
    broadcast();
  });

  socket.on('get_online_users', () => {
    const list = [];
    for (const user of onlineUsers.values()) {
      const isReallyOnline = userLastHeartbeat.has(user.name) && (Date.now() - userLastHeartbeat.get(user.name) < HEARTBEAT_TIMEOUT);
      list.push({ 
        name: user.name, 
        isGuest: user.isGuest, 
        status: isReallyOnline ? '在线' : '离线（无心跳）', 
        lastSeen: user.lastSeen,
        title: playerTitle(user.name)
      });
    }
    for (const [name, ts] of userLastOnline) {
      if (!onlineUsers.has(name)) {
        list.push({ name, isGuest: false, status: `离线 ${formatTime(ts)}`, lastSeen: ts, title: playerTitle(name) });
      }
    }
    socket.emit('online_users', list);
  });

  socket.on('join_room', ({ game, playerName, isTest }, cb) => {
    socketToUser.set(socket.id, playerName);

    const existingTimer = offlineTimers.get(playerName);
    if (existingTimer) {
      clearTimeout(existingTimer);
      offlineTimers.delete(playerName);
    }

    const isOfficialPlayer = Object.values(VALID_KEYS).includes(playerName);
    const isGuestUser = playerName.startsWith('游客');
    if (playerName && (isOfficialPlayer || isGuestUser)) {
      onlineUsers.set(playerName, {
        name: playerName,
        isGuest: isGuestUser,
        isTest: isTest,
        lastSeen: Date.now()
      });
      userLastHeartbeat.set(playerName, Date.now());
      userLastOnline.delete(playerName);
      broadcast();
    }

    const room = GAME_ROOMS[game] || GAME_ROOMS.light;

    if (room.leaveTimers[playerName]) {
      clearTimeout(room.leaveTimers[playerName]);
      delete room.leaveTimers[playerName];
    }

    room.playerMap.set(playerName, socket.id);
    socket.join(room.roomId);

    const gameInProgress = activeGameOf(room);
    const seatedCount = Object.values(room.seats).filter(Boolean).length;
    const isAlreadySeated = Object.values(room.seats).some(s => s?.name === playerName);
    const isGamePlayer = !!(gameInProgress && (gameInProgress.playerOrder || []).includes(playerName));

    // 修复：先把"是否已在座"放在最前面判断。
    // 已在座（如从结算页返回）→ 保留座位并清观战；
    // 对局进行中：
    //   - 本局玩家再次进房 → 不入座也不进观战（前端给"返回游戏"入口）；
    //   - 非本局玩家 → 加入观战。
    // 未开局：满座→观战，否则自动坐空位。
    if (isAlreadySeated) {
      room.spectators = room.spectators.filter(n => n !== playerName);
    } else if (gameInProgress && !isGamePlayer) {
      if (!room.spectators.includes(playerName)) {
        room.spectators.push(playerName);
      }
    } else if (!gameInProgress && seatedCount >= room.maxPlayers) {
      if (!room.spectators.includes(playerName)) {
        room.spectators.push(playerName);
      }
    } else if (!gameInProgress) {
      let emptySeat = null;
      for (let i=1; i<=room.maxPlayers; i++) {
        if (!room.seats[i]) { emptySeat = i; break; }
      }
      if (emptySeat) {
        room.spectators = room.spectators.filter(n=>n!==playerName);
        room.seats[emptySeat] = { name: playerName, ready: false };
        if (!room.hostName) {
          room.hostName = playerName;
        }
      }
    }

    if (typeof cb === 'function') {
      cb({ roomId: room.roomId, isHost: room.hostName === playerName });
    }

    syncRoomState(room, playerName);
    broadcastRoom(room);

    const gameData = activeGameOf(room);
    if (gameData && room.gameType === 'drawing') {
      dgBroadcast(room);
    } else if (gameData) {
      socket.emit('game_state', {
        players: gameData.players,
        playerOrder: gameData.playerOrder,
        currentPlayer: gameData.playerOrder[gameData.currentPlayerIndex],
        phase: gameData.phase, 
        round: gameData.round,
        allDice: Object.fromEntries(Object.entries(gameData.players).map(([name, p]) => [name, p.dice])),
        allScores: Object.fromEntries(Object.entries(gameData.players).map(([name, p]) => [name, p.scores])),
        allPreviewScores: Object.fromEntries(Object.entries(gameData.players).map(([name, p]) => [name, p.previewScores]))
      });
    }
  });

  socket.on('take_seat', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name)) {
        room = r;
        break;
      }
    }
    if (!room) return;
    if (activeGameOf(room)) return;
    let emptySeat = null;
    for (let i=1; i<=room.maxPlayers; i++) {
      if (!room.seats[i]) { emptySeat = i; break; }
    }
    if (!emptySeat) return;
    room.spectators = room.spectators.filter(n => n !== name);
    room.seats[emptySeat] = {
      name: name,
      ready: false,
      isHost: room.hostName === name
    };
    broadcastRoom(room);
  });

  socket.on('leave_seat', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name)) {
        room = r;
        break;
      }
    }
    if (!room) return;
    for (let i in room.seats) {
      if (room.seats[i]?.name === name) delete room.seats[i];
    }
    if (!room.spectators.includes(name)) {
      room.spectators.push(name);
    }
    broadcastRoom(room);
  });

  socket.on('spectate', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name)) {
        room = r;
        break;
      }
    }
    if (!room) return;
    if (!room.spectators.includes(name)) room.spectators.push(name);
    broadcastRoom(room);
  });

  socket.on('toggle_ready', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name)) {
        room = r;
        break;
      }
    }
    if (!room) return;
    if (activeGameOf(room)) return;
    for (let i in room.seats) {
      if (room.seats[i]?.name === name) {
        room.seats[i].ready = !room.seats[i].ready;
        break;
      }
    }
    broadcastRoom(room);
  });

  socket.on('change_settings', ({ maxPlayers }, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name) && r.hostName === name) {
        room = r;
        break;
      }
    }
    if (!room) return;
    if (room.gameType === 'drawing') {
      // 画猜接龙固定四人，不支持改人数
      if (cb) cb({ success: false, msg: '画猜接龙固定 4 人' });
      return;
    }
    if (activeGameOf(room)) return;

    // 人数校验：必须是 2/3/4，且不能小于当前已入座人数（防止三人时改成两人）
    const seatedCount = Object.values(room.seats).filter(Boolean).length;
    if (![2, 3, 4].includes(maxPlayers)) {
      if (cb) cb({ success: false, msg: '人数只能设置为 2 / 3 / 4' });
      return;
    }
    if (maxPlayers < seatedCount) {
      if (cb) cb({ success: false, msg: `当前已有 ${seatedCount} 人入座，人数不能少于 ${seatedCount} 人` });
      return;
    }

    room.maxPlayers = maxPlayers;
    broadcastRoom(room);
    if (cb) cb({ success: true, maxPlayers });
  });

  // “返回房间”：仅当对局已结算/结束后才清理对局；
  // 进行中返回只离开游戏页、保留对局（房间页会显示“本局进行中 → 返回游戏”，玩家可随时回归继续）
  socket.on('return_room', (cb) => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let cleared = false;
    for (const room of Object.values(GAME_ROOMS)) {
      if (!room.playerMap.has(name)) continue;
      const game = activeGameOf(room);
      if (!game) continue;
      const finished = room.gameType === 'drawing'
        ? game.stage === 'result'
        : game.phase === 'finished';
      if (!finished) { cleared = false; break; } // 进行中：仅退出页面，对局保留
      if (gameEndTimers[room.roomId]) {
        clearTimeout(gameEndTimers[room.roomId]);
        delete gameEndTimers[room.roomId];
      }
      delete yahtzeeGames[room.roomId];
      delete drawingGames[room.roomId];
      Object.keys(room.seats).forEach(seatId => {
        if (room.seats[seatId]) room.seats[seatId].ready = false;
      });
      broadcastRoom(room);
      cleared = true;
      break;
    }
    if (cb) cb({ success: true, cleared });
  });

  // ========== 开发者工具：直接结算（仅测试账号可调用） ==========
  // 前端传入 [{ name, total }]，服务器据此生成/覆盖一场 phase=finished 的对局并广播，
  // 所有在游戏页的人会立刻看到"最终排名 + 返回房间"的结算界面。
  socket.on('dev_finish_yahtzee', ({ players }, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || !TEST_NAMES.includes(name)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    let room = null;
    for (const r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name)) { room = r; break; }
    }
    if (!room) room = GAME_ROOMS.yahtzee;

    const list = Array.isArray(players) ? players : [];
    const rows = list.map(p => ({
      name: String(p && p.name || '').trim(),
      total: Math.max(0, Math.floor(Number(p && p.total) || 0))
    })).filter(p => p.name);
    if (rows.length === 0) {
      if (cb) cb({ success: false, msg: '请至少填写一个玩家名' });
      return;
    }

    // 清掉旧局的自动清理定时器，避免误删本场模拟对局
    if (gameEndTimers[room.roomId]) {
      clearTimeout(gameEndTimers[room.roomId]);
      delete gameEndTimers[room.roomId];
    }

    const game = {
      roomId: room.roomId,
      players: {},
      playerOrder: rows.map(r => r.name),
      currentPlayerIndex: 0,
      phase: 'finished',
      round: 14,
      mock: true,                 // 模拟对局：不判定/不记录成就
      comboMap: {},
      achievementsByPlayer: {}
    };
    rows.forEach(r => {
      game.players[r.name] = {
        dice: [1,1,1,1,1],
        kept: [false,false,false,false,false],
        rollCount: 0,
        scores: buildMockScores(r.total),
        previewScores: {},
        yahtzeeBonus: 0,
        yahtzeeCount: 0,
        submitLog: []
      };
    });
    yahtzeeGames[room.roomId] = game;
    broadcastYahtzeeState(room.roomId);
    if (cb) cb({ success: true, names: rows.map(r => r.name) });
  });

  // ========== 开发者工具：自定义本轮骰子（定点测试即时成就） ==========
  // 仅测试账号可用。默认作用到"当前行动玩家"，也可指定玩家名。
  // 会把该玩家的 5 颗骰子设为指定点数（当作一次掷骰：rollCount+1、触发即时成就）。
  socket.on('dev_set_dice', ({ name: targetName, dice }, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || !TEST_NAMES.includes(name)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    let room = null;
    for (const r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name)) { room = r; break; }
    }
    if (!room) { if (cb) cb({ success: false, msg: '未找到房间' }); return; }
    const game = yahtzeeGames[room.roomId];
    if (!game || game.phase !== 'playing') {
      if (cb) cb({ success: false, msg: '没有进行中的对局（请先开始一局再用）' });
      return;
    }
    const pname = (targetName && game.players[targetName]) ? targetName : game.playerOrder[game.currentPlayerIndex];
    const p = game.players[pname];
    if (p.rollCount >= 3) {
      if (cb) cb({ success: false, msg: `${pname} 本回合已掷满 3 次，请先提交计分再测` });
      return;
    }
    const arr = (Array.isArray(dice) ? dice : []).slice(0, 5).map(Number);
    if (arr.length !== 5 || arr.some(n => !Number.isInteger(n) || n < 1 || n > 6)) {
      if (cb) cb({ success: false, msg: '请填写 5 个 1~6 的点数' });
      return;
    }
    p.dice = arr;
    p.kept = [false, false, false, false, false];
    p.rollCount++;
    p.previewScores = getYahtzeeScores(p.dice);
    afterYahtzeeRoll(game, room.roomId, pname); // 复用掷骰的即时成就判定
    broadcastYahtzeeState(room.roomId);
    if (cb) cb({ success: true, name: pname, rollCount: p.rollCount });
  });

  // ========== 荣誉墙：拉取成就记录 + 元数据 ==========
  // list = 正式玩家记录；testList = 测试账号记录（仅测试账号在荣誉墙可见，正式玩家不可见）
  socket.on('get_achievements', (cb) => {
    if (typeof cb === 'function') {
      cb({
        success: true,
        list: achRecords.map(r => ({ ...r })),
        testList: achTestRecords.map(r => ({ ...r })),
        meta: ACHIEVEMENTS
      });
    }
  });

  // ========== 开发者助手：一键触发成就（仅测试账号，只写内存、不落盘） ==========
  socket.on('test_trigger_achievement', (achievementId, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || !TEST_NAMES.includes(name)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    if (!achievementId || !ACHIEVEMENTS[achievementId]) {
      if (cb) cb({ success: false, msg: '未知成就：' + achievementId });
      return;
    }
    recordAchievement(name, achievementId); // 测试者：内存记录，重启即刷新
    if (cb) cb({ success: true, name, achievementId, achievementName: ACHIEVEMENTS[achievementId].name });
  });

  // ========== 测试个人空间：一键生成模拟战绩（仅测试账号，内存） ==========
  socket.on('dev_seed_profile', (cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || !TEST_NAMES.includes(name)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    const data = seedTestProfile(name);
    if (cb) cb({ success: true, ...data });
  });

  // ========== 留言板 ==========
  // 拉取留言（正式=玩家留言；游客=游客留言）
  socket.on('get_board', (cb) => {
    if (typeof cb === 'function') cb({
      success: true,
      official: boardMessages.official.slice(),
      guest: boardMessages.guest.slice()
    });
  });

  // 发布留言：游客 -> 游客留言；正式玩家/测试者 -> 玩家留言
  socket.on('post_board_message', ({ text }, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name) { if (cb) cb({ success: false, msg: '未识别身份' }); return; }
    const clean = String(text || '').trim();
    if (!clean) { if (cb) cb({ success: false, msg: '留言不能为空' }); return; }
    if (clean.length > 100) { if (cb) cb({ success: false, msg: '留言太长啦（最多 100 字）' }); return; }
    const isGuestUser = name.startsWith('游客');
    const type = isGuestUser ? 'guest' : 'official';
    const msg = { name, text: clean, ts: Date.now() };
    boardMessages[type].push(msg);
    if (boardMessages[type].length > BOARD_MAX) boardMessages[type].shift();
    io.emit('board_new', { type, msg });
    if (cb) cb({ success: true, type });
  });

  // ========== 用户档案（设置页用） ==========
  // 获取自己的档案
  socket.on('get_profile', (cb) => {
    const name = socketToUser.get(socket.id);
    const u = usersData[name] || {};
    if (typeof cb === 'function') cb({
      success: true,
      name,
      displayName: getDisplayName(name),
      nickname: (u.nickname || ''),
      theme: (u.theme || 'initial'),
      title: playerTitle(name),
      unlockedTitles: playerUnlockedTitles(name),
      titleChoice: (u.title || ''),
      canEdit: OFFICIAL_ACCOUNT_NAMES.includes(name),
      allowedThemes: ['initial']
        .concat(OWNER_THEMES[name] || [])
        .concat(isTestAccount(name) ? ['p1'] : [])
    });
  });

  // 更新档案（昵称 / 主题）
  socket.on('update_profile', ({ nickname, theme }, cb) => {
    const name = socketToUser.get(socket.id);
    const canNick = OFFICIAL_ACCOUNT_NAMES.includes(name); // 正式玩家才能改昵称
    const isTestEdit = isTestAccount(name);               // 测试账号可体验主题（不能改昵称）
    if (!name || (!canNick && !isTestEdit)) {
      if (cb) cb({ success: false, msg: '无权限修改档案' });
      return;
    }
    const n = normalizeNickname(nickname);
    if (n === null) { if (cb) cb({ success: false, msg: '昵称限 12 字以内（中英文/数字/下划线）' }); return; }
    if (!canNick && n) { if (cb) cb({ success: false, msg: '昵称仅正式玩家可设置' }); return; }
    // 昵称唯一性（仅正式玩家改名时校验）
    if (canNick && n) {
      for (const other of OFFICIAL_ACCOUNT_NAMES) {
        if (other === name) continue;
        if (getDisplayName(other) === n) {
          if (cb) cb({ success: false, msg: '这个昵称已经被使用了，换一个吧' });
          return;
        }
      }
    }
    let t = THEMES.includes(theme) ? theme : 'initial';
    // 专属主题归属：正式玩家只能用自己拥有的素材主题；测试账号可体验 p1
    if (t !== 'initial' && !(OWNER_THEMES[name] || []).includes(t) && !(isTestEdit && t === 'p1')) {
      if (cb) cb({ success: false, msg: '这是其他玩家的专属主题，不能使用' });
      return;
    }
    usersData[name] = Object.assign({}, usersData[name], { nickname: n || undefined, theme: t });
    if (!usersData[name].nickname) delete usersData[name].nickname;
    saveUsers();
    if (cb) cb({ success: true, displayName: getDisplayName(name), nickname: usersData[name].nickname || '', theme: t });
  });

  // 设置展示头衔（只能从已解锁头衔中选择；传空 = 不佩戴）
  socket.on('set_title', ({ title }, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || (!OFFICIAL_ACCOUNT_NAMES.includes(name) && !TEST_NAMES.includes(name))) {
      if (cb) cb({ success: false, msg: '仅正式玩家或测试账号可设置头衔' });
      return;
    }
    const t = String(title || '').trim();
    if (t && !playerUnlockedTitles(name).includes(t)) {
      if (cb) cb({ success: false, msg: '该头衔尚未解锁，暂不能使用' });
      return;
    }
    usersData[name] = Object.assign({}, usersData[name], { title: t || undefined });
    if (!usersData[name].title) delete usersData[name].title;
    if (!isTestAccount(name)) saveUsers(); // 测试账号只体验，不落盘
    if (cb) cb({ success: true, title: playerTitle(name), titleChoice: (usersData[name].title || '') });
  });

  // 大厅/各页拉取所有正式玩家的显示名
  socket.on('get_display_names', (cb) => {
    const map = {};
    OFFICIAL_ACCOUNT_NAMES.forEach(k => { map[k] = getDisplayName(k); });
    if (typeof cb === 'function') cb({ success: true, map });
  });

  // 时光墙：返回时间线（最新在前）
  socket.on('get_timeline', (cb) => {
    if (typeof cb === 'function') cb({
      success: true,
      list: timelineEntries.slice().reverse()
    });
  });

  // ========== 个人空间 / 排行榜 ==========
  // 拉取某正式玩家的个人空间数据
  socket.on('get_profile_page', (name, cb) => {
    if (typeof cb !== 'function') return;
    const target = String(name || '');
    const caller = socketToUser.get(socket.id);
    const isOfficial = OFFICIAL_ACCOUNT_NAMES.includes(target);
    const isSelfTest = TEST_NAMES.includes(target) && caller === target; // 测试者只能看"自己"的测试空间
    if (!isOfficial && !isSelfTest) {
      if (cb) cb({ success: false, msg: '无权查看该个人空间' });
      return;
    }
    const source = isTestAccount(target) ? achTestRecords : achRecords;
    const recs = source.filter(r => r.playerName === target);
    const achievements = recs.map(r => {
      const meta = ACHIEVEMENTS[r.achievementId] || { name: r.achievementId, quality: 'common', game: '?' };
      return {
        id: r.achievementId, name: meta.name, quality: meta.quality, game: meta.game,
        count: r.count, firstTime: r.firstTime, lastTime: r.lastTime
      };
    }).sort((a, b) => (ACH_QUALITY_NO[b.quality] || 0) - (ACH_QUALITY_NO[a.quality] || 0));
    let stats;
    if (isTestAccount(target)) {
      stats = testProfileSeeds.get(target) || { totals: { games: 0, wins: 0, winRate: 0, totalScore: 0, best: 0 }, byGame: [] };
    } else {
      stats = { totals: summarizeProfileStats(target), byGame: buildProfileByGame(target) };
    }
    const online = onlineUsers.has(target);
    const onlineRec = onlineUsers.get(target);
    cb({
      success: true,
      name: target,
      displayName: getDisplayName(target),
      title: playerTitle(target),
      theme: (usersData[target] && usersData[target].theme) || 'initial',
      online,
      lastSeen: online ? (onlineRec && onlineRec.lastSeen) : (userLastOnline.get(target) || null),
      stats,
      achievements,
      totalAch: Object.keys(ACHIEVEMENTS).length
    });
  });

  // 排行榜：快艇战绩榜 + 成就榜（正式玩家数据；开发期数据随内存）
  socket.on('get_leaderboard', (cb) => {
    if (typeof cb !== 'function') return;
    // 快艇榜：单局最高分（正式/测试/游客真实对局都计入；高分优先，平分按名字排）
    const gamesArr = [];
    for (const [name, best] of highScoreBoard) {
      gamesArr.push({
        name,
        displayName: OFFICIAL_ACCOUNT_NAMES.includes(name) ? getDisplayName(name) : name,
        title: playerTitle(name),
        best
      });
    }
    gamesArr.sort((a, b) => b.best - a.best || (a.name < b.name ? -1 : 1));
    // 成就榜：仍只统计正式玩家
    const achRow = new Map();
    for (const r of achRecords) {
      if (!OFFICIAL_ACCOUNT_NAMES.includes(r.playerName)) continue;
      const row = achRow.get(r.playerName) || { count: 0 };
      row.count++;
      achRow.set(r.playerName, row);
    }
    const achArr = OFFICIAL_ACCOUNT_NAMES
      .map(n => ({ name: n, displayName: getDisplayName(n), title: playerTitle(n), count: (achRow.get(n) || { count: 0 }).count }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
    if (cb) cb({ success: true, game: '快艇骰子', board: gamesArr, achBoard: achArr });
  });

  socket.on('start_game', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      if (r.playerMap.has(name) && r.hostName === name) {
        room = r;
        break;
      }
    }
    if (!room) return;
    if (activeGameOf(room)) return;
    // 若上一局的"结算后自动清理"定时器还挂着，先清掉（避免误删本局）
    if (gameEndTimers[room.roomId]) {
      clearTimeout(gameEndTimers[room.roomId]);
      delete gameEndTimers[room.roomId];
    }
    const players = Object.values(room.seats).filter(Boolean);
    const needPlayers = room.gameType === 'drawing' ? 4 : 2; // 画猜接龙为四人版
    if (players.length < needPlayers || !players.every(p => p.ready)) return;
    if (room.gameType === 'yahtzee') {
      const playerNames = players.map(p => p.name);
      initYahtzeeGame(room.roomId, playerNames);
    } else if (room.gameType === 'drawing') {
      const playerNames = players.map(p => p.name);
      dgInit(room.roomId, playerNames);
    }
    broadcastRoom(room);
    if (room.gameType === 'drawing') {
      dgBroadcast(room);
    } else {
      broadcastYahtzeeState(room.roomId);
    }
    setTimeout(()=>{
      io.to(room.roomId).emit('game_start', {
        gameUrl: GAME_URL_MAP[room.gameType] + "?room=" + room.roomId
      });
    }, 300);
  });

  // ========== 取消对局：对局中任一玩家可发起，全员同意即取消；同意后可撤回 ==========
  // 取消 = 本局直接结束并清空房间，不计入场次/胜率/排行榜；已触发的成就照常保留。
  socket.on('vote_cancel', ({ revoke } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name) { if (cb) cb({ success: false, msg: '未识别身份' }); return; }
    const room = Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && yahtzeeGames[r.roomId]);
    if (!room) { if (cb) cb({ success: false, msg: '当前不在对局中' }); return; }
    const game = yahtzeeGames[room.roomId];
    if (game.phase !== 'playing' || !game.playerOrder.includes(name)) {
      if (cb) cb({ success: false, msg: '当前无法取消' });
      return;
    }
    if (game.mock) { if (cb) cb({ success: false, msg: '模拟局不可取消' }); return; }

    if (revoke) {
      // 撤回同意
      game.cancelVotes = (game.cancelVotes || []).filter(n => n !== name);
      broadcastYahtzeeState(room.roomId);
      if (cb) cb({ success: true, phase: game.phase, votes: game.cancelVotes.slice(), total: game.playerOrder.length });
      return;
    }

    if (!game.cancelVotes.includes(name)) game.cancelVotes.push(name);
    const total = game.playerOrder.length;
    if (game.cancelVotes.length >= total && total >= 1) {
      game.phase = 'cancelled';
      console.log(`❌ 对局全员同意取消：${room.roomId}（不计战绩；已触发成就保留）`);
      // 房间清理：与正常结束一致，兜底定时器（就绪复位 + 删对局），期间玩家可返回房间
      if (!gameEndTimers[room.roomId]) {
        gameEndTimers[room.roomId] = setTimeout(() => {
          delete yahtzeeGames[room.roomId];
          delete gameEndTimers[room.roomId];
          Object.keys(room.seats).forEach(seatId => { if (room.seats[seatId]) room.seats[seatId].ready = false; });
          broadcastRoom(room);
        }, 30000);
      }
    }
    broadcastYahtzeeState(room.roomId);
    if (cb) cb({ success: true, phase: game.phase, votes: game.cancelVotes.slice(), total });
  });

  socket.on('yahtzee_action', ({ action, index, category }) => {
    const name = socketToUser.get(socket.id);
    if (!name) return;

    let room = null;
    for (let r of Object.values(GAME_ROOMS)) {
      const game = yahtzeeGames[r.roomId];
      if (game && game.playerOrder.includes(name)) {
        room = r;
        break;
      }
    }
    if (!room) return;

    const game = yahtzeeGames[room.roomId];
    if (!game || game.playerOrder[game.currentPlayerIndex] !== name) return;
    if (game.phase !== 'playing') return;

    const playerData = game.players[name];

    if (action === 'roll') {
      if (playerData.rollCount >= 3) return;
      for (let i=0; i<5; i++) if (!playerData.kept[i]) playerData.dice[i] = Math.floor(Math.random()*6)+1;
      playerData.rollCount++;
      playerData.previewScores = getYahtzeeScores(playerData.dice);
      afterYahtzeeRoll(game, room.roomId, name); // 即时成就检测（快艇/一发入魂/艇艇）
    } else if (action === 'toggle_keep') {
      if (playerData.rollCount === 0) return;
      playerData.kept[index] = !playerData.kept[index];
    } else if (action === 'select_category') {
      // 仅计算预览，不做其他动作（前端也可自行计算，此处保留）
      playerData.previewScores = getYahtzeeScores(playerData.dice);
    } else if (action === 'submit_score') {
      if (playerData.rollCount === 0 || playerData.scores[category] !== undefined) return;
      const rolledDice = [...playerData.dice];   // 快照：稍后会被清空
      const usedRolls = playerData.rollCount;
      const wasYahtzeeFilled = playerData.scores.yahtzee !== undefined; // 提交前是否已填过快艇格
      const isYahtzeeRoll = new Set(rolledDice).size === 1;
      playerData.scores[category] = getYahtzeeScores(playerData.dice)[category];
      playerData.dice = [1,1,1,1,1]; 
      playerData.kept = [false,false,false,false,false];
      playerData.rollCount = 0; 
      playerData.previewScores = {};
      
      // ---- 对局统计与成就（mock 局跳过）----
      if (!game.mock) {
        playerData.submitLog.push({ category, rollCount: usedRolls });

        // 重复快艇 +100：已填过快艇格后的后续快艇
        if (isYahtzeeRoll && wasYahtzeeFilled && category !== 'yahtzee') {
          playerData.yahtzeeBonus = (playerData.yahtzeeBonus || 0) + 100;
        }
        // 龟速填分：前 5 次提交全在上区
        if (playerData.submitLog.length === 5 &&
            playerData.submitLog.every(e => UPPER_CATS.includes(e.category))) {
          announceAchievement(game, room.roomId, name, 'slow_fill');
        }
        // 重掷大师：13 次提交全部用满重掷（rollCount === 3）
        if (playerData.submitLog.length === 13 &&
            playerData.submitLog.every(e => e.rollCount === 3)) {
          announceAchievement(game, room.roomId, name, 'reroll_master');
        }
        // 上层建筑：上区小计 ≥63
        const upperSum = UPPER_CATS.reduce((s, c) => s + (playerData.scores[c] || 0), 0);
        if (upperSum >= 63) announceAchievement(game, room.roomId, name, 'upper_bonus');
        // 葫芦兄弟：记录葫芦点数组，同组合 ≥2 人解锁
        if (category === 'fullHouse' && playerData.scores.fullHouse > 0) {
          const combo = getFullHouseCombo(rolledDice);
          if (combo) {
            const key = combo.t + '-' + combo.p;
            (game.comboMap[key] = game.comboMap[key] || []).push(name);
            if (game.comboMap[key].length >= 2) {
              game.comboMap[key].forEach(n => announceAchievement(game, room.roomId, n, 'fullhouse_brothers'));
            }
          }
        }
      }

      game.currentPlayerIndex++;
      if (game.currentPlayerIndex >= game.playerOrder.length) {
        game.currentPlayerIndex = 0;
        game.round++;
        if (game.round > 13) { 
          game.phase = 'finished';
          // 结算：判定结算型成就 + 广播"本局成就汇总"（mock 局跳过）
          if (!game.mock) {
            evaluateSettlementAchievements(game, room.roomId);
            broadcastAchievementSummary(room.roomId, game);
          }
          gameEndTimers[room.roomId] = setTimeout(() => {
            delete yahtzeeGames[room.roomId];
            delete gameEndTimers[room.roomId];
            Object.keys(room.seats).forEach(seatId => {
              if (room.seats[seatId]) {
                room.seats[seatId].ready = false;
              }
            });
            broadcastRoom(room);
          }, 60000); // 兜底 60 秒自动清理；正常流程由玩家点"返回房间"立即清理
        }
      }
    }
    broadcastYahtzeeState(room.roomId);
  });

  // ========== 画猜接龙（drawing）：玩家提交 ==========
  function drawingFindRoomOf(name) {
    return Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'drawing' && drawingGames[r.roomId]) || null;
  }
  // 写词：第 1 棒
  socket.on('drawing_word', ({ room: roomArg, word }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = roomArg ? GAME_ROOMS[roomArg] : drawingFindRoomOf(name);
    if (!room || !name) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const g = drawingGames[room.roomId];
    const roles = g && drawingRoles(g, g.round);
    if (!g || g.stage !== 'word' || roles.writer !== name) { if (cb) cb({ success: false, msg: '当前不是写词阶段' }); return; }
    const w = String(word || '').trim();
    if (!w || [...w].length > 12) { if (cb) cb({ success: false, msg: '词需为 1~12 字' }); return; }
    g.word = w;
    drawingAdvance(g, room);
    if (cb) cb({ success: true });
  });
  // 作画：第 1 棒画自己的词 / 第 3 棒画猜到的词（strokes 整份提交）
  socket.on('drawing_pic', ({ room: roomArg, strokes }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = roomArg ? GAME_ROOMS[roomArg] : drawingFindRoomOf(name);
    if (!room || !name) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const g = drawingGames[room.roomId];
    const roles = g && drawingRoles(g, g.round);
    if (!g || !Array.isArray(strokes)) { if (cb) cb({ success: false, msg: '请先画一画' }); return; }
    if (g.stage === 'draw1' && roles.writer === name) {
      g.pic1 = strokes.map(s => ({ t: s.t, c: s.c, w: s.w, p: (s.p || []).slice(0, 2000) })).slice(0, 500);
      drawingAdvance(g, room);
      if (cb) cb({ success: true });
      return;
    }
    if (g.stage === 'draw2' && roles.drawer === name) {
      g.pic2 = strokes.map(s => ({ t: s.t, c: s.c, w: s.w, p: (s.p || []).slice(0, 2000) })).slice(0, 500);
      drawingAdvance(g, room);
      if (cb) cb({ success: true });
      return;
    }
    if (cb) cb({ success: false, msg: '当前不能作画' });
  });
  // 猜词：第 2 棒看图猜 / 第 4 棒看图猜
  socket.on('drawing_guess', ({ room: roomArg, word }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = roomArg ? GAME_ROOMS[roomArg] : drawingFindRoomOf(name);
    if (!room || !name) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const g = drawingGames[room.roomId];
    const roles = g && drawingRoles(g, g.round);
    const w = String(word || '').trim();
    if (!g || !w || [...w].length > 12) { if (cb) cb({ success: false, msg: '请输入你猜的词（1~12 字）' }); return; }
    if (g.stage === 'guessA' && roles.guessA === name) {
      g.guessA = w;
      drawingAdvance(g, room);
      if (cb) cb({ success: true });
      return;
    }
    if (g.stage === 'guessB' && roles.guessB === name) {
      g.guessB = w;
      drawingAdvance(g, room);
      if (cb) cb({ success: true });
      return;
    }
    if (cb) cb({ success: false, msg: '当前不能猜词' });
  });
  // 揭晓后开下一轮（房主）
  socket.on('drawing_next', ({ room: roomArg }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = roomArg ? GAME_ROOMS[roomArg] : drawingFindRoomOf(name);
    if (!room || room.hostName !== name) { if (cb) cb({ success: false, msg: '仅房主可开始下一轮' }); return; }
    const g = drawingGames[room.roomId];
    if (!g || g.stage !== 'reveal') { if (cb) cb({ success: false, msg: '尚未到下一轮时机' }); return; }
    g.round++;
    g.word = null; g.pic1 = []; g.guessA = null; g.pic2 = []; g.guessB = null; g.lastReveal = null;
    g.stage = 'word';
    broadcastDrawingState(room);
    if (cb) cb({ success: true });
  });

  // 画猜接龙页面刷新后重拉自己的状态
  socket.on('drawing_pull', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? drawingFindRoomOf(name) : null;
    if (room) dgBroadcast(room);
    if (cb) cb({ success: !!room });
  });

  // 玩家真正进入画猜游戏页：登记在场（房间页/大厅不算），并立即把最新状态推给全屋
  socket.on('dg_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    drawingAtGame.set(name, socket.id);
    const room = Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'drawing');
    if (room && drawingGames[room.roomId]) dgBroadcast(room);
  });

  // ========== 画猜接龙 v2 操作：写词/作画/猜词/判定/奖励投票/下一轮 ==========
  function dgRoomOf(name) {
    return Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'drawing' && drawingGames[r.roomId]) || null;
  }
  function dgSubmitDone(g, room, needPre) {
    if (needPre === 'judge') dgVoteFinishMatch(g);
    if (needPre === 'reward') dgApplyReward(g);
    if (dgAllDone(g)) dgAdvance(g, room);
    else dgBroadcast(room);
  }
  socket.on('dg_act', ({ type, value }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? dgRoomOf(name) : null;
    if (!room || !name) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const g = drawingGames[room.roomId];
    if (!g || g.done[name]) { if (cb) cb({ success: false, msg: '当前不能重复提交' }); return; }
    const ok = () => { if (cb) cb({ success: true }); };

    if (g.stage === 'writeDraw' && type === 'both') {
      const val = value || {};
      const w = String(val.word || '').trim();
      const pic = val.pic;
      if (!w || [...w].length > 12 || !Array.isArray(pic)) {
        if (cb) cb({ success: false, msg: '请填写 1~12 字的词并画好作品再提交' });
        return;
      }
      g.chains[name].word = w;
      g.chains[name].picW = pic.map(s => ({ t: s.t, c: s.c, w: s.w, p: (s.p || []).slice(0, 2000) })).slice(0, 500);
      g.done[name] = true;
      dgSubmitDone(g, room);
      ok(); return;
    }
    if (g.stage === 'guessA' && type === 'guess') {
      const target = dgTarget(g, name, 'guessA');
      const w = String(value || '').trim();
      if (!w || [...w].length > 12) { if (cb) cb({ success: false, msg: '猜词需为 1~12 字' }); return; }
      g.chains[target].guessA = w;
      g.done[name] = true;
      dgSubmitDone(g, room);
      ok(); return;
    }
    if (g.stage === 'picG' && type === 'pic') {
      const target = dgTarget(g, name, 'picG');
      if (!Array.isArray(value)) { if (cb) cb({ success: false, msg: '请先画画' }); return; }
      g.chains[target].picG = value.map(s => ({ t: s.t, c: s.c, w: s.w, p: (s.p || []).slice(0, 2000) })).slice(0, 500);
      g.done[name] = true;
      dgSubmitDone(g, room);
      ok(); return;
    }
    if (g.stage === 'guessF' && type === 'guess') {
      const target = dgTarget(g, name, 'guessF');
      const w = String(value || '').trim();
      if (!w || [...w].length > 12) { if (cb) cb({ success: false, msg: '猜词需为 1~12 字' }); return; }
      g.chains[target].guessF = w;
      g.done[name] = true;
      dgSubmitDone(g, room);
      ok(); return;
    }
    if (g.stage === 'judge' && type === 'match') {
      g.voted.push({ name, choice: value === true });
      g.done[name] = true;
      dgSubmitDone(g, room, 'judge');
      ok(); return;
    }
    if (g.stage === 'reward' && type === 'pick') {
      const owner = g.order[g.reviewIdx];
      const matched = !!(g.chains[owner] && g.chains[owner].match === true);
      const target = String(value || '');
      if (!g.order.includes(target) || target === name) { if (cb) cb({ success: false, msg: '请选择其他人' }); return; }
      g.voted.push({ name, target, delta: matched ? 1 : -1 });
      g.done[name] = true;
      dgSubmitDone(g, room, 'reward');
      ok(); return;
    }
    if (cb) cb({ success: false, msg: '当前阶段无法执行该操作' });
  });
  // 画猜接龙：取消本局（全员同意 → 终止并回房；离线玩家不计入票数）
  socket.on('dg_cancel_vote', (cb) => {
    const me = socketToUser.get(socket.id);
    const room = me ? dgRoomOf(me) : null;
    if (!room || !me) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const g = drawingGames[room.roomId];
    if (!g) { if (cb) cb({ success: false, msg: '当前没有进行中的对局' }); return; }
    if (!g.cancelVotes) g.cancelVotes = [];
    if (!g.cancelVotes.includes(me)) g.cancelVotes.push(me);
    const onlineNames = g.order.filter(n => dgPlayerOnline(room, n));
    if (onlineNames.length && g.cancelVotes.length >= onlineNames.length) {
      delete drawingGames[room.roomId];
      io.to(room.roomId).emit('dg_cancel', { reason: 'cancelled' });
      Object.keys(room.seats).forEach(seatId => { if (room.seats[seatId]) room.seats[seatId].ready = false; });
      broadcastRoom(room);
      if (cb) cb({ success: true, cancelled: true });
      return;
    }
    dgBroadcast(room);
    if (cb) cb({ success: true, cancelled: false, votes: g.cancelVotes.slice() });
  });

  // 房主：新一轮（保留累计积分）
  socket.on('dg_restart', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? dgRoomOf(name) : null;
    if (!room || room.hostName !== name) { if (cb) cb({ success: false, msg: '仅房主可开始新一轮' }); return; }
    const g = drawingGames[room.roomId];
    if (!g || g.stage !== 'result') { if (cb) cb({ success: false, msg: '当前不可开始新一轮' }); return; }
    const chains = {};
    g.order.forEach(n => { chains[n] = { word: null, picW: [], guessA: null, picG: [], guessF: null, match: null, matchVotes: 0 }; });
    g.round++; g.chains = chains; g.stage = 'writeDraw'; g.reviewIdx = 0; g.voted = []; g.chainVotes = []; g.settled = []; g.cancelVotes = [];
    g.done = {}; g.order.forEach(n => { g.done[n] = false; });
    dgBroadcast(room);
    if (cb) cb({ success: true });
  });

  // ========== 默契空间（主页数据 / 进入 / 问答小游戏） ==========
  socket.on('get_sync_home', (cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || name.startsWith('游客')) { if (cb) cb({ success: false, msg: '仅正式玩家或测试账号可用' }); return; }
    const members = OFFICIAL_ACCOUNT_NAMES.includes(name)
      ? OFFICIAL_ACCOUNT_NAMES.slice()
      : OFFICIAL_ACCOUNT_NAMES.concat([name]);
    const others = members.filter(n => n !== name);
    const combo = (a, b) => {
      const key = syncPairKey(a, b);
      const p = syncGetPair(key);
      return { a, b, key, score: p.score, titles: p.titles, alias: p.alias || '', pendingName: (p.pending && p.pending.name) || '', pendingBy: (p.pending && p.pending.by) || '' };
    };
    const first = others.map(o => combo(name, o));
    const second = [];
    for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) second.push(combo(others[i], others[j]));
    if (cb) cb({ success: true, me: name, first, second });
  });

  // 进入某双人默契空间：成员进入可参与小游戏；非成员以"访客"进入只读查看（默契分/称号/画作墙）
  socket.on('sync_enter', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const [a, b] = syncNamesOf(key);
    if (!name || name.startsWith('游客')) {
      if (cb) cb({ success: false, msg: '无法进入该默契空间' });
      return;
    }
    const isMember = name === a || name === b;
    if (!isMember && !OFFICIAL_ACCOUNT_NAMES.includes(name) && !TEST_NAMES.includes(name)) {
      if (cb) cb({ success: false, msg: '无法进入该默契空间' });
      return;
    }
    if (!isMember) {
      // 访客：只读查看，不进会话、不参与小游戏
      const p = syncGetPair(key);
      if (cb) cb({ success: true, role: 'viewer', key, score: p.score, titles: p.titles, alias: p.alias || '', pendingName: (p.pending && p.pending.name) || '', pendingBy: (p.pending && p.pending.by) || '' });
      return;
    }
    socket.join('sync:' + key);
    socketSyncKey.set(socket.id, key);
    if (!syncSessions.has(key)) {
      syncSessions.set(key, { players: [a, b], members: new Set(), memberSockets: {}, phase: 'idle', game: null, roundQs: [], qi: 0, answers: {}, gains: 0, answered: 0, readyGame: null, readyVotes: [], paint: null, paintTimer: null });
    }
    const sess = syncSessions.get(key);
    sess.members.add(name);
    sess.memberSockets = sess.memberSockets || {};
    sess.memberSockets[name] = socket.id;
    syncEmitState(key);
    // 你画我猜进行中刷新/重进：按角色补发当前对局快照（词只发给画者）
    if (sess.game === 'paint' && sess.paint && sess.paint.stage === 'draw') {
      const pt = sess.paint;
      if (name === pt.painter) {
        paintSendTo(sess, name, 'paint_restore', { role: 'drawer', word: pt.word, wordLen: paintWordLen(pt.word), strokes: pt.strokes, deadline: pt.deadline });
      } else if (name === pt.guesser) {
        paintSendTo(sess, name, 'paint_restore', { role: 'guesser', wordLen: paintWordLen(pt.word), strokes: pt.strokes, deadline: pt.deadline, attemptsTotal: (pt.attempts || []).length });
      }
    }
    if (cb) cb({ success: true, role: 'member', members: [...sess.members], phase: sess.phase, game: sess.game, score: syncGetPair(key).score, titles: syncGetPair(key).titles, alias: syncGetPair(key).alias || '', pendingName: (syncGetPair(key).pending && syncGetPair(key).pending.name) || '', pendingBy: (syncGetPair(key).pending && syncGetPair(key).pending.by) || '' });
  });

  // 画作墙：拉取某组合保存的画作（成员与访客都可查看）
  socket.on('get_sync_wall', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    if (!name || name.startsWith('游客')) {
      if (cb) cb({ success: false, msg: '无权查看' });
      return;
    }
    if (cb) cb({ success: true, wall: (syncData.wall && syncData.wall[key]) || [] });
  });

  // ========== 默契组合名：一方申请改名，另一方同意后生效 ==========
  function aliasMemberGuard(name, key) {
    const [a, b] = syncNamesOf(key);
    return name === a || name === b;
  }
  socket.on('sync_alias_propose', ({ pair, name: alias }, cb) => {
    const me = socketToUser.get(socket.id);
    const key = String(pair || '');
    if (!me || me.startsWith('游客') || !aliasMemberGuard(me, key)) {
      if (cb) cb({ success: false, msg: '仅组合成员可申请改名' });
      return;
    }
    const nm = String(alias || '').trim();
    const len = [...nm].length;
    if (len < 1 || len > 10) { if (cb) cb({ success: false, msg: '组合名需为 1~10 字' }); return; }
    const p = syncGetPair(key);
    p.pending = { name: nm, by: me, ts: Date.now() };
    syncSavePair(key);
    syncEmitState(key);
    if (cb) cb({ success: true });
  });
  socket.on('sync_alias_reply', ({ pair, agree }, cb) => {
    const me = socketToUser.get(socket.id);
    const key = String(pair || '');
    const [a, b] = syncNamesOf(key);
    if (!me || !aliasMemberGuard(me, key)) { if (cb) cb({ success: false, msg: '仅组合成员可处理' }); return; }
    const p = syncGetPair(key);
    if (!p.pending) { if (cb) cb({ success: false, msg: '没有待处理的改名申请' }); return; }
    if (me === p.pending.by) { if (cb) cb({ success: false, msg: '请等待对方同意' }); return; }
    if (agree) {
      p.alias = p.pending.name;
    }
    delete p.pending;
    syncSavePair(key);
    syncEmitState(key);
    if (cb) cb({ success: true });
  });

  // 小游戏"准备"：两人各自准备/取消，同一时间只能准备一个，双方都就绪才自动开始
  // game：'qa'=默契问答；'paint'=你画我猜
  socket.on('sync_ready', ({ pair, game, ready }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const g = String(game || '');
    const sess = syncSessions.get(key);
    if (!sess || !sess.members.has(name) || (g !== 'qa' && g !== 'paint')) {
      if (cb) cb({ success: false, msg: '无法准备该小游戏' });
      return;
    }
    if (sess.phase !== 'idle') { if (cb) cb({ success: false, msg: '游戏进行中' }); return; }
    if (!sess.readyGame) sess.readyGame = g;
    if (sess.readyGame !== g) { if (cb) cb({ success: false, msg: '已准备其他小游戏，请先取消' }); return; }
    if (ready === false) {
      // 取消准备
      sess.readyVotes = (sess.readyVotes || []).filter(n => n !== name);
      if (!sess.readyVotes.length) sess.readyGame = null;
      syncEmitState(key);
      if (cb) cb({ success: true });
      return;
    }
    if (!sess.readyVotes.includes(name)) sess.readyVotes.push(name);
    if (sess.members.size >= 2 && sess.readyVotes.length >= 2) {
      // 双方都已准备 → 开局（先广播状态让前端进入对应视图，再发题目/回合）
      sess.readyGame = null;
      sess.readyVotes = [];
      if (g === 'paint') {
        startPaintRound(key);
      } else {
        syncStartRound(sess);
      }
      syncEmitState(key);
      if (g === 'qa') syncBroadcastQuestion(key);
      if (cb) cb({ success: true, started: true });
      return;
    }
    syncEmitState(key);
    if (cb) cb({ success: true, started: false });
  });

  // ========== 你画我猜：出词 / 笔画 / 猜测 / 下一轮 / 中止 ==========
  // 画者"随机出词"：先抽一个词预览，可再随机或确认后进入绘制
  socket.on('paint_random', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || sess.game !== 'paint' || !sess.paint || sess.paint.stage !== 'word') {
      if (cb) cb({ success: false, msg: '当前不能抽词' });
      return;
    }
    if (sess.paint.painter !== name) { if (cb) cb({ success: false, msg: '只有画者可以出词' }); return; }
    const w = PAINT_WORDS[Math.floor(Math.random() * PAINT_WORDS.length)];
    if (cb) cb({ success: true, word: w });
  });

  // 画者确认出词（自定义输入 1~12 字，或来自随机预览的词），确认后进入倒计时绘制
  socket.on('paint_word', ({ pair, word }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || sess.game !== 'paint' || !sess.paint || sess.paint.stage !== 'word') {
      if (cb) cb({ success: false, msg: '当前不能出词' });
      return;
    }
    if (sess.paint.painter !== name) { if (cb) cb({ success: false, msg: '只有画者可以出词' }); return; }
    const w = String(word || '').trim();
    if (paintWordLen(w) < 1 || paintWordLen(w) > 12) { if (cb) cb({ success: false, msg: '词需为 1~12 字' }); return; }
    const pt = sess.paint;
    pt.word = w;
    pt.wordLen = paintWordLen(w);
    pt.strokes = [];
    pt.attempts = [];
    pt.stage = 'draw';
    pt.deadline = Date.now() + DRAW_TIME;
    paintClearTimer(sess);
    sess.paintTimer = setTimeout(() => finishPaintRound(key, false), DRAW_TIME);
    paintSendTo(sess, pt.painter, 'paint_draw_start', { role: 'drawer', word: pt.word, wordLen: pt.wordLen, deadline: pt.deadline });
    paintSendTo(sess, pt.guesser, 'paint_draw_start', { role: 'guesser', wordLen: pt.wordLen, deadline: pt.deadline });
    if (cb) cb({ success: true, word: pt.word });
  });

  // 画者同步笔画（整份 strokes；橡皮用 destination-out 由前端重放处理）
  socket.on('paint_stroke', ({ pair, strokes }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || sess.game !== 'paint' || !sess.paint || sess.paint.painter !== name || sess.paint.stage !== 'draw') return;
    if (!Array.isArray(strokes)) return;
    sess.paint.strokes = strokes.map(s => ({ t: s.t, c: s.c, w: s.w, p: (s.p || []).slice(0, 2000) })).slice(0, 500);
    paintSendTo(sess, sess.paint.guesser, 'paint_strokes', { strokes: sess.paint.strokes });
    if (cb) cb({ success: true });
  });

  // 猜者猜测（不限次数，答对即结束本轮 +5）
  socket.on('paint_guess', ({ pair, text }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || sess.game !== 'paint' || !sess.paint || sess.paint.guesser !== name || sess.paint.stage !== 'draw') {
      if (cb) cb({ success: false, msg: '当前不能猜测' });
      return;
    }
    const g = String(text || '').trim().replace(/\s+/g, '');
    if (!g) { if (cb) cb({ success: false }); return; }
    const pt = sess.paint;
    pt.attempts.push({ t: g, ts: Date.now() });
    const target = String(pt.word || '').trim().replace(/\s+/g, '');
    if (g === target) {
      finishPaintRound(key, true);
      if (cb) cb({ success: true, correct: true });
    } else {
      paintSendTo(sess, name, 'paint_guess_miss', { n: pt.attempts.length });
      if (cb) cb({ success: true, correct: false });
    }
  });

  // 结束画面 → 下一轮（自动交换画者/猜者）
  socket.on('paint_next', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || !sess.members.has(name) || sess.game !== 'paint' || sess.paint.stage !== 'end') return;
    startPaintRound(key);
    if (cb) cb({ success: true });
  });

  // 中止你画我猜（回到小游戏菜单）
  socket.on('paint_abort', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || !sess.members.has(name) || sess.game !== 'paint') return;
    paintResetPlaying(sess, key);
    syncEmitState(key);
    if (cb) cb({ success: true });
  });

  // 回答当前默契问答题
  socket.on('sync_answer', ({ pair, choice }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || sess.phase !== 'playing' || !sess.members.has(name)) return;
    if (sess.answers[name] !== undefined) return; // 已答
    const item = sess.roundQs[sess.qi];
    if (!item || typeof choice !== 'number' || choice < 0 || choice >= item.opts.length) return;
    sess.answers[name] = choice;
    sess.answered++;
    if (sess.answered >= 2) {
      const [pa, pb] = sess.players;
      const match = sess.answers[pa] === sess.answers[pb];
      if (match) sess.gains += 2;
      io.to('sync:' + key).emit('sync_result', { qi: sess.qi, match, total: sess.roundQs.length, gainSoFar: sess.gains });
      setTimeout(() => {
        const s2 = syncSessions.get(key);
        if (!s2 || s2.phase !== 'playing') return;
        s2.qi++;
        s2.answered = 0;
        s2.answers = {};
        if (s2.qi < s2.roundQs.length) {
          syncBroadcastQuestion(key);
        } else {
          syncFinishRound(key);
        }
      }, 2000);
    }
    if (cb) cb({ success: true });
  });

  // 主动离开默契页（返回默契主页/大厅时调用；断线也会兜底清理）
  socket.on('sync_leave', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '') || socketSyncKey.get(socket.id);
    if (name && key) syncLeaveKey(name, key);
    if (cb) cb({ success: true });
  });

  socket.on('disconnect', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    socketToUser.delete(socket.id);
    // 离开画猜游戏页：清除“正在对局页”标记（仅当标记还指向本 socket）
    if (drawingAtGame.get(name) === socket.id) drawingAtGame.delete(name);

    // 默契空间：离开会话（断线兜底）
    const syncKey = socketSyncKey.get(socket.id);
    if (syncKey) syncLeaveKey(name, syncKey);

    // 防误删：若该玩家名已被"另一条还活着的连接"接管
    // （典型场景：刚从房间页跳转到游戏页 / 刚刷新页面，新连接先到了），
    // 则旧连接的断开不算离线——不删在线名单、不排队移除，交给新连接的心跳去续接。
    let hasAnotherAlive = false;
    for (const [sid, uname] of socketToUser) {
      if (uname === name && sid !== socket.id && io.sockets.sockets.has(sid)) {
        hasAnotherAlive = true;
        break;
      }
    }
    if (hasAnotherAlive) return;

    onlineUsers.delete(name);
    userLastOnline.set(name, Date.now());

    for (let room of Object.values(GAME_ROOMS)) {
      if (room.playerMap.has(name)) {
        room.leaveTimers[name] = setTimeout(() => {
          removeOfflinePlayer(room, name);
        }, HEARTBEAT_TIMEOUT);
      }
    }
    broadcast();
  });
});

setInterval(() => {
  for (const room of Object.values(GAME_ROOMS)) {
    broadcastRoom(room);
  }
  broadcast();
}, 3000);

// 启动时读回成就数据（开发/测试期为内存模式：不读不写 data/，重启即刷新）
// 测试账号成就永远只存内存（不读不写文件）
if (PERSIST_ACHIEVEMENTS) {
  achRecords = loadAchRecords(ACH_FILE, []);
  console.log(`✅ 成就系统【正式落盘模式】：已启用环境变量 PERSIST_ACHIEVEMENTS=true，正式玩家成就写入 data/achievements.json`);
} else {
  achRecords = [];
  console.log('🧪 成就系统处于【内存模式】：默认开发/测试用，重启即刷新、不写入 data/（正式部署时设置环境变量 PERSIST_ACHIEVEMENTS=true 即落盘）');
}
achTestRecords = []; // 测试者成就始终内存态

// 加载正式玩家档案（昵称/主题 落盘 data/users.json）
usersData = loadUsers();
console.log(`✅ 用户档案已加载：${Object.keys(usersData).length} 位玩家配置了档案`);

// 时光墙：正式版落盘读取 / 开发期内存
if (PERSIST_TIMELINE) {
  try { timelineEntries = JSON.parse(fs.readFileSync(TIMELINE_FILE, 'utf8')) || []; }
  catch (e) { timelineEntries = []; }
  console.log(`✅ 时光墙【正式落盘模式】：已启用环境变量 PERSIST_TIMELINE=true，已加载 ${timelineEntries.length} 条记录`);
} else {
  timelineEntries = [];
  console.log('🧪 时光墙处于【内存模式】：默认开发/测试用，重启即清空（正式部署时设置环境变量 PERSIST_TIMELINE=true 即落盘）');
}

// ========== 留言板（开发期内存，重启即清空；正式版可仿照 PERSIST_ACHIEVEMENTS 加落盘） ==========
const BOARD_MAX = 120; // 每块最多保留条数
let boardMessages = { official: [], guest: [] }; // { name, text, ts }

// ========== 默契空间（双人默契分 / 称号 / 小游戏；画作墙预留 data/sync.json） ==========
const SYNC_FILE = path.join(DATA_DIR, 'sync.json');
// 落盘开关：默认开发/测试=内存模式（重启即清空）；正式部署设环境变量 PERSIST_SYNC=true 才写入 data/sync.json
const PERSIST_SYNC = process.env.PERSIST_SYNC === 'true';
// 称号分档（默契分累计，跨所有双人小游戏）
const SYNC_TITLES = [
  { name: '初次邂逅', min: 1 },
  { name: '渐入佳境', min: 30 },
  { name: '心有灵犀', min: 80 },
  { name: '灵魂搭档', min: 200 },
  { name: '天作之合', min: 500 }
];
// ========== 你画我猜 ==========
const DRAW_TIME = 60 * 1000; // 每轮限时 60 秒
const PAINT_WORDS = [
  '猫', '狗', '兔子', '大象', '熊猫', '企鹅', '鸭子', '蝴蝶', '鱼', '鲸鱼',
  '苹果', '香蕉', '西瓜', '草莓', '葡萄', '橙子', '桃子', '辣椒', '萝卜', '玉米',
  '汽车', '火车', '飞机', '轮船', '自行车', '公交车', '火箭', '热气球', '地铁', '滑板',
  '太阳', '月亮', '星星', '彩虹', '云朵', '雪花', '闪电', '山', '河流', '火山',
  '房子', '城堡', '灯塔', '桥', '树', '花', '蘑菇', '草地', '沙滩', '森林',
  '电视', '手机', '电脑', '吉他', '钢琴', '帽子', '鞋子', '眼镜', '雨伞', '钟表',
  '牙刷', '剪刀', '铅笔', '书本', '信封', '气球', '风筝', '秋千', '滑梯', '烟花',
  '汉堡', '披萨', '蛋糕', '冰淇淋', '棒棒糖', '寿司', '面条', '饺子', '煎蛋', '火锅',
  '圣诞树', '礼物盒', '皇冠', '钻石', '奖杯', '金牌', '爱心', '笑脸', '哭脸', '疑问',
  '兔子戴帽子', '恐龙', '小丑', '宇航员', '美人鱼', '机器人', '龙', '独角兽', '僵尸', '海盗船'
];
const SYNC_ROUND_QS = 5;          // 每轮默契问答题数
const SYNC_QUESTION_POOL = [
  { q: '更喜欢白天还是黑夜？', opts: ['白天', '黑夜'] },
  { q: '可乐和雪碧，选一个？', opts: ['可乐', '雪碧'] },
  { q: '猫和狗，更喜欢谁？', opts: ['猫', '狗'] },
  { q: '甜口还是咸口？', opts: ['甜口', '咸口'] },
  { q: '你属于早睡型还是晚睡型？', opts: ['早睡型', '晚睡型'] },
  { q: '夏天还是冬天更让你开心？', opts: ['夏天', '冬天'] },
  { q: '火锅辣度怎么选？', opts: ['微辣', '中辣', '特辣', '不吃辣'] },
  { q: '奶茶糖度怎么选？', opts: ['三分糖', '五分糖', '七分糖', '全糖'] },
  { q: '出去玩更想选哪项？', opts: ['逛街', '看电影', '宅家', '运动'] },
  { q: '聚会更爱吃什么？', opts: ['烧烤', '火锅', '炸鸡', '甜品'] },
  { q: '旅行更想去哪里？', opts: ['海边', '山里', '大城市', '国外'] },
  { q: '打游戏更看重什么？', opts: ['赢了开心', '一起玩开心', '随便玩玩'] },
  { q: '手机里最多的表情是什么？', opts: ['笑哭', '赞', '爱心', '狗头'] },
  { q: '追剧更在意什么？', opts: ['剧情', '颜值', '搞笑', '什么都不挑'] },
  { q: '买饮料会先看什么？', opts: ['口味', '颜值包装', '新品', '价格'] },
  { q: '更喜欢哪种放松方式？', opts: ['睡觉', '刷手机', '出门走走', '和朋友聊'] }
];
// syncData.pairs[pairKey] = { score, titles:[], updatedAt }；wall[pairKey] 预留画作墙
let syncData = { pairs: {}, wall: {} };
const syncSessions = new Map();   // pairKey -> 会话（含小游戏状态）
const socketSyncKey = new Map();  // socketId -> pairKey（正在默契页）
const testPairState = new Map();  // 含测试者的组合：默契分只内存体验不落盘
function syncPairKey(a, b) { return [a, b].sort().join('|'); }
function syncNamesOf(key) { return String(key).split('|'); }
function syncIsOfficialPair(a, b) { return OFFICIAL_ACCOUNT_NAMES.includes(a) && OFFICIAL_ACCOUNT_NAMES.includes(b); }
function syncTitlesFor(score) { return SYNC_TITLES.filter(t => score >= t.min).map(t => t.name); }
function syncGetPair(key) {
  if (syncIsOfficialPair(...syncNamesOf(key))) {
    if (!syncData.pairs[key]) syncData.pairs[key] = { score: 0, titles: [], updatedAt: 0 };
    return syncData.pairs[key];
  }
  if (!testPairState.has(key)) testPairState.set(key, { score: 0, titles: [], updatedAt: 0 });
  return testPairState.get(key);
}
function syncSavePair(key) {
  if (PERSIST_SYNC && syncIsOfficialPair(...syncNamesOf(key))) {
    try { fs.writeFileSync(SYNC_FILE, JSON.stringify(syncData, null, 2)); } catch (e) { console.error('❌ 默契空间写入失败：', e.message); }
  }
}
// 默契问答新一轮：抽取 roundQs 道不重复题，重置状态
function syncStartRound(sess) {
  const pool = SYNC_QUESTION_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  sess.phase = 'playing';
  sess.game = 'qa';
  sess.roundQs = pool.slice(0, Math.min(SYNC_ROUND_QS, pool.length));
  sess.qi = 0;
  sess.answers = {};
  sess.gains = 0;
  sess.answered = 0;
}
function syncEmitState(pairKey) {
  const sess = syncSessions.get(pairKey);
  if (!sess) return;
  const p = syncGetPair(pairKey);
  io.to('sync:' + pairKey).emit('sync_state', {
    key: pairKey,
    members: [...sess.members],
    phase: sess.phase,
    game: sess.game || null,
    readyGame: sess.readyGame || null,
    readyVotes: sess.readyVotes || [],
    score: p.score,
    titles: p.titles,
    alias: p.alias || '',
    pendingName: (p.pending && p.pending.name) || '',
    pendingBy: (p.pending && p.pending.by) || ''
  });
}
function syncBroadcastQuestion(pairKey) {
  const sess = syncSessions.get(pairKey);
  if (!sess || sess.phase !== 'playing') return;
  const item = sess.roundQs[sess.qi];
  if (!item) return;
  io.to('sync:' + pairKey).emit('sync_question', { index: sess.qi, q: item.q, opts: item.opts, total: sess.roundQs.length });
}
// 通用：给某组合加默契分，并处理称号解锁与系统祝贺留言
function syncAddScore(pairKey, gain) {
  const pair = syncGetPair(pairKey);
  const before = pair.titles.slice();
  pair.score += gain;
  pair.updatedAt = Date.now();
  pair.titles = syncTitlesFor(pair.score);
  syncSavePair(pairKey);
  const newTitle = pair.titles.find(t => !before.includes(t)) || '';
  if (newTitle && syncIsOfficialPair(...syncNamesOf(pairKey))) {
    const [a, b] = syncNamesOf(pairKey);
    const text = `💐 祝贺 ${getDisplayName(a)} 与 ${getDisplayName(b)} 解锁默契称号「${newTitle}」！`;
    boardMessages.official.push({ name: '系统', text, ts: Date.now() });
    if (boardMessages.official.length > BOARD_MAX) boardMessages.official.shift();
    io.emit('board_new', { type: 'official', msg: { name: '系统', text, ts: Date.now() } });
  }
  return { score: pair.score, titles: pair.titles, newTitle };
}
// 画作墙：按组合追加（每组合最多保留 100 张）
function syncWallAdd(pairKey, entry) {
  if (!syncData.wall) syncData.wall = {};
  if (!syncData.wall[pairKey]) syncData.wall[pairKey] = [];
  syncData.wall[pairKey].push(entry);
  if (syncData.wall[pairKey].length > 100) syncData.wall[pairKey].splice(0, syncData.wall[pairKey].length - 100);
  syncSavePair(pairKey);
}
function syncFinishRound(pairKey) {
  const sess = syncSessions.get(pairKey);
  if (!sess || sess.game !== 'qa') return;
  const gains = sess.gains;
  const res = gains > 0
    ? syncAddScore(pairKey, gains)
    : { score: syncGetPair(pairKey).score, titles: syncGetPair(pairKey).titles, newTitle: '' };
  io.to('sync:' + pairKey).emit('sync_finish', { gain: gains, newScore: res.score, titles: res.titles, newTitle: res.newTitle });
  sess.phase = 'idle';
  sess.game = null;
  sess.roundQs = [];
  sess.answers = {};
  sess.answered = 0;
  sess.gains = 0;
}
// ========== 你画我猜：辅助 ==========
function paintWordLen(w) { return [...String(w)].length; }
function paintSendTo(sess, name, evt, data) {
  const sid = sess.memberSockets && sess.memberSockets[name];
  if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit(evt, data);
}
function paintClearTimer(sess) {
  if (sess.paintTimer) { clearTimeout(sess.paintTimer); sess.paintTimer = null; }
}
// 结束对局（小游戏进行中玩家离开 / 中止时统一复位）
function paintResetPlaying(sess, pairKey) {
  paintClearTimer(sess);
  sess.phase = 'idle';
  sess.game = null;
  sess.roundQs = [];
  sess.answers = {};
  sess.answered = 0;
  sess.gains = 0;
  sess.paint = null;
  sess.readyGame = null;
  sess.readyVotes = [];
}
// 开始一轮你画我猜（自动轮流当画者）
function startPaintRound(pairKey) {
  const sess = syncSessions.get(pairKey);
  if (!sess || sess.members.size < 2) return;
  const [a, b] = sess.players;
  const prev = sess.paint && sess.paint.painter;
  const painter = prev ? (prev === a ? b : a) : (Math.random() < 0.5 ? a : b);
  const guesser = painter === a ? b : a;
  sess.phase = 'playing';
  sess.game = 'paint';
  sess.paint = { painter, guesser, stage: 'word', word: null, strokes: [], attempts: [], deadline: 0, idx: 0 };
  paintSendTo(sess, painter, 'paint_round', { role: 'drawer', stage: 'word' });
  paintSendTo(sess, guesser, 'paint_round', { role: 'guesser', stage: 'word' });
}
function finishPaintRound(pairKey, win) {
  const sess = syncSessions.get(pairKey);
  if (!sess || sess.game !== 'paint' || !sess.paint) return;
  paintClearTimer(sess);
  const pt = sess.paint;
  if (pt.stage === 'end') return;
  pt.stage = 'end';
  const gain = win ? 5 : 0;
  const res = gain > 0
    ? syncAddScore(pairKey, gain)
    : { score: syncGetPair(pairKey).score, titles: syncGetPair(pairKey).titles, newTitle: '' };
  syncWallAdd(pairKey, {
    ts: Date.now(),
    drawer: pt.painter,
    guesser: pt.guesser,
    word: pt.word || '',
    win,
    attempts: (pt.attempts || []).slice(),
    strokes: (pt.strokes || []).slice(),
    wordLen: paintWordLen(pt.word || '')
  });
  io.to('sync:' + pairKey).emit('paint_end', {
    win, word: pt.word || '', gain, newScore: res.score, newTitle: res.newTitle,
    attempts: (pt.attempts || []).slice(), painter: pt.painter, guesser: pt.guesser
  });
}
// 玩家离开默契页（主动 sync_leave / socket 断开共用；自动取消其"准备"，结束进行中的对局）
function syncLeaveKey(name, pk) {
  if (!pk) return;
  const sess = syncSessions.get(pk);
  if (sess) {
    if (sess.memberSockets) delete sess.memberSockets[name];
    sess.members.delete(name);
    sess.readyVotes = (sess.readyVotes || []).filter(n => n !== name);
    if (!sess.readyVotes.length) sess.readyGame = null;
    if (sess.phase === 'playing') paintResetPlaying(sess, pk);
    if (!sess.members.size) syncSessions.delete(pk);
  }
  socketSyncKey.delete(pk);
  syncEmitState(pk);
}

// 启动时读回默契空间数据：PERSIST_SYNC=true（正式部署）读 data/sync.json；否则内存模式
if (PERSIST_SYNC) {
  try { syncData = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')) || { pairs: {}, wall: {} }; }
  catch (e) { syncData = { pairs: {}, wall: {} }; }
  console.log(`✅ 默契空间【正式落盘模式】：已启用环境变量 PERSIST_SYNC=true，已加载 ${Object.keys(syncData.pairs).length} 组组合`);
} else {
  syncData = { pairs: {}, wall: {} };
  console.log('🧪 默契空间处于【内存模式】：开发/测试默认，重启即清空、不写入 data/（正式部署设 PERSIST_SYNC=true 即落盘）');
}

server.listen(3000, () => {
  console.log('🏰 服务器启动：端口 3000');
  console.log('✅ 单房间系统已启动');
  console.log('✅ 自动房主转移已开启');
  console.log('✅ 3秒自动同步已开启');
  console.log('✅ 游戏进行中禁止新玩家入座已开启');
  console.log('✅ 心跳检测（30秒超时）已开启');
  console.log('✅ 主动退出房间逻辑已新增');
  console.log('✅ 游戏状态主动拉取接口已新增');
});