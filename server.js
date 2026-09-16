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

const PUBLIC_DIR = path.join(__dirname, 'public');
// 素材（主题背景/贴纸/头像等）在正式环境启用 7 天缓存 → 再次打开主题页秒出；
// 开发环境仍不缓存，方便改图立即可见。
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), {
  etag: false,
  lastModified: false,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders(res) {
    res.set('Cache-Control', process.env.NODE_ENV === 'production'
      ? 'public, max-age=604800'
      : 'no-cache, no-store, must-revalidate');
  }
}));
// 页面文件：允许"条件缓存"（Etag + max-age=0）——未改动的页面导航时返回 304，秒开；
// 内容变更时 Etag 变化自动重新下载，保证线上更新仍即时生效。
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders(res) {
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
}));

// 健康检查（供 Nginx/pm2/监控轮询；上线后 curl http://<host>:<port>/healthz 应返回 ok）
// 允许跨域：让"休赛期占位页"在别的域名也能探测到服务器在线
app.get('/healthz', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, up: Math.round(process.uptime()) });
});

const HEARTBEAT_TIMEOUT = 30000;


const VALID_KEYS = {
  'youyoukuu2632': '玩家1',
  '326ixnay': '玩家2',
  'ownnn12345': '玩家3',
  'karida1118': '玩家4',
  'test1': '测试者1',
  'test2': '测试者2',
  'test3': '测试者3',
  'test4': '测试者4'
};
const TEST_NAMES = ['测试者1', '测试者2', '测试者3', '测试者4']; // 测试账号（开发者工具/数据跳过落盘用）
const OFFICIAL_PLAYERS = Object.values(VALID_KEYS);
const GUEST_KEY = 'youke888'; // 🎒 游客通道口令（正式部署后请自行再更换）

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
  },
  bomber: {
    roomId: 'bomber_001',
    gameType: 'bomber',
    hostName: null,
    maxPlayers: 4,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  },
  minesweeper: {
    roomId: 'minesweeper_001',
    gameType: 'minesweeper',
    hostName: null,
    maxPlayers: 4,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  },
  othello: {
    roomId: 'othello_001',
    gameType: 'othello',
    hostName: null,
    maxPlayers: 2,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  },
  quoridor: {
    roomId: 'quoridor_001',
    gameType: 'quoridor',
    hostName: null,
    maxPlayers: 4,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  },
  gomoku: {
    roomId: 'gomoku_001',
    gameType: 'gomoku',
    hostName: null,
    maxPlayers: 4,
    seats: { 1: null, 2: null, 3: null, 4: null },
    spectators: [],
    playerMap: new Map(),
    leaveTimers: {}
  },
  puyopuyo: {
    roomId: 'puyopuyo_001',
    gameType: 'puyopuyo',
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

// ===== 成就头衔（按游戏各自一套）=====
// 头衔按品质逐步解锁：解锁该游戏内含 common 即得该游戏的最低头衔，含 rare 再得次阶……
// 例：快艇解锁 common/rare/epic 得「快艇新秀/快艇好手/快艇高手」；画猜得「妙笔新秀/灵魂画师/接龙宗师」。
// 仅 hidden 成就时兜底得该游戏的 hidden 头衔。
// 展示：玩家可在"已解锁头衔"里自由选择（档案 usersData.title 存档）；未选择 = 自动显示最高已解锁。
const ACH_TITLES_BY_GAME = {
  yahtzee: { common: '快艇新秀', rare: '快艇好手', epic: '快艇高手', legend: '快艇大师', hidden: '快艇怪人' },
  // 画猜接龙系列（方案 D 双极风雅，2026-09-06 确认）
  drawing: { common: '妙笔生花', rare: '妙手偶得', epic: '神笔马良', legend: '执笔乾坤', hidden: '灵魂画手' },
  // 炸飞机·烟火师系列（2026-09-07 定稿）
  bomber: {
    common: '雨纷纷 旧故里草木深',
    rare: 'S1烟火师',
    epic: '艺术就是爆炸',
    legend: '宇宙热寂之前',
    hidden: '哑火艺术家' // 未来隐藏成就兜底用
  },
  // 扫雷系列（2026-09-09 定稿：普通 50/50 / 稀有 生存还是毁灭 / 史诗 爱上雷神！ / 传说 天上人间）
  minesweeper: {
    common: '50/50',
    rare: '生存还是毁灭',
    epic: '爱上雷神！',
    legend: '天上人间',
    hidden: '五连绝世' // 隐藏成就兜底
  },
  // 翻转棋系列（2026-09-09 定稿）
  othello: {
    common: '色盲神秘客',
    rare: '易如翻掌',
    epic: '在彩色里朝圣黑白',
    legend: '翻手为云覆手为雨'
  },
  // 路墙棋系列（2026-09-09 定稿）
  quoridor: {
    common: '？！墙墙！？',
    rare: '敢问路在何方',
    epic: '不可一世的堵徒',
    legend: '终将抵达的彼岸'
  },
  // 魔法气泡系列（2026-09-16 按 puyopuyo.md 九.1）
  puyopuyo: {
    common: '漂流手札',
    rare: '天际万彩斑斓',
    epic: '连结万物之诗',
    legend: '彩虹糖，彩虹桥'
  }
};
const ACH_TITLE_ORDER = ['common', 'rare', 'epic', 'legend'];
// 该玩家当前已解锁的可选头衔（低→高；测试账号按自己内存中的测试成就算）
function playerUnlockedTitles(name) {
  if (!OFFICIAL_ACCOUNT_NAMES.includes(name) && !TEST_NAMES.includes(name)) return [];
  const records = isTestAccount(name) ? achTestRecords : achRecords;
  const mine = records.filter(r => r.playerName === name);
  const metas = mine
    .map(r => ACHIEVEMENTS[r.achievementId])
    .filter(Boolean);
  if (!metas.length) return [];
  const out = [];
  for (const game of Object.keys(ACH_TITLES_BY_GAME)) {
    const map = ACH_TITLES_BY_GAME[game];
    const qs = metas.filter(m => m.game === game).map(m => m.quality);
    for (const q of ACH_TITLE_ORDER) if (qs.includes(q)) out.push(map[q]);
    if (qs.includes('hidden') && map.hidden) out.push(map.hidden);
  }
  // 专属“成就 → 头衔”映射（如技能五子棋）
  const idSet = new Set(mine.map(r => r.achievementId));
  for (const [id, title] of Object.entries(ACH_TITLE_BY_ID)) {
    if (idSet.has(id) && title && !out.includes(title)) out.push(title);
  }
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
// 单人局：个人 rank===1 为胜；组队局：本人所在队赢（timeline 带 winners）才算胜
function timelineWin(e, name) {
  if (e.mode === 'team' && Array.isArray(e.winners)) return e.winners.includes(name);
  const my = (e.results || []).find(r => r.name === name);
  return !!(my && my.rank === 1);
}
// 模式排序：个人 2/3/4人 在前；2v2 组队单独一排
function profileModeRank(mk) {
  if (mk === '2v2') return 90;
  const n = parseInt(mk, 10);
  return Number.isFinite(n) ? n : 99;
}
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
    if (timelineWin(e, name)) wins++;
  }
  return { games, wins, winRate: games ? Math.round(wins / games * 100) : 0, totalScore, best };
}
// 某玩家参与的时光墙对局里出现过的游戏，及其各模式（人数/2v2）统计
function buildProfileByGame(name) {
  const games = {};   // gameKey -> { 模式key -> {..} }
  const order = [];
  for (const e of timelineEntries) {
    if (e.type !== 'game') continue;
    const my = (e.results || []).find(r => r.name === name);
    if (!my) continue;
    const gk = e.game || 'other';
    if (!games[gk]) { games[gk] = {}; order.push(gk); }
    const mk = (e.game === 'minesweeper' && e.mode === 'team') ? '2v2' : (e.totalPlayers ? `${e.totalPlayers}人` : '普通');
    const m = games[gk][mk] || { games: 0, wins: 0, totalScore: 0, best: 0, teamScore: 0, teamBest: 0, draws: 0 };
    m.games++;
    m.totalScore += my.score;
    if (my.score > m.best) m.best = my.score;
    if (timelineWin(e, name)) m.wins++;
    if (e.draw) m.draws = (m.draws || 0) + 1;
    if (e.game === 'minesweeper' && e.mode === 'team' && my.teamTotal != null) {
      m.teamScore = (m.teamScore || 0) + my.teamTotal;
      if (my.teamTotal > (m.teamBest || 0)) m.teamBest = my.teamTotal;
    }
    games[gk][mk] = m;
  }
  return order.map(gk => ({
    game: gk,
    modes: Object.keys(games[gk])
      .map(mode => { const s = games[gk][mode]; return { mode, games: s.games, wins: s.wins, winRate: s.games ? Math.round(s.wins / s.games * 100) : 0, totalScore: s.totalScore, best: s.best, teamScore: s.teamScore || 0, teamBest: s.teamBest || 0, draws: s.draws || 0 }; })
      .sort((a, b) => profileModeRank(a.mode) - profileModeRank(b.mode))
  }));
}

// 技能五子棋角色/人数统计（8.1）：
// byPlayers：各人数模式的总战绩 + 该人数下各角色数据；
// rolesAll：各角色总数据 + 该角色在各人数下的场次；
// 名次分只在“继续决出排名”模式的对局里计（未开启则一律 0）
function buildGomokuRoles(name) {
  const byPlayers = {};
  const roleAll = {};
  let total = 0, rankModeGames = 0, totalRankScore = 0, totalFives = 0, wins = 0;
  for (const e of timelineEntries) {
    if (e.type !== 'game' || e.game !== 'gomoku') continue;
    if (!(e.players || []).includes(name)) continue;
    total++;
    const mine = (e.roles || []).find(x => x.name === name) || {};
    const myRes = (e.results || []).find(r => r.name === name) || {};
    totalFives += Number(myRes.fives) || 0;
    if (myRes.rank === 1) wins++;
    const n = e.totalPlayers || (parseInt(e.mode, 10) || 0);
    const key = (n ? n + '人' : '未知人数');
    const bp = byPlayers[key] || (byPlayers[key] = { players: key, games: 0, wins: 0, rankScore: 0, rankModeGames: 0, roles: {} });
    bp.games++;
    if (myRes.rank === 1) bp.wins++;
    const sc = Number(myRes.score) || 0;
    bp.rankScore += sc;
    totalRankScore += sc;
    if (e.rankMode) { bp.rankModeGames++; rankModeGames++; }
    if (mine.role) {
      const r = bp.roles[mine.role] || (bp.roles[mine.role] = { role: mine.role, games: 0, wins: 0 });
      r.games++; if (myRes.rank === 1) r.wins++;
      const ra = roleAll[mine.role] || (roleAll[mine.role] = { role: mine.role, games: 0, wins: 0, byPlayers: {} });
      ra.games++; if (myRes.rank === 1) ra.wins++;
      ra.byPlayers[key] = (ra.byPlayers[key] || 0) + 1;
    }
  }
  const rate = (g, w) => (g ? Math.round(w / g * 100) : 0);
  const numOf = k => (parseInt(k, 10) || 99);
  const byPlayersArr = Object.keys(byPlayers)
    .sort((a, b) => numOf(a) - numOf(b))
    .map(k => {
      const bp = byPlayers[k];
      return {
        players: bp.players, games: bp.games, wins: bp.wins, winRate: rate(bp.games, bp.wins),
        rankScore: bp.rankScore, rankModeGames: bp.rankModeGames,
        roles: Object.values(bp.roles)
          .map(r => ({ role: r.role, games: r.games, wins: r.wins, winRate: rate(r.games, r.wins), pickRate: rate(bp.games, r.games) }))
          .sort((a, b) => b.games - a.games || (a.role < b.role ? -1 : 1))
      };
    });
  const rolesAll = Object.values(roleAll)
    .map(ra => ({
      role: ra.role, games: ra.games, wins: ra.wins, winRate: rate(ra.games, ra.wins), pickRate: rate(total, ra.games),
      byPlayers: Object.keys(ra.byPlayers).sort((a, b) => numOf(a) - numOf(b)).map(k => ({ players: k, games: ra.byPlayers[k] }))
    }))
    .sort((a, b) => b.games - a.games || (a.role < b.role ? -1 : 1));
  return { total, wins, winRate: rate(total, wins), totalFives, rankModeGames, totalRankScore, byPlayers: byPlayersArr, rolesAll };
}


// 魔法气泡个人战绩：场次/胜场/胜率/累计总分/单局最高分/最高连锁
function buildPuyoStats(name) {
  let games = 0, wins = 0, totalScore = 0, best = 0, bestChain = 0, totalChain = 0;
  for (const e of timelineEntries) {
    if (e.type !== 'game' || e.game !== 'puyopuyo') continue;
    const my = (e.results || []).find(r => r.name === name);
    if (!my) continue;
    games++;
    const sc = Number(my.score) || 0, ch = Number(my.maxChain) || 0;
    totalScore += sc; totalChain += ch;
    if (sc > best) best = sc;
    if (ch > bestChain) bestChain = ch;
    if (my.rank === 1) wins++;
  }
  return { games, wins, winRate: games ? Math.round(wins / games * 100) : 0, totalScore, best, bestChain, totalChain };
}

// ===== 快艇排行榜：单局最高分（正式/测试/游客的真实对局都会记录；开发期内存，重启清空） =====
let highScoreBoard = new Map(); // 玩家名 -> 单局最高总分
let highHist = [];               // 分数榜流水（每场每人，可重复）
function recordHighScores(totals) {
  if (!totals) return;
  const ts = Date.now();
  for (const [name, t] of Object.entries(totals)) {
    if (!t || typeof t.total !== 'number') continue;
    const cur = highScoreBoard.get(name) || 0;
    if (t.total > cur) highScoreBoard.set(name, t.total);
    highHist.push({ name, total: t.total, ts });
  }
  if (highHist.length > 300) highHist = highHist.slice(-300);
  saveBoardStats();
}

// ===== 炸飞机「烟火师」榜：单局炸毁机头数（= 单局击落飞机数） =====
let bomberSparkBoard = new Map(); // 玩家名 -> 单局最高机头炸毁数
let bomberHist = [];              // 烟火师分数流水（每局每人）
// ===== 扫雷榜数据（含 个人/组队 + 最佳/分数流水，P3）=====
let msBestBoard = new Map();     // 玩家名 -> 个人单场最高分
let msHistory = [];              // 个人分数流水（可重复上榜）
let msTeamBest = new Map();      // 组合键(玩家A\u0001玩家B) -> 该组合最好合计分
let msTeamHistory = [];          // 组队合计流水
let msFlagTotals = new Map();    // 玩家名 -> 累计正确插旗数（旗手 C/B/A/S1 成就）
let msBestInfo = new Map();      // 玩家名 -> 最佳成绩来源 {mode:'solo'/'team', partner}（2v2 个人分上榜标注用）
let othBestBoard = new Map();    // 玩家名 -> 翻转棋单局最高终局棋子数
let othHistory = [];             // 翻转棋终局棋子数流水
function recordBomberSparks(g) {
  if (!g) return;
  const ts = Date.now();
  for (const n of g.playerOrder) {
    const v = (g.stats && g.stats[n] && g.stats[n].shipsDown) || 0;
    if (v > 0 && v > (bomberSparkBoard.get(n) || 0)) bomberSparkBoard.set(n, v);
    if (v > 0) bomberHist.push({ name: n, score: v, ts });
  }
  if (bomberHist.length > 300) bomberHist = bomberHist.slice(-300);
  saveBoardStats();
}
function bomberRankOf(g, n) {
  if (!g.over) return 0;
  if (n === g.over.winner) return 1;
  return ((g.elimOrder || []).indexOf(n) + 2) || 2;
}
// 炸飞机真实整局 → 时光墙（score = 本局炸毁机头数，与个人空间/烟火师榜口径一致）
function recordBomberGame(g) {
  if (!g || !g.over) return;
  const officials = g.playerOrder.filter(isOfficialPlayer);
  if (!officials.length) return;
  addTimeline({
    ts: Date.now(),
    type: 'game',
    game: 'bomber',
    totalPlayers: g.playerOrder.length,
    players: officials,
    results: officials.map(n => {
      const heads = (g.stats && g.stats[n] && g.stats[n].shipsDown) || 0;
      return { name: n, score: heads, rank: bomberRankOf(g, n), heads };
    })
  });
}

function msComboKey(a, b) { return a < b ? (a + '\u0001' + b) : (b + '\u0001' + a); }
function msTeammate(g, n) { return g.playerOrder.find(x => x !== n && g.teams && g.teams[x] === g.teams[n]) || null; }
function recordMinesweeperGame(g, room) {
  if (!g || !g.over || g._recorded) return;
  g._recorded = true;
  const ts = Date.now();
  // 个人：每场记录都进流水（可重复上榜），最佳只保留更高
  for (const n of g.playerOrder) {
    const score = g.scores[n] || 0;
    const partner = g.mode === 'team' ? msTeammate(g, n) : null;
    msHistory.push({ name: n, score, mode: g.mode, partner, ts });
    if (score > (msBestBoard.get(n) || 0)) {
      msBestBoard.set(n, score);
      msBestInfo.set(n, { mode: g.mode, partner: partner || null });
    }
  }
  // 旗手累计：每局每人正确插旗数汇入终身累计，跨档才解锁（避免反复播报低档）
  for (const n of g.playerOrder) {
    const hits = g.flagHits[n] || 0;
    if (!hits) continue;
    const prev = msFlagTotals.get(n) || 0;
    const total = prev + hits;
    msFlagTotals.set(n, total);
    for (const [id, th] of MS_FLAG_LEVELS) {
      if (prev < th && total >= th) announceAchievement(g, g.roomId, n, id);
    }
  }
  if (msHistory.length > 300) msHistory = msHistory.slice(-300);
  // 组队：按队伍记合计分
  if (g.mode === 'team' && g.teams) {
    ['A', 'B'].forEach(t => {
      const mem = g.playerOrder.filter(x => g.teams[x] === t);
      if (mem.length < 2) return;
      const [a, b] = mem;
      const total = (g.scores[a] || 0) + (g.scores[b] || 0);
      const win = (g.over.winnerNames || []).length && g.over.winnerNames.some(x => g.teams[x] === t);
      msTeamHistory.push({ players: [a, b], total, win, ts });
      const key = msComboKey(a, b);
      if (total > (msTeamBest.get(key) || 0)) msTeamBest.set(key, total);
    });
    if (msTeamHistory.length > 300) msTeamHistory = msTeamHistory.slice(-300);
  }
  // 时光墙：正式玩家整局（个人分 + 组队合计分）
  const officials = g.playerOrder.filter(isOfficialPlayer);
  if (officials.length) {
    const sorted = g.playerOrder.slice().sort((x, y) => (g.scores[y] || 0) - (g.scores[x] || 0));
    const teamTot = {};
    if (g.mode === 'team' && g.teams) {
      officials.forEach(n => {
        const mem = g.playerOrder.filter(x => g.teams[x] === g.teams[n]);
        teamTot[n] = mem.reduce((a, x) => a + (g.scores[x] || 0), 0);
      });
    }
    addTimeline({
      ts, type: 'game', game: 'minesweeper', totalPlayers: g.playerOrder.length,
      mode: g.mode,
      players: officials,
      winners: Array.isArray(g.over.winnerNames) ? g.over.winnerNames.slice() : undefined,
      results: officials.map(n => ({ name: n, score: g.scores[n] || 0, rank: sorted.indexOf(n) + 1, teamTotal: teamTot[n] || null, teamWin: !!(Array.isArray(g.over.winnerNames) && g.over.winnerNames.includes(n)) }))
    });
  }
  saveBoardStats();
}
// ===== 排行榜持久化：三个内存榜（快艇/花菜/烟火师）写入 data/boards.json，重启不丢 =====
const BOARDS_STATS_FILE = path.join(DATA_DIR, 'boards.json');
function saveBoardStats() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOARDS_STATS_FILE, JSON.stringify({
      yahtzee: Object.fromEntries(highScoreBoard),
      drawing: Object.fromEntries(drawingHighBoard),
      bomber: Object.fromEntries(bomberSparkBoard),
      msBest: Object.fromEntries(msBestBoard),
      msBestInfo: Object.fromEntries(msBestInfo),
      msHistory: msHistory,
      msTeamBest: Object.fromEntries(msTeamBest),
      msTeamHistory: msTeamHistory,
      msFlagTotals: Object.fromEntries(msFlagTotals),
      othBest: Object.fromEntries(othBestBoard),
      othHistory: othHistory,
      yHist: highHist, dHist: drawingHist, bHist: bomberHist
    }, null, 2), 'utf8');
  } catch (e) { console.error('❌ 排行榜写入失败：', e.message); }
}
function loadBoardStats() {
  try {
    const o = JSON.parse(fs.readFileSync(BOARDS_STATS_FILE, 'utf8')) || {};
    if (o.yahtzee) highScoreBoard = new Map(Object.entries(o.yahtzee));
    if (o.drawing) drawingHighBoard = new Map(Object.entries(o.drawing));
    if (o.bomber) bomberSparkBoard = new Map(Object.entries(o.bomber));
    if (o.msBest) msBestBoard = new Map(Object.entries(o.msBest));
    if (o.msBestInfo) msBestInfo = new Map(Object.entries(o.msBestInfo));
    if (Array.isArray(o.msHistory)) msHistory = o.msHistory;
    if (o.msTeamBest) msTeamBest = new Map(Object.entries(o.msTeamBest));
    if (Array.isArray(o.msTeamHistory)) msTeamHistory = o.msTeamHistory;
    if (o.msFlagTotals) msFlagTotals = new Map(Object.entries(o.msFlagTotals));
    if (o.othBest) othBestBoard = new Map(Object.entries(o.othBest));
    if (Array.isArray(o.othHistory)) othHistory = o.othHistory;
    if (Array.isArray(o.yHist)) highHist = o.yHist;
    if (Array.isArray(o.dHist)) drawingHist = o.dHist;
    if (Array.isArray(o.bHist)) bomberHist = o.bHist;
    console.log(`📊 排行榜已加载：快艇 ${highScoreBoard.size} 条 / 花菜 ${drawingHighBoard.size} 条 / 烟火师 ${bomberSparkBoard.size} 条 / 扫雷个人 ${msBestBoard.size} 条 / 扫雷组队 ${msTeamBest.size} 条`);
  } catch (e) { /* 无文件/旧版：正常空榜 */ }
}

// ===== 开发者预览：扫雷生态种子（仅测试账号；可一键清除后重造，带 _seedMs 标记） =====
let msSeedTrack = null; // { best:Map, team:Map, flag:Map } 记录上次种子对榜单的增量，方便清理
function msPreviewClean() {
  if (!msSeedTrack) return;
  msHistory = msHistory.filter(r => !r._seedMs);
  msTeamHistory = msTeamHistory.filter(r => !r._seedMs);
  timelineEntries = timelineEntries.filter(e => !e._seedMs);
  for (const [n, d] of msSeedTrack.best) {
    const c = msBestBoard.get(n) || 0;
    if (c - d > 0) msBestBoard.set(n, c - d); else msBestBoard.delete(n);
    const oldInfo = (msSeedTrack.info || new Map()).get(n);
    if (oldInfo !== undefined) {
      if (oldInfo) msBestInfo.set(n, oldInfo); else msBestInfo.delete(n);
    } else if (c - d <= 0) {
      msBestInfo.delete(n);
    }
  }
  for (const [k, d] of msSeedTrack.team) {
    const c = msTeamBest.get(k) || 0;
    if (c - d > 0) msTeamBest.set(k, c - d); else msTeamBest.delete(k);
  }
  for (const [n, d] of msSeedTrack.flag) {
    const c = msFlagTotals.get(n) || 0;
    if (c - d > 0) msFlagTotals.set(n, c - d); else msFlagTotals.delete(n);
  }
  msSeedTrack = null;
  saveBoardStats();
}
function recalcSeedTotals(byGame) {
  const t = { games: 0, wins: 0, totalScore: 0, best: 0 };
  for (const g of byGame) for (const m of (g.modes || [])) {
    t.games += m.games; t.wins += m.wins; t.totalScore += m.totalScore;
    if (m.best > t.best) t.best = m.best;
  }
  t.winRate = t.games ? Math.round(t.wins / t.games * 100) : 0;
  return t;
}
function msProfileRemoveMine(name) {
  const seed = testProfileSeeds.get(name);
  if (!seed || !seed.byGame.some(g => g.game === 'minesweeper')) return;
  const byGame = seed.byGame.filter(g => g.game !== 'minesweeper');
  testProfileSeeds.set(name, Object.assign({}, seed, { byGame, totals: recalcSeedTotals(byGame) }));
}
function msProfileMergeMine(name, mineModes) {
  const seed = testProfileSeeds.get(name) || seedTestProfile(name);
  const byGame = seed.byGame.filter(g => g.game !== 'minesweeper').concat([{ game: 'minesweeper', modes: mineModes }]);
  testProfileSeeds.set(name, Object.assign({}, seed, { byGame, totals: recalcSeedTotals(byGame) }));
}
// 造一批扫雷对局并写进各内存榜；返回当前账号四种模式维度（供个人空间种子）
function seedMsBoardsInto(profileName) {
  msPreviewClean();
  const ts = Date.now();
  const solo = [
    { n: 2, sc: [88, 52], fl: [6, 4] },
    { n: 2, sc: [61, 77], fl: [3, 5] },
    { n: 3, sc: [90, 55, 20], fl: [7, 4, 2] },
    { n: 3, sc: [40, 66, 71], fl: [3, 5, 6] },
    { n: 4, sc: [74, 63, 50, 84], fl: [6, 5, 4, 8] },
    { n: 4, sc: [95, 20, 45, 60], fl: [9, 2, 3, 5] }
  ];
  const team = [
    { names: ['测试者1', '测试者2'], sc: [72, 60], fl: [6, 4], winTeam: true },
    { names: ['测试者3', '测试者4'], sc: [55, 80], fl: [5, 7], winTeam: true }
  ];
  const track = { best: new Map(), team: new Map(), flag: new Map(), info: new Map() };
  const gamesMeta = []; // {mode, players, scores, winners}
  let timeOff = 0;
  solo.forEach(row => {
    const players = TEST_NAMES.slice(0, row.n);
    const max = Math.max(...row.sc);
    const winners = players.filter((_, i) => row.sc[i] === max);
    gamesMeta.push({ mode: 'solo', n: row.n, players, scores: row.sc, winners });
    row.sc.forEach((score, i) => {
      const n = players[i]; const f = row.fl[i] || 0;
      const oldBest = msBestBoard.get(n) || 0;
      if (score > oldBest) {
        msBestBoard.set(n, score);
        if (!track.info.has(n)) track.info.set(n, msBestInfo.get(n) || null);
        msBestInfo.set(n, { mode: 'solo', partner: null });
        track.best.set(n, (track.best.get(n) || 0) + (score - oldBest));
      }
      msHistory.push({ name: n, score, mode: 'solo', partner: null, ts: ts - timeOff * 60000, flagHits: f, _seedMs: true });
      const oldF = msFlagTotals.get(n) || 0;
      msFlagTotals.set(n, oldF + f);
      track.flag.set(n, (track.flag.get(n) || 0) + f);
    });
    timeOff++;
  });
  team.forEach(row => {
    const total = row.sc[0] + row.sc[1];
    const key = msComboKey(row.names[0], row.names[1]);
    const oldT = msTeamBest.get(key) || 0;
    if (total > oldT) { msTeamBest.set(key, total); track.team.set(key, (track.team.get(key) || 0) + (total - oldT)); }
    msTeamHistory.push({ players: row.names.slice(), total, win: row.winTeam, ts: ts - timeOff * 60000, _seedMs: true });
    row.names.forEach((n, i) => {
      const score = row.sc[i]; const f = row.fl[i] || 0;
      const partner = row.names[1 - i];
      const oldBest = msBestBoard.get(n) || 0;
      if (score > oldBest) {
        msBestBoard.set(n, score);
        if (!track.info.has(n)) track.info.set(n, msBestInfo.get(n) || null);
        msBestInfo.set(n, { mode: 'team', partner });
        track.best.set(n, (track.best.get(n) || 0) + (score - oldBest));
      }
      msHistory.push({ name: n, score, mode: 'team', partner, ts: ts - timeOff * 60000, flagHits: f, _seedMs: true });
      const oldF = msFlagTotals.get(n) || 0;
      msFlagTotals.set(n, oldF + f);
      track.flag.set(n, (track.flag.get(n) || 0) + f);
    });
    gamesMeta.push({ mode: 'team', n: 4, players: row.names.slice(), scores: row.sc.slice(), winners: row.winTeam ? row.names.slice() : [] });
    timeOff++;
  });
  // 时光墙：模式 / 胜者 / 个人分都在，个人空间与时光墙都可预览
  gamesMeta.forEach((gm, i) => {
    const sorted = gm.players.map((n, idx) => ({ n, s: gm.scores[idx] })).sort((a, b) => b.s - a.s);
    addTimeline({
      ts: ts - (timeOff - 1 - i) * 60000, type: 'game', game: 'minesweeper', totalPlayers: gm.n, mode: gm.mode,
      players: gm.players.slice(),
      winners: gm.winners.slice(),
      results: gm.players.map((n, idx) => ({ name: n, score: gm.scores[idx], rank: sorted.findIndex(x => x.n === n) + 1, teamTotal: gm.mode === 'team' ? gm.scores.reduce((x, y) => x + y, 0) : null, teamWin: gm.winners.includes(n) })),
      _test: true, _seedMs: true
    });
  });
  msSeedTrack = track;
  saveBoardStats();
  // 旗手演示：预览种子把累计数灌进后，按真实“跨档才解锁”口径补一次记录（每档每人最多一次）
  const fakeGame = { mock: false, achievementsByPlayer: {} };
  for (const t of TEST_NAMES) {
    const total = msFlagTotals.get(t) || 0;
    for (const [id, need] of MS_FLAG_LEVELS) {
      if (total >= need && !achTestRecords.some(r => r.playerName === t && r.achievementId === id)) {
        announceAchievement(fakeGame, 'dev_ms_preview', t, id);
      }
    }
  }
  // 个人空间需要按“模式×人数”聚合（含 2v2 组队独立成行）
  const agg = {};
  gamesMeta.forEach(gm => {
    const mk = gm.mode === 'team' ? '2v2' : (gm.n + '人');
    gm.players.forEach((n, idx) => {
      const a = (agg[n] = agg[n] || {});
      const m = (a[mk] = a[mk] || { games: 0, wins: 0, totalScore: 0, best: 0, teamScore: 0, teamBest: 0 });
      m.games++;
      m.totalScore += gm.scores[idx];
      if (gm.scores[idx] > m.best) m.best = gm.scores[idx];
      if (gm.winners.includes(n)) m.wins++;
      if (gm.mode === 'team') {
        const tot = gm.scores.reduce((x, y) => x + y, 0);
        m.teamScore = (m.teamScore || 0) + tot;
        if (tot > (m.teamBest || 0)) m.teamBest = tot;
      }
    });
  });
  const order = ['2人', '3人', '4人', '2v2'];
  const profileModes = order.map(mk => {
    const s = agg[profileName] && agg[profileName][mk];
    return s ? { mode: mk, games: s.games, wins: s.wins, winRate: Math.round(s.wins / s.games * 100), totalScore: s.totalScore, best: s.best, teamScore: s.teamScore || 0, teamBest: s.teamBest || 0 }
      : { mode: mk, games: 0, wins: 0, winRate: 0, totalScore: 0, best: 0, teamScore: 0, teamBest: 0 };
  });
  return { solo: solo.length, team: team.length, profileModes };
}

// ===== 开发者预览：翻转棋生态种子（榜单/流水/时光墙/个人战绩；带 _seedOth 标记，可清除重造） =====
let othSeedTrack = null; // { best: Map }
function othPreviewClean() {
  if (!othSeedTrack) return;
  othHistory = othHistory.filter(r => !r._seedOth);
  timelineEntries = timelineEntries.filter(e => !e._seedOth);
  for (const [n, d] of othSeedTrack.best) {
    const c = othBestBoard.get(n) || 0;
    if (c - d > 0) othBestBoard.set(n, c - d); else othBestBoard.delete(n);
  }
  othSeedTrack = null;
  saveBoardStats();
}
function othProfileRemoveMine(name) {
  const seed = testProfileSeeds.get(name);
  if (!seed || !seed.byGame.some(g => g.game === 'othello')) return;
  const byGame = seed.byGame.filter(g => g.game !== 'othello');
  testProfileSeeds.set(name, Object.assign({}, seed, { byGame, totals: recalcSeedTotals(byGame) }));
}
function othProfileMergeMine(name, mineModes) {
  const seed = testProfileSeeds.get(name) || seedTestProfile(name);
  const byGame = seed.byGame.filter(g => g.game !== 'othello').concat([{ game: 'othello', modes: mineModes }]);
  testProfileSeeds.set(name, Object.assign({}, seed, { byGame, totals: recalcSeedTotals(byGame) }));
}
// 造 4 局 2 人对局（含一局平局）；返回当前账号在“2人”模式的聚合数据
function seedOthPreviewInto(profileName) {
  othPreviewClean();
  const ts = Date.now();
  const games = [
    { black: '测试者1', white: '测试者2', b: 40, w: 24 },
    { black: '测试者2', white: '测试者1', b: 28, w: 36 },
    { black: '测试者3', white: '测试者1', b: 30, w: 34 },
    { black: '测试者4', white: '测试者1', b: 32, w: 32 }
  ];
  const track = { best: new Map() };
  const agg = { games: 0, wins: 0, draws: 0, totalScore: 0, best: 0 };
  games.forEach((gm, i) => {
    const players = [gm.black, gm.white];
    const draw = gm.b === gm.w;
    const winners = draw ? [] : [gm.b > gm.w ? gm.black : gm.white];
    const mkScore = n => players[0] === n ? gm.b : gm.w;
    players.forEach(n => {
      const score = mkScore(n);
      othHistory.push({ name: n, score, ts: ts - (games.length - i) * 60000, draw, _seedOth: true });
      const old = othBestBoard.get(n) || 0;
      if (score > old) { othBestBoard.set(n, score); track.best.set(n, (track.best.get(n) || 0) + (score - old)); }
    });
    addTimeline({
      ts: ts - (games.length - i) * 60000, type: 'game', game: 'othello', totalPlayers: 2, mode: 'solo',
      draw, black: gm.b, white: gm.w,
      players: players.slice(), winners: winners.slice(),
      results: players.map(n => {
        const score = mkScore(n);
        return { name: n, score, rank: draw ? 0 : (score > (players[0] === n ? gm.w : gm.b) ? 1 : 2), draw, black: gm.b, white: gm.w };
      }),
      _test: true, _seedOth: true
    });
    if (players.includes(profileName)) {
      const me = mkScore(profileName), foe = players[0] === profileName ? gm.w : gm.b;
      agg.games++;
      agg.totalScore += me;
      if (me > agg.best) agg.best = me;
      if (draw) agg.draws++;
      else if (me > foe) agg.wins++;
    }
  });
  othSeedTrack = track;
  saveBoardStats();
  const winRate = agg.games ? Math.round(agg.wins / agg.games * 100) : 0;
  return { modes: [{ mode: '2人', games: agg.games, wins: agg.wins, draws: agg.draws, winRate, totalScore: agg.totalScore, best: agg.best }] };
}


// ===== 画猜接龙（花菜）榜与战绩 =====
let drawingHighBoard = new Map(); // 玩家名 -> 单局最高分
let drawingHist = [];             // 花菜分数流水（每局每人）
loadBoardStats();
function recordDrawingHighScores(g) {
  if (!g) return;
  const ts = Date.now();
  for (const n of g.order) {
    const p = g.points[n] || 0;
    const cur = drawingHighBoard.get(n) || 0;
    if (p > cur) drawingHighBoard.set(n, p);
    drawingHist.push({ name: n, score: p, ts });
  }
  if (drawingHist.length > 300) drawingHist = drawingHist.slice(-300);
  saveBoardStats();
}
// 画猜一局（进入 result）→ 写时光墙（只记正式玩家，带 MVP/罪魁票数）+ 花菜榜（所有参与者）
function recordDrawingGame(g) {
  const officials = g.order.filter(isOfficialPlayer);
  if (officials.length) {
    const orderAll = g.order.slice().sort((a, b) => (g.points[b] || 0) - (g.points[a] || 0));
    addTimeline({
      ts: Date.now(),
      type: 'game',
      game: 'drawing',
      totalPlayers: g.order.length,
      players: officials,
      results: officials.map(n => ({
        name: n,
        score: g.points[n] || 0,
        rank: orderAll.indexOf(n) + 1,
        mvpVotes: (g.mvpVotes && g.mvpVotes[n]) || 0,
        culpritVotes: (g.culpritVotes && g.culpritVotes[n]) || 0
      }))
    });
  }
  recordDrawingHighScores(g);
}
// 花菜专属战绩（正式玩家，来自时光墙对局记录）
function buildDrawingCareer(name) {
  const c = { games: 0, wins: 0, winRate: 0, totalScore: 0, best: 0, mvp: 0, culprit: 0 };
  for (const e of timelineEntries) {
    if (e.type !== 'game' || e.game !== 'drawing') continue;
    const my = (e.results || []).find(r => r.name === name);
    if (!my) continue;
    c.games++;
    c.totalScore += my.score || 0;
    if ((my.score || 0) > c.best) c.best = my.score || 0;
    if (my.rank === 1) c.wins++;
    c.mvp += my.mvpVotes || 0;
    c.culprit += my.culpritVotes || 0;
  }
  c.winRate = c.games ? Math.round(c.wins / c.games * 100) : 0;
  return c;
}

// ===== 测试个人空间：仅测试者自己可见的模拟战绩（内存种子，方便预览页面，无需真实打局） =====
const testProfileSeeds = new Map();
function gmkProfileRemoveMine(name) {
  const seed = testProfileSeeds.get(name);
  if (!seed || !seed.byGame.some(g => g.game === 'gomoku')) return;
  const byGame = seed.byGame.filter(g => g.game !== 'gomoku');
  testProfileSeeds.set(name, Object.assign({}, seed, { byGame, totals: recalcSeedTotals(byGame) }));
}
function gmkProfileMergeMine(name, modes) {
  const seed = testProfileSeeds.get(name) || seedTestProfile(name);
  const byGame = seed.byGame.filter(g => g.game !== 'gomoku').concat([{ game: 'gomoku', modes }]);
  testProfileSeeds.set(name, Object.assign({}, seed, { byGame, totals: recalcSeedTotals(byGame) }));
}
function seedTestProfile(name) {
  const byGame = [{
    game: 'yahtzee',
    modes: [
      { mode: '2人', games: 2, wins: 1, winRate: 50, totalScore: 486, best: 312 },
      { mode: '3人', games: 3, wins: 2, winRate: 67, totalScore: 980, best: 336 },
      { mode: '4人', games: 1, wins: 0, winRate: 0, totalScore: 278, best: 278 }
    ]
  }, {
    game: 'drawing',
    modes: [
      { mode: '4人', games: 4, wins: 1, winRate: 25, totalScore: 30, best: 13 }
    ]
  }, {
    game: 'bomber',
    modes: [
      { mode: '2人', games: 1, wins: 0, winRate: 0, totalScore: 2, best: 2 },
      { mode: '4人', games: 2, wins: 1, winRate: 50, totalScore: 7, best: 4 }
    ]
  }, {
    game: 'minesweeper',
    modes: [
      { mode: '2人', games: 1, wins: 1, winRate: 100, totalScore: 55, best: 55 },
      { mode: '3人', games: 2, wins: 1, winRate: 50, totalScore: 91, best: 60 },
      { mode: '4人', games: 2, wins: 1, winRate: 50, totalScore: 64, best: 44 },
      { mode: '2v2', games: 3, wins: 2, winRate: 67, totalScore: 159, best: 66, teamScore: 281, teamBest: 112 }
    ]
  }, {
    game: 'othello',
    modes: [
      { mode: '2人', games: 5, wins: 2, draws: 1, winRate: 40, totalScore: 118, best: 40 }
    ]
  }];
  const totals = { games: 23, wins: 11, winRate: 48, totalScore: 2261, best: 336 };
  const drawingCareer = { games: 4, wins: 1, winRate: 25, totalScore: 30, best: 13, mvp: 6, culprit: 4 };
  testProfileSeeds.set(name, { totals, byGame, drawingCareer });
  return { totals, byGame, drawingCareer };
}

// 正式玩家档案（内存态 + users.json 落盘）：开发期也落盘，便于测试改昵称/主题
let usersData = {};
const THEMES = ['initial', 'p1', 'p2', 'p3', 'p4', 'pomelo', 'agly', 'lyff']; // 已知主题集合
// 专属主题归属：每位正式玩家可拥有 1~N 个素材主题（玩家3：p3/pomelo；玩家1：p1/agly；玩家4：p4/姥爷纷飞=lyff）
const OWNER_THEMES = { '玩家1': ['p1', 'agly'], '玩家2': ['p2'], '玩家3': ['p3', 'pomelo'], '玩家4': ['p4', 'lyff'] };

// 默认主题：正式玩家 = 自己最新的专属主题（无需在服务器存记录也生效，避免“闪回初始”）；
// 测试账号默认体验 p1；主动在设置里选了“初始配色”才真正显示纯初始。
function defaultThemeFor(name) {
  if (isTestAccount(name)) return 'p1';
  if (name === '玩家3') return 'pomelo'; // 玩家3 默认 = pomelo
  const own = OWNER_THEMES[name];
  if (own && own.length) return own[0]; // 默认 = 玩家基础专属主题（玩家1=p1、玩家2=p2、玩家4=p4）
  return 'initial';
}
function resolveUserTheme(name) {
  const u = usersData[name];
  return (u && u.theme) ? u.theme : defaultThemeFor(name);
}
// ===== 表情包：清单（p1~p4 专属 + 通用；不区分通用/专属文案，纯平铺） =====
const EXPR_DIRS = [
  { key: 'bqb1', dir: 'p1/bqb1', owner: '玩家1' },
  { key: 'bqb2', dir: 'p2/bqb2', owner: '玩家2' },
  { key: 'bqb3', dir: 'p3/bqb3', owner: '玩家3' },
  { key: 'bqb4', dir: 'p4/bqb4', owner: '玩家4' },
  { key: 'common', dir: 'p1/表情包通用', owner: null } // 通用包（界面不写“通用/专属”字样）
];
let EXPR_CACHE = null;
function exprList() {
  if (EXPR_CACHE) return EXPR_CACHE;
  const out = [];
  for (const p of EXPR_DIRS) {
    const folder = path.join(__dirname, 'public', 'assets', 'avatars', p.dir);
    let files = [];
    try { files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.png')); } catch (e) { /* 目录不存在跳过 */ }
    files.forEach(f => {
      out.push({
        id: f.slice(0, -4), // 去掉 .png，其余按原文件名
        url: '/assets/avatars/' + p.dir.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(f),
        owner: p.owner
      });
    });
  }
  EXPR_CACHE = out;
  return out;
}
function exprAllowedFor(name) {
  return exprList().filter(x => !x.owner || x.owner === name);
}
// 正式玩家的“上次离线时间”写入 users.json（重启后仍记得）
function persistLastOffline(name) {
  if (!OFFICIAL_ACCOUNT_NAMES.includes(name)) return;
  const now = Date.now();
  usersData[name] = usersData[name] || {};
  if (now > (usersData[name].lastOffline || 0)) {
    usersData[name].lastOffline = now;
    saveUsers();
  }
}

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
  low_score:        { name: '认真的吗？',        quality: 'hidden', game: 'yahtzee' },
  // ===== 画猜接龙（drawing）成就 =====
  dg_fmvp:          { name: 'FMVP',              quality: 'common', game: 'drawing' },
  dg_spirit:        { name: '灵魂画手',          quality: 'common', game: 'drawing' },
  dg_cabbage_grand: { name: '花菜大满贯',        quality: 'rare', game: 'drawing' },
  dg_cabbage_killer:{ name: '花菜杀手',          quality: 'rare', game: 'drawing' },
  // ===== 炸飞机（bomber）成就（cj1.md） =====
  bomber_edge:      { name: '描边大师',          quality: 'common', game: 'bomber' },
  bomber_bounce:    { name: '蹦蹦炸弹',          quality: 'common', game: 'bomber' },
  bomber_first:     { name: '开门红',            quality: 'rare',   game: 'bomber' },
  bomber_unlucky:   { name: '倒霉路人',          quality: 'epic',   game: 'bomber' },
  bomber_streak2:   { name: '世一炸·2连击',      quality: 'common', game: 'bomber', base: '世一炸', group: 'bomber_streak' },
  bomber_streak3:   { name: '世一炸·3连击',      quality: 'rare',   game: 'bomber', base: '世一炸', group: 'bomber_streak' },
  bomber_streak4:   { name: '世一炸·4连击',      quality: 'epic',   game: 'bomber', base: '世一炸', group: 'bomber_streak' },
  bomber_streak5:   { name: '世一炸·5连击+',     quality: 'legend', game: 'bomber', base: '世一炸', group: 'bomber_streak' },
  // ===== 扫雷（minesweeper）成就：规格见 minesweeper.md §十八 =====
  // 仅 2v2 可触发：ms_mate（需队友同格）、ms_pepper（组队获胜且个人高于队友≥30）、ms_own（组队局全程不撞任何人）
  ms_god:      { name: '神の扫雷',      quality: 'common', game: 'minesweeper' },
  ms_reverse:  { name: '反向默契',      quality: 'common', game: 'minesweeper' },
  ms_mate:     { name: '队友啊！队友',  quality: 'common', game: 'minesweeper' },
  ms_pepper:   { name: '年锦来椒人',    quality: 'common', game: 'minesweeper' },
  ms_own:      { name: '另辟蹊径',      quality: 'rare',   game: 'minesweeper' },
  ms_penta:    { name: '五连绝世',      quality: 'hidden', game: 'minesweeper' },
  ms_flag_c:   { name: 'C牌旗手',       quality: 'common', game: 'minesweeper', base: '旗手', group: 'ms_flag' },
  ms_flag_b:   { name: 'B牌旗手',       quality: 'rare',   game: 'minesweeper', base: '旗手', group: 'ms_flag' },
  ms_flag_a:   { name: 'A牌旗手',       quality: 'epic',   game: 'minesweeper', base: '旗手', group: 'ms_flag' },
  ms_flag_s1:  { name: 'S1旗手',        quality: 'legend', game: 'minesweeper', base: '旗手', group: 'ms_flag' },
  // ===== 翻转棋（othello）成就（2026-09-09 定稿） =====
  oth_corners:  { name: '打地鼠',    quality: 'common', game: 'othello' },
  oth_draw:     { name: '平局圣佛',  quality: 'common', game: 'othello' },
  oth_multi:    { name: '何谈翻啊',  quality: 'rare',   game: 'othello' },
  oth_wipe:     { name: '领土战争',  quality: 'rare',   game: 'othello' },
  oth_basin:    { name: '风水盆地',  quality: 'epic',   game: 'othello' },
  oth_perfect:  { name: '完美主义',  quality: 'legend', game: 'othello' },
  // ===== 路墙棋（quoridor）成就（2026-09-09 定稿） =====
  q_wall10:  { name: '一堵定乾坤',   quality: 'common', game: 'quoridor' },
  q_builder: { name: '天选建筑师',   quality: 'common', game: 'quoridor' },
  q_fast:    { name: '镜流与近路',   quality: 'rare',   game: 'quoridor' },
  q_step:    { name: '步步为营',     quality: 'rare',   game: 'quoridor' },
  q_real:    { name: '真·步步为营',  quality: 'epic',   game: 'quoridor' },
  q_s1:      { name: 'S1导演',       quality: 'legend', game: 'quoridor' },
  // ===== 技能五子棋（gomoku）成就（2026-09-09 定稿，头衔为“成就→头衔”专属映射） =====
  gm_destiny:   { name: '天命所归',        quality: 'rare',   game: 'gomoku' },
  gm_moyu:      { name: '摸到深处自然卷',  quality: 'rare',   game: 'gomoku' },
  gm_decode:    { name: '截码战の传说',    quality: 'epic',   game: 'gomoku' },
  gm_slow:      { name: '手慢无',          quality: 'hidden', game: 'gomoku' },
  gm_fool:      { name: '愚言家',          quality: 'hidden', game: 'gomoku' },
  gm_lucky:     { name: '好运连连',        quality: 'common', game: 'gomoku' },
  gm_seal:      { name: '此树是我栽此格是我占', quality: 'common', game: 'gomoku' },
  gm_clean:     { name: '大扫除',          quality: 'common', game: 'gomoku' },
  gm_detective: { name: '真相不止一个',    quality: 'common', game: 'gomoku' },
  gm_soul:      { name: '中元快乐',        quality: 'rare',   game: 'gomoku' },
  // ===== 魔法气泡（puyopuyo）成就（按 puyopuyo.md 第九章） =====
  pp_chain3:    { name: '连锁大师·铜',    quality: 'common', game: 'puyopuyo' },
  pp_chain5:    { name: '连锁大师·银',    quality: 'rare',   game: 'puyopuyo' },
  pp_chain7:    { name: '连锁大师·金',    quality: 'epic',   game: 'puyopuyo' },
  pp_chain9:    { name: '连锁大师·钻',    quality: 'legend', game: 'puyopuyo' },
  pp_gun:       { name: '泡泡枪',          quality: 'rare',   game: 'puyopuyo' },
  pp_empty:     { name: '世界一无所有',    quality: 'epic',   game: 'puyopuyo' },
  pp_save:      { name: '扶大厦于将倾',    quality: 'epic',   game: 'puyopuyo' }
};
// 成就 → 专属头衔（技能五子棋）
const ACH_TITLE_BY_ID = {
  gm_destiny: '可以撑地了',
  gm_moyu: 'Tony老师',
  gm_decode: '破译专家',
  gm_slow: '五子棋的花语',
  gm_fool: '愚言家',
  gm_lucky: 's1幸运儿',
  gm_seal: '占山为王',
  gm_clean: 's1清洁工',
  gm_detective: 's1侦探',
  gm_soul: 's1降灵师'
};
const ACH_QUALITY_NO = { common: 1, rare: 2, epic: 3, legend: 4, hidden: 5 };
// 旗手升级档位（累计正确插旗数）：同组 id 靠品质最高档展示
const MS_FLAG_LEVELS = [['ms_flag_s1', 1000], ['ms_flag_a', 500], ['ms_flag_b', 100], ['ms_flag_c', 10]];
const MS_FLAG_NEED = { ms_flag_c: 10, ms_flag_b: 100, ms_flag_a: 500, ms_flag_s1: 1000 };
// 成就“组”：同一可升级成就在总览/结算里只算一个（如世一炸 = 一个组，4 档分拆展示）
function achGroupOf(id) { const m = ACHIEVEMENTS[id]; return (m && m.group) || id; }
function achBaseNameOf(id) { const m = ACHIEVEMENTS[id]; return (m && m.base) || (m && m.name) || id; }
function achQNo(q) { return ACH_QUALITY_NO[q] || 0; }
function totalAchCount() {
  const set = new Set();
  for (const [id, m] of Object.entries(ACHIEVEMENTS)) set.add((m && m.group) || id);
  return set.size;
}
// 输入一批成就 id，只保留每个“组”里品质最高的一项（品质相同时保留原名）
function collapseAchIds(ids) {
  const best = new Map();
  for (const id of ids) {
    const m = ACHIEVEMENTS[id];
    if (!m) continue;
    const g = achGroupOf(id);
    const qn = achQNo(m.quality);
    if (!best.has(g) || qn > best.get(g)[0]) best.set(g, [qn, Object.assign({ id }, m)]);
  }
  return Array.from(best.values()).map(x => x[1]);
}

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
// streak 可选：描边/世一炸等需要“每次是几连”展示时传入
function recordAchievement(playerName, achievementId, streak) {
  const isTest = isTestAccount(playerName);
  const file = isTest ? ACH_TEST_FILE : ACH_FILE;
  const list = isTest ? achTestRecords : achRecords;
  const now = Date.now();
  const ev = (typeof streak === 'number') ? { ts: now, streak, _open: true } : now;
  const rec = list.find(r => r.achievementId === achievementId && r.playerName === playerName);
  if (rec) {
    rec.count++;
    rec.lastTime = now;
    // 历史明细：每次触发时间（旧数据无 events 则忽略，新触发开始累积）
    if (rec.events) rec.events.push(ev);
  } else {
    list.push({
      achievementId,
      playerName,
      count: 1,
      firstTime: now,
      lastTime: now,
      events: [ev],                 // 荣誉墙"▸ 展开每次触发时间"用
      highestTier: ACH_QUALITY_NO[ACHIEVEMENTS[achievementId]?.quality] || 1
    });
  }
  if (isTest) achTestRecords = list; else achRecords = list;
  // 落盘规则：
  //  - 正式玩家：仅在 PERSIST_ACHIEVEMENTS=true 时写 data/achievements.json（开发期只内存）
  //  - 测试账号：永远只存内存（重启即刷新），不写任何文件
  if (!isTest && PERSIST_ACHIEVEMENTS) saveAchRecords(ACH_FILE, achRecords);
}

// 更新仍在进行的连段：最佳连击 + 把最后一次事件标成当前长度（不增加次数）
function noteBestStreak(name, achievementId, streak) {
  const list = isTestAccount(name) ? achTestRecords : achRecords;
  const rec = list.find(r => r.achievementId === achievementId && r.playerName === name);
  if (!rec) return;
  if (!rec.bestStreak || streak > rec.bestStreak) rec.bestStreak = streak;
  const evs = rec.events;
  if (!Array.isArray(evs)) return;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e && typeof e === 'object' && e._open) { if (streak > e.streak) e.streak = streak; return; }
    if (typeof e === 'number') return;
  }
}
// 连段中断/对局结束时，把最后一条开放事件标记为已结束
function closeOpenStreak(name, achievementId) {
  const list = isTestAccount(name) ? achTestRecords : achRecords;
  const rec = list.find(r => r.achievementId === achievementId && r.playerName === name);
  if (!rec || !Array.isArray(rec.events)) return;
  for (let i = rec.events.length - 1; i >= 0; i--) {
    const e = rec.events[i];
    if (e && typeof e === 'object' && e._open) { e._open = false; return; }
    if (typeof e === 'number') return;
  }
}

// 统一解锁入口：记录 + 本局去重播报 + 汇总。
// repeatable=true 表示"同局多次可重复累积次数，但只播报一次"（如每次投出快艇）。
function announceAchievement(game, roomId, playerName, achievementId, repeatable, streak) {
  if (!game || game.mock) return;
  const meta = ACHIEVEMENTS[achievementId];
  if (!meta) return;

  // 游客：不记正式榜；仅当触发稀有/史诗/传说时，系统推送到“游客留言板”
  if (String(playerName || '').startsWith('游客')) {
    if (!['rare', 'epic', 'legend'].includes(meta.quality)) return;
    if (!game.achievementsByPlayer) game.achievementsByPlayer = {};
    const arr = (game.achievementsByPlayer[playerName] = game.achievementsByPlayer[playerName] || []);
    if (arr.includes(achievementId)) return;
    arr.push(achievementId);
    const gName = GAME_NAME_LABEL[meta.game] || meta.game || '';
    const qName = ACH_Q_LABEL[meta.quality] || meta.quality;
    pushBoard('guest', {
      name: '系统',
      text: `🏆 游客「${playerName}」在${gName}解锁${qName}成就「${meta.name}」！`,
      ts: Date.now()
    });
    return;
  }

  if (!game.achievementsByPlayer) game.achievementsByPlayer = {};
  if (!game.achievementsByPlayer[playerName]) game.achievementsByPlayer[playerName] = [];
  const byPlayer = game.achievementsByPlayer[playerName];
  const already = byPlayer.includes(achievementId);

  if (already && !repeatable) return;          // 一次性成就：本局已拿过就不重复记录
  recordAchievement(playerName, achievementId, streak); // 每次事件都累积次数
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
    players[name] = collapseAchIds(ids).map(m => ({
      id: m.id || '',
      name: m.name || ids[0] || '',
      quality: m.quality || 'common'
    }));
  }
  if (Object.keys(players).length) io.to(roomId).emit('achievement_summary', { players });
}

const GAME_URL_MAP = {
  yahtzee: '/yahtzee.html',
  light: '/light.html',
  drawing: '/drawing.html',
  bomber: '/bomber.html',
  minesweeper: '/minesweeper.html',
  othello: '/othello.html',
  quoridor: '/quoridor.html',
  gomoku: '/gomoku.html',
  puyopuyo: '/puyopuyo.html'
};
const GAME_NAME_LABEL = { yahtzee: '快艇骰子', light: '拍灯大作战', drawing: '画猜接龙', bomber: '炸飞机', minesweeper: '扫雷', othello: '翻转棋', quoridor: '路墙棋', gomoku: '技能五子棋', puyopuyo: '魔法气泡' };
const ACH_Q_LABEL = { common: '普通', rare: '稀有', epic: '史诗', legend: '传说', hidden: '隐藏' };

const yahtzeeGames = {};
const drawingGames = {}; // 画猜接龙（drawing）对局
const bomberGames = {}; // 炸飞机（bomber）对局
// —— 机型相对坐标（相对机头，0=上）——
const BMB_CELLS = {
  1: [[0,0],[1,-2],[1,-1],[1,0],[1,1],[1,2],[2,0],[3,-1],[3,0],[3,1]],
  2: [[0,0],[1,0],[2,-2],[2,-1],[2,0],[2,1],[2,2],[3,0],[4,-1],[4,1]],
  3: [[0,0],[1,-1],[1,0],[1,1],[2,-2],[2,0],[2,2],[3,0],[4,-1],[4,0],[4,1]]
};
function bmbRotCells(type, rot) {
  return BMB_CELLS[type].map(([dr, dc]) => {
    if (rot === 1) return [dc, -dr];
    if (rot === 2) return [-dr, -dc];
    if (rot === 3) return [-dc, dr];
    return [dr, dc];
  });
}
function bmbCellsOf(plane) {
  return bmbRotCells(Number(plane.type), Number(plane.rotation || 0)).map(([dr, dc]) => ({
    r: Number(plane.headR) + dr, c: Number(plane.headC) + dc, head: dr === 0 && dc === 0
  }));
}
function bmbConfig() { // 3机型至少各1 + 剩余2随机
  const cfg = [1, 2, 3];
  const pool = [1, 1, 2, 2, 3, 3];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  cfg.push(pool[0], pool[1]);
  return cfg.sort((a, b) => a - b);
}
function bmbRandomPlanes(config) {
  const used = new Set();
  const out = [];
  for (let tries = 0; tries < 400 && out.length < config.length; tries++) {
    const type = config[out.length];
    const rotation = Math.floor(Math.random() * 4);
    const headR = 1 + Math.floor(Math.random() * 15);
    const headC = 1 + Math.floor(Math.random() * 15);
    const cells = bmbCellsOf({ type, rotation, headR, headC });
    if (cells.some(x => x.r < 1 || x.r > 15 || x.c < 1 || x.c > 15)) continue;
    const k = cells.map(x => x.r + ',' + x.c);
    if (k.some(x => used.has(x))) continue;
    k.forEach(x => used.add(x));
    out.push({ type, rotation, headR, headC, cells, headKey: type + '@' + headR + ',' + headC });
  }
  return out.length === config.length ? out : null;
}
function bmbValidate(planes, config) {
  if (!Array.isArray(planes) || planes.length !== 5) return '需要摆放 5 架飞机';
  const used = planes.map(p => [Number(p.type), Number(p.rotation || 0), Number(p.headR), Number(p.headC)]);
  const sorted = used.map(p => p[0]).slice().sort();
  if (sorted.join(',') !== config.slice().sort((a, b) => a - b).join(',')) return '机型组成与本轮配置不一致';
  const seen = new Set();
  for (const p of used) {
    if (p[2] < 1 || p[2] > 15 || p[3] < 1 || p[3] > 15) return '飞机超出棋盘';
    for (const cell of bmbCellsOf({ type: p[0], rotation: p[1], headR: p[2], headC: p[3] })) {
      if (cell.r < 1 || cell.r > 15 || cell.c < 1 || cell.c > 15) return '飞机超出棋盘';
      const k = cell.r + ',' + cell.c;
      if (seen.has(k)) return '飞机之间不能重叠';
      seen.add(k);
    }
  }
  return null;
}
function bmbMakeGame(room, names) {
  const config = bmbConfig();
  const alive = names.slice();
  return {
    roomId: room.roomId, gameType: 'bomber', playerOrder: names.slice(), alive, turn: names[0],
    config, planes: {}, ready: {}, phase: 'deploy', // deploy -> battle -> over
    headHit: {}, sunkHead: {}, boards: {}, attacks: {}, targetShots: {}, firedCoords: {}, meHits: {},
    stats: {}, hitStreak: {}, emptyStreak: {}, sunkBy: {}, achievementsByPlayer: {}, lastEmpty: 0, cancelVotes: [], autoT: null,
    startAt: Date.now()
  };
}
function bmbBoardView(g, name) { return (g.planes[name] || []).map(p => p.cells || bmbCellsOf(p)); }
function bmbState(g, name, room) {
  const shotsByTarget = {};
  for (const [t, arr] of Object.entries(g.targetShots || {})) {
    if (t !== name) shotsByTarget[t] = (arr || []).slice();
  }
  const online = {};
  for (const n of g.playerOrder) {
    const hb = userLastHeartbeat.get(n);
    const sid = room.playerMap.get(n);
    online[n] = !!(hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && bomberAtGame.get(n) === sid && io.sockets.sockets.has(sid));
  }
  const disp = {};
  g.playerOrder.forEach(n => { disp[n] = getDisplayName(n); });
  return {
    phase: g.phase, turn: g.turn, alive: g.alive.slice(), order: g.playerOrder.slice(), config: g.config.slice(), you: name,
    disp,
    ready: g.ready, board: bmbBoardView(g, name),
    yourHits: (g.attacks && g.attacks[name]) || [],
    shotsByTarget, firedByTarget: g.firedCoords || {},
    meHits: (g.meHits && g.meHits[name]) || [],
    stats: g.stats[name] || {},
    online, cancelVotes: (g.cancelVotes || []).slice(),
    over: g.over || null
  };
}
function bmbBroadcast(room, g) {
  g.playerOrder.forEach(n => {
    const sid = room.playerMap.get(n);
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('bomber_state', bmbState(g, n, room));
  });
}
function bmbBoom(room, text) { io.to(room.roomId).emit('bomber_boom', { text }); }
// 该玩家当前是否“正在炸飞机页”（能真正行动）
function bmbInGameNow(name, room) {
  const sid = room.playerMap.get(name);
  const sid2 = bomberAtGame.get(name);
  const hb = userLastHeartbeat.get(name);
  return !!sid && sid === sid2 && io.sockets.sockets.has(sid) && !!hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT;
}
// 回合轮转：仅当“当前轮到的人不在游戏页”时才让给下一位在场存活玩家；否则绝不自动跳
function bmbAdvance(g, room) {
  if (g.phase !== 'battle' || g.alive.length <= 1) return false;
  if (!(room && room.skipOffline)) return false; // 默认不跳过离线者；房间设置里勾选后才自动让位
  if (bmbInGameNow(g.turn, room)) return false;
  const seq = g.playerOrder.filter(n => g.alive.includes(n));
  const idx = seq.indexOf(g.turn);
  for (let k = 1; k <= seq.length; k++) {
    const cand = seq[(idx + k) % seq.length];
    if (bmbInGameNow(cand, room)) { g.turn = cand; return true; }
  }
  return false;
}
// 倒霉路人：自己 5 架飞机全是被“传播轰炸（非被直接选为目标）”击毁
function bmbAwardUnlucky(g, room, d) {
  if (!g.alive.includes(d)) return;
  const sb = (g.sunkBy && g.sunkBy[d]) || {};
  const allProp = (g.sunkHead[d] || []).every(hk => sb[hk] === 'prop');
  if (allProp) announceAchievement(g, room.roomId, d, 'bomber_unlucky', false);
}
function bmbAttack(g, room, attacker, target, r, c) {
  const res = { x: c, y: r, res: '空' };
  (g.stats[attacker] = g.stats[attacker] || {});
  const key = r + ',' + c;
  // 1) 判定对 target 的反馈
  const tPlanes = g.planes[target] || [];
  const hitCell = (() => {
    for (const p of tPlanes) {
      const cell = (p.cells || []).find(cell => cell.r === r && cell.c === c);
      if (cell) return { p, cell };
    }
    return null;
  })();
  const downed = []; // 本次被击落机头的玩家（目标 + 波及）
  if (hitCell) {
    const headKey = hitCell.p.headKey;
    const sunk = (g.sunkHead[target] || []).includes(headKey);
    if (hitCell.cell.head && !sunk) {
      res.res = '沉';
      g.sunkHead[target] = g.sunkHead[target] || [];
      g.sunkHead[target].push(headKey);
      (g.sunkBy[target] = g.sunkBy[target] || {})[headKey] = 'direct';
      downed.push(target);
      if (!g.stats[attacker].firstDown) g.stats[attacker].firstDown = (g.attacks[attacker] || []).length + 1;
    } else {
      // 机身格：无论这架飞机的机头是否已沉，一律显示“伤”（绿）并计入机身命中
      res.res = hitCell.cell.head ? '沉' : '伤';
      if (!hitCell.cell.head) {
        (g.stats[attacker] = g.stats[attacker] || {}).bodyHits = (g.stats[attacker].bodyHits || 0) + 1;
        if (!g.stats[attacker].firstHit) g.stats[attacker].firstHit = (g.attacks[attacker] || []).length + 1;
      }
    }
  }
  // 2) 同一坐标对所有玩家布局的“波及”：谁的飞机恰好占着这格就一起受击
  for (const other of g.playerOrder) {
    if (other === attacker) continue;
    const oPlane = (g.planes[other] || []).find(p => (p.cells || []).some(cell => cell.r === r && cell.c === c && cell.head));
    if (oPlane) {
      const hk = oPlane.headKey;
      if (!(g.sunkHead[other] || []).includes(hk)) {
        g.sunkHead[other] = g.sunkHead[other] || [];
        g.sunkHead[other].push(hk);
        (g.sunkBy[other] = g.sunkBy[other] || {})[hk] = 'prop';
        if (other !== target) downed.push(other);
      }
    }
  }
  if (downed.length) {
    (g.stats[attacker] = g.stats[attacker] || {}).shipsDown = (g.stats[attacker].shipsDown || 0) + downed.length;
    if (!g.stats[attacker].firstDown) g.stats[attacker].firstDown = (g.attacks[attacker] || []).length + 1;
    const shown = g.playerOrder.filter(n => downed.includes(n)).map(n => getDisplayName(n));
    const who = shown.length === 1 ? shown[0] : shown.slice(0, -1).join('、') + ' 和 ' + shown[shown.length - 1];
    bmbBoom(room, `💥 ${getDisplayName(attacker)} 炸毁了 ${who} 的飞机！`);
  }
  // 3) 全盘落点记录：一发炮弹 = 对所有非攻击者都是公开坐标事件。
  //    每个受影响玩家：自己盘标 X、其“轰炸面板”记一发、firedCoords 防同格重复轰炸。
  for (const o of g.playerOrder) {
    if (o === attacker) continue;
    let oRes = '空';
    for (const p of (g.planes[o] || [])) {
      const cc = (p.cells || []).find(cell => cell.r === r && cell.c === c);
      if (cc) {
        oRes = cc.head ? '沉' : '伤'; // 机头=红；机身格无论机头是否已沉都显示绿
        break;
      }
    }
    g.meHits[o] = g.meHits[o] || [];
    if (!g.meHits[o].some(h => h.x === c && h.y === r)) g.meHits[o].push({ x: c, y: r, res: oRes, by: attacker });
    g.firedCoords[o] = g.firedCoords[o] || [];
    if (!g.firedCoords[o].includes(key)) g.firedCoords[o].push(key);
    g.targetShots[o] = g.targetShots[o] || [];
    if (!g.targetShots[o].some(s => s.x === c && s.y === r)) {
      g.targetShots[o].push({ x: c, y: r, res: oRes, by: attacker, prop: o !== target });
    }
  }
  g.attacks[attacker] = g.attacks[attacker] || [];
  g.attacks[attacker].push({ to: target, x: c, y: r, res: res.res });
  // 连击口径：只以“本次击落了机头（页面弹出 xx 炸毁了 xx 的飞机/机头）”为准。
  // 单纯打中机身不算；传播只打到已被炸过的格子也不算，二者都会断连击。
  const destroyedNow = downed.length > 0;
  const plainHit = res.res !== '空';
  const prevHit = g.hitStreak[attacker] || 0;
  const prevEmpty = g.emptyStreak[attacker] || 0;
  if (destroyedNow) {
    g.hitStreak[attacker] = prevHit + 1;
    g.emptyStreak[attacker] = 0;
    if (prevEmpty >= 8) closeOpenStreak(attacker, 'bomber_edge');
  } else {
    g.hitStreak[attacker] = 0;
    if (prevHit >= 5) closeOpenStreak(attacker, 'bomber_streak5');
    if (plainHit) {
      g.emptyStreak[attacker] = 0;
      if (prevEmpty >= 8) closeOpenStreak(attacker, 'bomber_edge');
    } else {
      g.emptyStreak[attacker] = prevEmpty + 1;
    }
  }
  g.lastEmpty = (destroyedNow || plainHit) ? 0 : (g.lastEmpty || 0) + 1;
  // —— 炸飞机成就判定（cj1.md）——
  if (downed.length >= 2) announceAchievement(g, room.roomId, attacker, 'bomber_bounce', false); // 蹦蹦炸弹
  // 开门红：首次轰炸命中机头——含目标盘直接命中与同格传播炸到别人的机头
  const wasFirstAttack = (g.attacks[attacker] || []).length === 1; // 已在上面 push，首炸时为 1
  if (wasFirstAttack && downed.length > 0) {
    announceAchievement(g, room.roomId, attacker, 'bomber_first', false);
  }
  const comboMap = { 2: 'bomber_streak2', 3: 'bomber_streak3', 4: 'bomber_streak4' };
  const hs = g.hitStreak[attacker] || 0;
  if (hs >= 5) {
    // 世一炸·5连击+：每段连击只在“正好第 5 次”记 1 次；6、7…只更新该次事件为更长连击
    if (hs === 5) announceAchievement(g, room.roomId, attacker, 'bomber_streak5', true, hs);
    noteBestStreak(attacker, 'bomber_streak5', hs);
  } else if (comboMap[hs]) {
    announceAchievement(g, room.roomId, attacker, comboMap[hs], false, hs);
  }
  const en = g.emptyStreak[attacker] || 0;
  // 描边大师：每段连空只在“正好第 8 次”记 1 次；9、10、11…只更新该次事件为更长连空
  if (en === 8) announceAchievement(g, room.roomId, attacker, 'bomber_edge', true, en);
  if (en >= 8) noteBestStreak(attacker, 'bomber_edge', en);
  // 4) 淘汰判定：被击落第 5 架飞机的任何玩家都出局（含波及）
  for (const d of downed) {
    if (g.alive.includes(d) && (g.sunkHead[d] || []).length >= (g.config || []).length) {
      bmbAwardUnlucky(g, room, d);
      g.alive = g.alive.filter(n => n !== d);
      g.elimOrder = g.elimOrder || [];
      if (!g.elimOrder.includes(d)) g.elimOrder.push(d);
      g.eliminated = g.eliminated || {};
      g.eliminated[d] = Date.now();
      bmbBoom(room, `📉 ${getDisplayName(d)} 已全员出局（剩余 ${g.alive.length} 人）`);
    }
  }
  // 4.5) 兜底：任何“机头已炸满 5 架”的存活者都补移除；只剩最后一人即进入结算
  for (const n of g.alive.slice()) {
    if ((g.sunkHead[n] || []).length >= (g.config || []).length) {
      bmbAwardUnlucky(g, room, n);
      g.alive = g.alive.filter(m => m !== n);
      g.elimOrder = g.elimOrder || [];
      if (!g.elimOrder.includes(n)) g.elimOrder.push(n);
      g.eliminated = g.eliminated || {};
      g.eliminated[n] = Date.now();
      bmbBoom(room, `📉 ${getDisplayName(n)} 已全员出局（剩余 ${g.alive.length} 人）`);
    }
  }
  // 5) 固定座位轮转：给下一名在场存活玩家；若都不在场就保持座位等回来
  if (g.alive.length <= 1) {
    g.phase = 'over';
    recordBomberSparks(g); // 烟火师榜：单局机头（击落飞机数）
    const winner = g.alive[0];
    const players = g.playerOrder.map(n => ({ name: n, stats: g.stats[n] || {}, rank: n === winner ? 1 : (g.elimOrder || []).indexOf(n) + 2 }));
    g.over = { winner, players };
    recordBomberGame(g); // 时光墙：只记正式玩家整局
    broadcastAchievementSummary(room.roomId, g); // 本局成就汇总（炸飞机也可在弹幕端接入展示）
    if (g.autoT) { clearTimeout(g.autoT); g.autoT = null; }
    // 对局结束：任何还在“进行中”的连段事件都标记为结束
    for (const n of g.playerOrder) { closeOpenStreak(n, 'bomber_edge'); closeOpenStreak(n, 'bomber_streak5'); }
    // 结算后房间复位（约 4 秒）：房间/大厅可立刻开新局，但各人结算页可继续停留查看
    if (gameEndTimers[room.roomId]) { clearTimeout(gameEndTimers[room.roomId]); }
    gameEndTimers[room.roomId] = setTimeout(() => {
      if (bomberGames[room.roomId] === g) delete bomberGames[room.roomId];
      delete gameEndTimers[room.roomId];
      Object.keys(room.seats).forEach(seatId => { if (room.seats[seatId]) room.seats[seatId].ready = false; });
      broadcastRoom(room);
      console.log(`🔄 炸飞机 ${room.roomId} 已结算，房间已复位可开新局`);
    }, 4000);
  } else {
    const seq = g.playerOrder.filter(n => g.alive.includes(n));
    const idx = seq.indexOf(attacker);
    g.turn = seq[(idx + 1) % seq.length];
    bmbAdvance(g, room); // 仅当这一位不在游戏页时自动让给在场的下一位
  }
  bmbBroadcast(room, g);
  return res;
}
// ======================== 扫雷（minesweeper）核心 ========================
const minesweeperGames = {}; // roomId -> 对局
const msAtGame = new Map();   // playerName -> 当前正打开扫雷游戏页的 socket.id
const othelloGames = {};      // roomId -> 翻转棋对局
const othAtGame = new Map();  // playerName -> 当前正打开翻转棋游戏页的 socket.id
const quoridorGames = {};     // roomId -> 路墙棋对局
const quoriAtGame = new Map();// playerName -> 当前正打开路墙棋游戏页的 socket.id
const gomokuGames = {};       // roomId -> 技能五子棋对局
const gomoAtGame = new Map(); // playerName -> 当前正打开五子棋游戏页的 socket.id
const MS_SIZE = 8;
const MS_MINES = 26;
const MS_BONUS = { 1: 6, 2: 3, 3: 2, 4: 1 };
function msKey(r, c) { return r + ',' + c; }
// 动态生成：8×8 随机 26 雷，保证所有非雷格周围雷数 >=1（无 0 格）
function msGenBoard() {
  let relaxed = null;
  for (let t = 0; t < 2500; t++) {
    const mines = new Set();
    while (mines.size < MS_MINES) mines.add(msKey(1 + Math.floor(Math.random() * MS_SIZE), 1 + Math.floor(Math.random() * MS_SIZE)));
    const counts = {};
    let ok = true, high = false;
    for (let r = 1; r <= MS_SIZE; r++) {
      for (let c = 1; c <= MS_SIZE; c++) {
        const k = msKey(r, c);
        if (mines.has(k)) { counts[k] = -1; continue; }
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 1 && rr <= MS_SIZE && cc >= 1 && cc <= MS_SIZE && mines.has(msKey(rr, cc))) n++;
        }
        if (n === 0) { ok = false; break; }
        if (n >= 7) high = true;
        counts[k] = n;
      }
      if (!ok) break;
    }
    if (!ok) continue;
    if (!relaxed) relaxed = { mines, counts };
    if (!high) return { mines, counts }; // 要求：无 0、无 7/8 的"雷不集中"棋盘
  }
  return relaxed; // 极端情况兜底：无 0 即可
}
function msInit(room, names, teamMode) {
  const bd = msGenBoard();
  const order = names.slice();
  let teams = null;
  if (teamMode) {
    const arr = order.slice();
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    teams = {};
    order.forEach(n => teams[n] = arr.indexOf(n) % 2 === 0 ? 'A' : 'B');
  }
  const achCtx = {};
  order.forEach(n => { achCtx[n] = { rev: 0, mate: 0, pen: 0, noPen: true, share: false }; });
  return {
    roomId: room.roomId, playerOrder: order, mode: teamMode ? 'team' : 'solo',
    phase: 'pick', round: 1, mines: bd.mines, counts: bd.counts,
    revealed: new Set(), flagged: new Set(), exploded: new Set(), handledMine: new Set(),
    picks: {}, scores: {}, teams, over: null, last: null, roundTimer: null, cancelVotes: [], flagHits: {}, achCtx
  };
}
function msRemainingMines(g) { return MS_MINES - g.handledMine.size; }
function msSettle(g) {
  const actions = [];      // {name,key,r,c,op}
  const openSafeAt = {}, flagMineAt = {};
  for (const n of g.playerOrder) {
    const p = g.picks[n]; if (!p) continue;
    const k = msKey(p.r, p.c);
    actions.push({ name: n, r: p.r, c: p.c, key: k, op: p.op });
    const isMine = g.mines.has(k);
    if (p.op === 'open') {
      if (!isMine) openSafeAt[k] = (openSafeAt[k] || 0) + 1;
    } else {
      if (isMine) flagMineAt[k] = (flagMineAt[k] || 0) + 1;
    }
  }
  const deltas = {};
  const results = [];
  const cnt = {};
  for (const a of actions) cnt[a.key] = (cnt[a.key] || 0) + 1;
  for (const a of actions) {
    const n = a.name; const k = a.key; const isMine = g.mines.has(k);
    let delta = 0, ok = false;
    if (a.op === 'open') {
      if (isMine) {
        if (!g.exploded.has(k)) { g.exploded.add(k); g.handledMine.add(k); }
        delta = -5;
      } else {
        if (!g.revealed.has(k)) g.revealed.add(k);
        ok = true;
        delta = MS_BONUS[openSafeAt[k]] || 1;
      }
    } else {
      if (isMine) {
        if (!g.flagged.has(k)) g.flagged.add(k);
        if (!g.handledMine.has(k)) { g.handledMine.add(k); g.flagHits[n] = (g.flagHits[n] || 0) + 1; }
        ok = true;
        delta = MS_BONUS[flagMineAt[k]] || 1;
      } else {
        // 错旗：翻开该格（显示数字），不保留旗子，扣 5
        if (!g.revealed.has(k)) g.revealed.add(k);
        delta = -5;
      }
    }
    deltas[n] = (deltas[n] || 0) + delta;
    g.scores[n] = (g.scores[n] || 0) + delta;
    results.push({ name: n, r: a.r, c: a.c, op: a.op, ok, delta });
  }
  // —— 每轮揭晓后刷新成就上下文（撞格 / 队友同格 / 连续扣分 / 全程无扣分）——
  for (const n of g.playerOrder) {
    const act = actions.find(x => x.name === n);
    if (!act) continue;
    const st = (g.achCtx[n] = g.achCtx[n] || { rev: 0, mate: 0, pen: 0, noPen: true, share: false });
    const d = deltas[n] || 0;
    if (d < 0) { st.noPen = false; st.pen++; } else { st.pen = 0; }
    if (st.pen >= 5) announceAchievement(g, g.roomId, n, 'ms_penta'); // 五连绝世（隐藏）
    const shared = (cnt[act.key] || 0) > 1;
    if (shared) { st.rev++; st.share = true; } else { st.rev = 0; }
    if (st.rev >= 3) announceAchievement(g, g.roomId, n, 'ms_reverse'); // 连续三轮与他人撞格
    const mate = (g.mode === 'team') ? msTeammate(g, n) : null;
    if (mate) {
      const ma = actions.find(x => x.name === mate);
      if (ma && ma.key === act.key) { st.mate++; if (st.mate >= 2) announceAchievement(g, g.roomId, n, 'ms_mate'); }
      else st.mate = 0;
    } else { st.mate = 0; }
  }
  g.last = results;
  g.picks = {};
  if (msRemainingMines(g) <= 0) return msFinish(g);
  g.phase = 'result';
  if (g.roundTimer) clearTimeout(g.roundTimer);
  g.roundTimer = setTimeout(() => { g.last = null; g.round++; g.phase = 'pick'; bmsBroadcastFor(g.roomId); }, 4000);
}
function msFinish(g) {
  g.phase = 'over';
  const order = g.playerOrder.slice();
  let winnerNames = [];
  if (g.mode === 'solo') {
    const best = Math.max(...order.map(n => g.scores[n] || 0));
    winnerNames = order.filter(n => (g.scores[n] || 0) === best);
  } else {
    const sum = nm => order.filter(x => g.teams[x] === nm).reduce((a, x) => a + (g.scores[x] || 0), 0);
    const sa = sum('A'), sb = sum('B');
    const winTeam = sa > sb ? 'A' : (sb > sa ? 'B' : '');
    if (winTeam) winnerNames = order.filter(x => g.teams[x] === winTeam);
    else winnerNames = [];
  }
  g.over = { mode: g.mode, teams: g.teams, winnerNames, scores: g.scores };
  // —— 对局结束成就（逐轮上下文已就绪；范围规则见 minesweeper.md）——
  if (g.achCtx) {
    for (const n of g.playerOrder) {
      const st = g.achCtx[n];
      if (!st) continue;
      if (st.noPen) announceAchievement(g, g.roomId, n, 'ms_god'); // 单局自己从未扣分
      if (g.mode === 'team') {
        if (!st.share) announceAchievement(g, g.roomId, n, 'ms_own'); // 2v2 限定：全程没和任何人（含队友）撞格
        const mate = msTeammate(g, n);
        if (mate && winnerNames.length && winnerNames.includes(n)) {
          const diff = (g.scores[n] || 0) - (g.scores[mate] || 0);
          if (diff >= 30) announceAchievement(g, g.roomId, n, 'ms_pepper'); // 队伍获胜且个人比队友高 ≥30
        }
      }
    }
  }
  return g.over;
}
function bmsView(g, name, room) {
  const revealed = [], flagged = [], exploded = [];
  for (const k of g.revealed) { const [r, c] = k.split(',').map(Number); revealed.push({ r, c, num: g.counts[k] }); }
  for (const k of g.flagged) { const [r, c] = k.split(',').map(Number); flagged.push({ r, c }); }
  for (const k of g.exploded) { const [r, c] = k.split(',').map(Number); exploded.push({ r, c }); }
  const online = {};
  for (const n of g.playerOrder) {
    const hb = userLastHeartbeat.get(n);
    const sid = room && room.playerMap.get(n);
    online[n] = !!(hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && msAtGame.get(n) === sid && io.sockets.sockets.has(sid));
  }
  return {
    phase: g.phase, round: g.round, mode: g.mode, you: name,
    playerOrder: g.playerOrder.slice(),
    size: MS_SIZE, mineTotal: MS_MINES, remaining: msRemainingMines(g),
    online,
    revealed, flagged, exploded,
    scores: g.scores, teams: g.teams, myPick: g.picks[name] || null,
    submitted: g.playerOrder.filter(n => g.picks[n]),
    picks: (g.phase === 'pick' && g.picks[name]) ? g.picks : {}, // 提交后（对自己）才显示大家的 A
    last: g.last || null, over: g.over || null, cancelVotes: (g.cancelVotes || []).slice()
  };
}
function bmsBroadcast(room, g) {
  g.playerOrder.forEach(n => {
    const sid = room.playerMap.get(n);
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('minesweeper_state', bmsView(g, n, room));
  });
}
function bmsBroadcastFor(roomId) {
  const room = GAME_ROOMS.minesweeper;
  const g = minesweeperGames[roomId];
  if (room && g && g.roomId === roomId) bmsBroadcast(room, g);
}
function bmsCancel(room, g, deleteNow) {
  if (g.roundTimer) clearTimeout(g.roundTimer);
  delete minesweeperGames[room.roomId];
  io.to(room.roomId).emit('minesweeper_cancel');
  Object.keys(room.seats).forEach(sid => { if (room.seats[sid]) room.seats[sid].ready = false; });
  broadcastRoom(room);
}

// ======================== 翻转棋（othello / 黑白棋）核心 ========================
// 规格见 development/制作笔记/othello.md；坐标：列 a~h 左→右，行 1~8 上→下
const OTH_DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const OTH_LETTERS = 'abcdefgh';
function othOther(p) { return p === 1 ? 2 : 1; }
function othIdx(r, c) { return r * 8 + c; }
function othIn(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function othCoord(r, c) { return OTH_LETTERS[c] + (r + 1); }
function othColorOf(g, name) { return g.playerOrder.indexOf(name) === 0 ? 1 : (g.playerOrder.indexOf(name) === 1 ? 2 : 0); }
// 在 (r,c) 落 player 色后，八个方向被夹住的对方棋子坐标集合
function othFlips(board, r, c, player) {
  const opp = othOther(player), out = [];
  if (!othIn(r, c) || board[othIdx(r, c)] !== 0) return out;
  for (const [dr, dc] of OTH_DIRS) {
    const path = [];
    let rr = r + dr, cc = c + dc;
    while (othIn(rr, cc) && board[othIdx(rr, cc)] === opp) { path.push([rr, cc]); rr += dr; cc += dc; }
    if (path.length && othIn(rr, cc) && board[othIdx(rr, cc)] === player) out.push(...path);
  }
  return out;
}
function othLegal(board, player) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (board[othIdx(r, c)] !== 0) continue;
    if (othFlips(board, r, c, player).length) out.push({ r, c });
  }
  return out;
}
function othCount(board, player) { let n = 0; for (const v of board) if (v === player) n++; return n; }
const OTH_CORNERS = [[0, 0], [0, 7], [7, 0], [7, 7]];
function othCornerCount(board, player) {
  let n = 0;
  for (const [r, c] of OTH_CORNERS) if (board[othIdx(r, c)] === player) n++;
  return n;
}
function othInit(room, names) {
  const board = new Array(64).fill(0);
  board[othIdx(3, 3)] = 2; // d4 白
  board[othIdx(4, 4)] = 2; // e5 白
  board[othIdx(3, 4)] = 1; // e4 黑
  board[othIdx(4, 3)] = 1; // d5 黑
  return {
    roomId: room.roomId, playerOrder: names.slice(0, 2), board,
    turn: names[0], passStreak: 0, passName: '', history: '', last: null,
    over: null, cancelVotes: []
  };
}
function othFinish(g) {
  const black = othCount(g.board, 1), white = othCount(g.board, 2);
  const winnerNames = black > white ? [g.playerOrder[0]] : (white > black ? [g.playerOrder[1]] : []);
  g.over = { black, white, winnerNames, draw: black === white };
  // —— 终局成就 ——
  if (black === white) {
    g.playerOrder.forEach(n => announceAchievement(g, g.roomId, n, 'oth_draw'));
  } else if (winnerNames.length) {
    const wname = winnerNames[0];
    const wcolor = othColorOf(g, wname);
    if (black === 0 || white === 0) {
      announceAchievement(g, g.roomId, wname, 'oth_wipe');         // 领土战争：吃光对面
      if (Math.max(black, white) === 64) announceAchievement(g, g.roomId, wname, 'oth_perfect'); // 完美主义 64:0
    }
    if (othCornerCount(g.board, wcolor) === 0) announceAchievement(g, g.roomId, wname, 'oth_basin'); // 风水盆地：未占角获胜
  }
  recordOthelloGame(g);
  return g.over;
}
// 翻转棋真实整局 → 排行榜（最佳/流水）+ 时光墙（正式玩家）
function recordOthelloGame(g) {
  if (!g || !g.over || g._recorded) return;
  g._recorded = true;
  const ts = Date.now();
  const b = g.over.black, w = g.over.white, draw = !!g.over.draw;
  for (const n of g.playerOrder) {
    const color = othColorOf(g, n);
    const score = color === 1 ? b : w;
    othHistory.push({ name: n, score, ts, draw });
    if (score > (othBestBoard.get(n) || 0)) othBestBoard.set(n, score);
  }
  if (othHistory.length > 300) othHistory = othHistory.slice(-300);
  saveBoardStats();
  const officials = g.playerOrder.filter(isOfficialPlayer);
  if (officials.length) {
    addTimeline({
      ts, type: 'game', game: 'othello', totalPlayers: g.playerOrder.length, mode: 'solo',
      draw,
      players: officials,
      winners: Array.isArray(g.over.winnerNames) ? g.over.winnerNames.slice() : [],
      black: b, white: w,
      results: officials.map(n => {
        const color = othColorOf(g, n);
        const score = color === 1 ? b : w;
        const rank = draw ? 0 : ((color === 1 ? b > w : w > b) ? 1 : 2);
        return { name: n, score, rank, draw, black: b, white: w };
      })
    });
  }
}
// 落子；返回 {ok,msg?,finished?,pass?}
function othPlace(g, name, r, c) {
  if (!g) return { ok: false, msg: '对局不存在' };
  if (g.over) return { ok: false, msg: '对局已结束' };
  const color = othColorOf(g, name);
  if (!color) return { ok: false, msg: '你不在本局中' };
  if (g.turn !== name) return { ok: false, msg: '还没轮到你落子' };
  r = Number(r); c = Number(c);
  if (!othIn(r, c) || g.board[othIdx(r, c)] !== 0) return { ok: false, msg: '该位置不能落子' };
  const flips = othFlips(g.board, r, c, color);
  if (!flips.length) return { ok: false, msg: '必须下在能翻转对方棋子的位置' };
  g.board[othIdx(r, c)] = color;
  flips.forEach(([fr, fc]) => { g.board[othIdx(fr, fc)] = color; });
  g.history += othCoord(r, c);
  g.last = { name, r, c, flips: flips.map(([fr, fc]) => ({ r: fr, c: fc })) };
  // —— 成就：我方连续行动三次（对手连续弃权） / 占领全部四角 ——
  g.sameStreak = (g.lastMover === name) ? ((g.sameStreak || 0) + 1) : 1;
  g.lastMover = name;
  if (g.sameStreak >= 3) announceAchievement(g, g.roomId, name, 'oth_multi');
  if (othCornerCount(g.board, color) === 4) announceAchievement(g, g.roomId, name, 'oth_corners');
  const other = g.playerOrder[1 - g.playerOrder.indexOf(name)];
  g.turn = other;
  // 对手无合法落子 → 自动弃权；若自己也无合法落子 → 双方弃权，结束
  if (othLegal(g.board, othColorOf(g, other)).length === 0) {
    g.passStreak = (g.passStreak || 0) + 1;
    g.passName = other;
    g.turn = name;
    if (othLegal(g.board, color).length === 0) { g.passStreak = 2; othFinish(g); return { ok: true, finished: true, pass: true }; }
    return { ok: true, finished: false, pass: true };
  }
  g.passStreak = 0;
  g.passName = '';
  if (g.board.every(v => v !== 0)) { othFinish(g); return { ok: true, finished: true, pass: false }; }
  return { ok: true, finished: false, pass: false };
}
function othView(g, name, room) {
  const online = {};
  for (const n of g.playerOrder) {
    const hb = userLastHeartbeat.get(n);
    const sid = room && room.playerMap.get(n);
    online[n] = !!(hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && othAtGame.get(n) === sid && io.sockets.sockets.has(sid));
  }
  const myColor = othColorOf(g, name);
  return {
    you: name, playerOrder: g.playerOrder.slice(), board: g.board.slice(),
    turn: g.turn, legal: (!g.over && myColor && g.turn === name) ? othLegal(g.board, myColor) : [],
    last: g.last, over: g.over || null, passName: g.passName || '',
    history: g.history, step: g.history.length,
    black: othCount(g.board, 1), white: othCount(g.board, 2),
    myColor, online,
    cancelVotes: (g.cancelVotes || []).slice()
  };
}
function othBroadcast(room, g) {
  room.playerMap.forEach((sid, n) => {
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('othello_state', othView(g, n, room));
  });
}
function othBroadcastFor(roomId) {
  const room = GAME_ROOMS.othello;
  const g = othelloGames[roomId];
  if (room && g && g.roomId === roomId) othBroadcast(room, g);
}
function othCancel(room, g) {
  delete othelloGames[room.roomId];
  io.to(room.roomId).emit('othello_cancel');
  Object.keys(room.seats).forEach(sid => { if (room.seats[sid]) room.seats[sid].ready = false; });
  broadcastRoom(room);
}

// ======================== 路墙棋（quoridor）核心 ========================
// 规格见 development/制作笔记/quoridor.md：9×9；列 a~i、行 1~9（r=0 → 第1行）
const QUO_SIZE = 9;
// 各人数的起点 / 目标边 / 每人墙数（start=[行,列]：r=0 第1行，c=0 a列）
const QUO_CFG = {
  2: [{ start: [0, 4], goal: 'row8' }, { start: [8, 4], goal: 'row0' }],          // 玩家1 e1→第9行；玩家2 e9→第1行
  3: [{ start: [0, 4], goal: 'row8' }, { start: [8, 4], goal: 'row0' }, { start: [4, 0], goal: 'col8' }], // 玩家3 a5→i列
  4: [{ start: [0, 4], goal: 'row8' }, { start: [8, 4], goal: 'row0' }, { start: [4, 0], goal: 'col8' }, { start: [4, 8], goal: 'col0' }] // 玩家4 i5→a列
};
const QUO_WALLS = { 2: 10, 3: 7, 4: 5 };
const QUO_COLORS = ['#e74c3c', '#3f7fd6', '#43a047', '#e6b422']; // 红/蓝/绿/黄
const QUO_COLOR_NAMES = ['红', '蓝', '绿', '黄'];
function quoIn(r, c) { return r >= 0 && r < QUO_SIZE && c >= 0 && c < QUO_SIZE; }
function quoCoord(r, c) { return 'abcdefghi'[c] + (r + 1); }
function quoWallKey(r, c, o) { return r + ',' + c + ',' + o; }
function quoGoalOf(g, idx) { return QUO_CFG[g.playerOrder.length][idx].goal; }
function quoOnGoal(g, idx, r, c) {
  const goal = quoGoalOf(g, idx);
  if (goal === 'row8') return r === 8;
  if (goal === 'row0') return r === 0;
  if (goal === 'col8') return c === 8;
  if (goal === 'col0') return c === 0;
  return false;
}
function quoGoalCells(g, idx) {
  const goal = quoGoalOf(g, idx), out = [];
  for (let r = 0; r < QUO_SIZE; r++) for (let c = 0; c < QUO_SIZE; c++) {
    if (goal === 'row8' && r === 8) out.push([r, c]);
    else if (goal === 'row0' && r === 0) out.push([r, c]);
    else if (goal === 'col8' && c === 8) out.push([r, c]);
    else if (goal === 'col0' && c === 0) out.push([r, c]);
  }
  return out;
}
// 两个相邻格之间是否有墙（walls 为 Set，键 r,c,H/V）
function quoBlocked(cell1, cell2, walls) {
  const [r1, c1] = cell1, [r2, c2] = cell2;
  if (r1 === r2) {
    const cMin = Math.min(c1, c2);
    // 竖墙 V：(wr,wc) 挡在 (wr,wc)-(wr,wc+1) 之间，覆盖 wr、wr+1 两行
    return walls.has(quoWallKey(r1, cMin, 'V')) || walls.has(quoWallKey(r1 - 1, cMin, 'V'));
  }
  if (c1 === c2) {
    const rMin = Math.min(r1, r2);
    // 横墙 H：(wr,wc) 挡在 (wr,wc)-(wr+1,wc) 之间，覆盖 wc、wc+1 两列
    return walls.has(quoWallKey(rMin, c1, 'H')) || walls.has(quoWallKey(rMin, c1 - 1, 'H'));
  }
  return false;
}
// BFS 最短路径长度（到目标边任意格；忽略棋子阻挡，规则只要求“存在通路”）
function quoPathLen(g, idx) {
  if (g.finished.includes(idx)) return 0;
  const start = g.pos[idx];
  if (!start) return -1;
  const goal = quoGoalOf(g, idx);
  const onGoal = (r, c) => goal === 'row8' ? r === 8 : goal === 'row0' ? r === 0 : goal === 'col8' ? c === 8 : c === 0;
  const seen = new Set([start[0] + ',' + start[1]]);
  let frontier = [[start[0], start[1], 0]];
  while (frontier.length) {
    const next = [];
    for (const [r, c, d] of frontier) {
      if (onGoal(r, c)) return d;
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nr = r + dr, nc = c + dc;
        if (!quoIn(nr, nc)) continue;
        if (quoBlocked([r, c], [nr, nc], g.walls)) continue;
        const k = nr + ',' + nc;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([nr, nc, d + 1]);
      }
    }
    frontier = next;
  }
  return -1;
}
function quoActiveIdx(g) {
  const out = [];
  for (let i = 0; i < g.playerOrder.length; i++) if (!g.finished.includes(i)) out.push(i);
  return out;
}
// 合法移动（含直跳 / 直跳不可用时的斜跳；一次最多跳一枚棋子）
function quoLegalMoves(g, idx) {
  const [r, c] = g.pos[idx];
  const occupied = {};
  g.pos.forEach((p, i) => { if (p && !g.finished.includes(i)) occupied[p[0] + ',' + p[1]] = i; });
  const out = [];
  for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const nr = r + dr, nc = c + dc;
    if (!quoIn(nr, nc) || quoBlocked([r, c], [nr, nc], g.walls)) continue;
    const k = nr + ',' + nc;
    if (occupied[k] == null) { out.push([nr, nc]); continue; }
    const br = nr + dr, bc = nc + dc;
    const straightOk = quoIn(br, bc) && !quoBlocked([nr, nc], [br, bc], g.walls) && occupied[br + ',' + bc] == null;
    if (straightOk) { out.push([br, bc]); continue; }
    // 直跳不可用 → 解锁斜跳（被跳棋子的左右两侧）
    const sides = (dr === 0) ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [sdr, sdc] of sides) {
      const sr = nr + sdr, sc = nc + sdc;
      if (!quoIn(sr, sc)) continue;
      if (quoBlocked([nr, nc], [sr, sc], g.walls)) continue;
      if (occupied[sr + ',' + sc] != null) continue;
      out.push([sr, sc]);
    }
  }
  return out;
}
// 墙的基本重合/交叉检查（不含连通性）
function quoWallShapeOk(r, c, o, walls) {
  if (r < 0 || r > 7 || c < 0 || c > 7) return false;
  if (o === 'H') {
    // 横墙占 c、c+1 两列 → 与 c-1 / c / c+1 的横墙都会重叠
    if (walls.has(quoWallKey(r, c, 'H')) || walls.has(quoWallKey(r, c + 1, 'H')) || walls.has(quoWallKey(r, c - 1, 'H'))) return false;
    if (walls.has(quoWallKey(r, c, 'V')) || walls.has(quoWallKey(r, c + 1, 'V'))) return false;
  } else {
    // 竖墙占 r、r+1 两行 → 与 r-1 / r / r+1 的竖墙都会重叠
    if (walls.has(quoWallKey(r, c, 'V')) || walls.has(quoWallKey(r + 1, c, 'V')) || walls.has(quoWallKey(r - 1, c, 'V'))) return false;
    if (walls.has(quoWallKey(r, c, 'H')) || walls.has(quoWallKey(r + 1, c, 'H'))) return false;
  }
  return true;
}
// 放置后必须保证所有未完成玩家仍有通往目标的路径
function quoWallLegal(g, idx, r, c, o) {
  if ((g.wallLeft[idx] || 0) <= 0) return false;
  if (!quoWallShapeOk(r, c, o, g.walls)) return false;
  g.walls.add(quoWallKey(r, c, o));
  let ok = true;
  for (const i of quoActiveIdx(g)) {
    if (quoPathLen(g, i) < 0) { ok = false; break; }
  }
  g.walls.delete(quoWallKey(r, c, o));
  return ok;
}
function quoInit(room, names) {
  const n = Math.min(4, Math.max(2, names.length));
  const cfg = QUO_CFG[n];
  const order = names.slice(0, n);
  const pos = order.map((_, i) => cfg[i].start.slice());
  return {
    roomId: room.roomId, playerOrder: order, pos,
    walls: new Set(), wallLeft: order.map(() => QUO_WALLS[n]),
    wallsUsed: order.map(() => 0), wallOwner: {},
    movesUsed: order.map(() => 0),
    current: 0, actions: 0, finished: [], over: null,
    history: [], snapshots: [], cancelVotes: []
  };
}
function quoSnapshot(g) {
  return {
    pos: g.pos.map(p => p ? p.slice() : null),
    wallList: [...g.walls],
    wallOwner: Object.assign({}, g.wallOwner),
    wallLeft: g.wallLeft.slice(),
    current: g.current,
    finished: g.finished.slice()
  };
}
function quoPushHistory(g, text) {
  g.history.push(text);
  g.snapshots.push(quoSnapshot(g));
  if (g.history.length > 400) { g.history.shift(); g.snapshots.shift(); }
}
function quoAdvance(g) {
  const act = quoActiveIdx(g);
  if (!act.length) return;
  for (let k = 1; k <= g.playerOrder.length; k++) {
    const i = (g.current + k) % g.playerOrder.length;
    if (act.includes(i)) { g.current = i; return; }
  }
}
function quoFinish(g, idx, prePaths) {
  const name = g.playerOrder[idx];
  const activesBefore = quoActiveIdx(g);
  const paths = prePaths || activesBefore.map(i => quoPathLen(g, i));
  const rank = g.finished.length + 1;
  g.finished.push(idx);
  // —— 终局成就 ——
  if (g.playerOrder.length === 2 && rank === 1) {
    const other = activesBefore.find(i => i !== idx);
    if (other != null && quoPathLen(g, other) >= 15) announceAchievement(g, g.roomId, name, 'q_builder');
  }
  if (((g.movesUsed || [])[idx] || 0) <= 10) announceAchievement(g, g.roomId, name, 'q_fast');
  if (rank === 1 && (g.wallsUsed[idx] || 0) === 0) announceAchievement(g, g.roomId, name, 'q_s1');
  const allOne = paths.length > 0 && paths.every(p => p === 1);
  if (activesBefore.length === 2 && allOne) announceAchievement(g, g.roomId, name, 'q_step');
  if (activesBefore.length === 3 && allOne && rank === 2) announceAchievement(g, g.roomId, name, 'q_step');
  if (g.playerOrder.length >= 3 && allOne && rank === 1) announceAchievement(g, g.roomId, name, 'q_real');
  g.pos[idx] = null;
  if (g.finished.length >= g.playerOrder.length - 1) {
    const last = g.playerOrder.findIndex((_, i) => !g.finished.includes(i));
    if (last >= 0) g.finished.push(last);
    g.over = { ranking: g.finished.map((i, k) => ({ name: g.playerOrder[i], rank: k + 1 })), actions: g.actions };
    recordQuoridorGame(g);
  } else {
    quoAdvance(g);
  }
}
function quoApplyMove(g, name, r, c) {
  if (!g) return { ok: false, msg: '对局不存在' };
  if (g.over) return { ok: false, msg: '对局已结束' };
  const idx = g.playerOrder.indexOf(name);
  if (idx < 0) return { ok: false, msg: '你不在本局中' };
  if (g.current !== idx) return { ok: false, msg: '还没轮到你' };
  r = Number(r); c = Number(c);
  if (!quoLegalMoves(g, idx).some(m => m[0] === r && m[1] === c)) return { ok: false, msg: '该位置不能移动' };
  const prePaths = quoActiveIdx(g).map(i => quoPathLen(g, i));
  const from = g.pos[idx].slice();
  g.pos[idx] = [r, c];
  g.actions++;
  g.movesUsed[idx] = (g.movesUsed[idx] || 0) + 1;
  const fin = quoOnGoal(g, idx, r, c);
  quoPushHistory(g, g.actions + '. ' + quoCoord(from[0], from[1]) + '-' + quoCoord(r, c));
  if (fin) quoFinish(g, idx, prePaths); else quoAdvance(g);
  return { ok: true, finished: fin, ranking: g.over ? g.over.ranking : null };
}
function quoApplyWall(g, name, r, c, o) {
  if (!g) return { ok: false, msg: '对局不存在' };
  if (g.over) return { ok: false, msg: '对局已结束' };
  const idx = g.playerOrder.indexOf(name);
  if (idx < 0) return { ok: false, msg: '你不在本局中' };
  if (g.current !== idx) return { ok: false, msg: '还没轮到你' };
  o = (o === 'V') ? 'V' : 'H';
  r = Number(r); c = Number(c);
  if ((g.wallLeft[idx] || 0) <= 0) return { ok: false, msg: '你的墙已用完' };
  if (!quoWallLegal(g, idx, r, c, o)) return { ok: false, msg: '这里不能放墙（重叠或会堵死玩家）' };
  const actives = quoActiveIdx(g);
  const before = actives.map(i => quoPathLen(g, i));
  g.walls.add(quoWallKey(r, c, o));
  g.wallOwner[quoWallKey(r, c, o)] = idx;
  g.wallLeft[idx]--;
  g.wallsUsed[idx]++;
  g.actions++;
  quoPushHistory(g, g.actions + '. ' + quoCoord(r, c) + o);
  // 一堵定乾坤：使任意对手最短路径 +10 以上
  actives.forEach((i, k) => {
    if (i === idx) return;
    const after = quoPathLen(g, i);
    if (before[k] >= 0 && after - before[k] >= 10) announceAchievement(g, g.roomId, name, 'q_wall10');
  });
  quoAdvance(g);
  return { ok: true };
}
function quoView(g, name, room) {
  const idx = g.playerOrder.indexOf(name);
  const online = {};
  for (const n of g.playerOrder) {
    const hb = userLastHeartbeat.get(n);
    const sid = room && room.playerMap.get(n);
    online[n] = !!(hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && quoriAtGame.get(n) === sid && io.sockets.sockets.has(sid));
  }
  const players = g.playerOrder.map((n, i) => ({
    name: n, index: i, color: QUO_COLORS[i], colorName: QUO_COLOR_NAMES[i],
    pos: g.pos[i], goal: quoGoalOf(g, i), wallLeft: g.wallLeft[i], wallsUsed: g.wallsUsed[i],
    finished: g.finished.includes(i), rank: g.finished.includes(i) ? (g.finished.indexOf(i) + 1) : 0,
    online: online[n]
  }));
  const myTurn = !g.over && idx >= 0 && g.current === idx;
  const out = {
    you: name, players, playerOrder: g.playerOrder.slice(),
    current: g.current, actions: g.actions,
    walls: [...g.walls].map(k => { const [r, c, o] = k.split(','); return { r: +r, c: +c, o, owner: g.wallOwner[k] == null ? 0 : g.wallOwner[k] }; }),
    goalCells: g.playerOrder.map((_, i) => ({ index: i, color: QUO_COLORS[i], cells: quoGoalCells(g, i) })),
    legalMoves: myTurn ? quoLegalMoves(g, idx) : [],
    legalWalls: [],
    over: g.over || null,
    history: g.history.slice(),
    snapshotCount: g.snapshots.length,
    cancelVotes: (g.cancelVotes || []).slice()
  };
  if (myTurn && (g.wallLeft[idx] || 0) > 0) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (quoWallLegal(g, idx, r, c, 'H')) out.legalWalls.push({ r, c, o: 'H' });
      if (quoWallLegal(g, idx, r, c, 'V')) out.legalWalls.push({ r, c, o: 'V' });
    }
  }
  return out;
}
function quoBroadcast(room, g) {
  room.playerMap.forEach((sid, n) => {
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('quoridor_state', quoView(g, n, room));
  });
}
function quoBroadcastFor(roomId) {
  const room = GAME_ROOMS.quoridor;
  const g = quoridorGames[roomId];
  if (room && g && g.roomId === roomId) quoBroadcast(room, g);
}
function quoSnapshotOf(g, index) {
  if (!g || index < 0 || index >= g.snapshots.length) return null;
  const s = g.snapshots[index];
  return { pos: s.pos, wallList: s.wallList, wallOwner: s.wallOwner, wallLeft: s.wallLeft, current: s.current, finished: s.finished, step: g.history[index] || '' };
}
function quoCancel(room, g) {
  delete quoridorGames[room.roomId];
  io.to(room.roomId).emit('quoridor_cancel');
  Object.keys(room.seats).forEach(sid => { if (room.seats[sid]) room.seats[sid].ready = false; });
  broadcastRoom(room);
}
// 时光墙：只记正式玩家的整局名次（走步记录留在对局页的“时光墙”小展开）
function recordQuoridorGame(g) {
  if (!g || !g.over || g._recorded) return;
  g._recorded = true;
  const officials = g.playerOrder.filter(isOfficialPlayer);
  if (!officials.length) return;
  addTimeline({
    ts: Date.now(), type: 'game', game: 'quoridor', totalPlayers: g.playerOrder.length, mode: g.playerOrder.length + '人',
    players: officials,
    ranking: g.over.ranking,
    actions: g.actions,
    history: g.history.slice(),
    walls: g.playerOrder.map((n, i) => ({ name: n, left: g.wallLeft[i], used: g.wallsUsed[i] })),
    results: officials.map(n => {
      const r = g.over.ranking.find(x => x.name === n) || { rank: 0 };
      return { name: n, rank: r.rank, score: r.rank ? (g.playerOrder.length - r.rank + 1) : 0 };
    })
  });
}

// ======================== 技能五子棋（gomoku）核心 ========================
// 规格见 development/制作笔记/SKillGomoku.md：15×15、2~4 人、8 角色各选其一、3 次五连获胜
const GMK_SIZE = 15;
const GMK_TOTAL = GMK_SIZE * GMK_SIZE;
const GMK_ROLES = ['掌权者', '幸运儿', '封印师', '清洁工', '侦探', '灵魂棋手', '摸鱼高手', '截码战专家'];
const GMK_ROLE_DESC = {
  '掌权者': '必定先手；一子同时形成两个五连直接获胜',
  '幸运儿': '每次达成五连都获得一次额外落子（额外回合里再成五连则只计分、不再追加）',
  '封印师': '每轮可锁定一个空位（本轮双方不可落子，不能连续锁同一位置）',
  '清洁工': '五连计分后清除这五子，并由你自己点选要移除的两颗敌子（尽量来自不同对手）',
  '侦探': '仅自己可见地高亮“差一子成五连”的空位',
  '灵魂棋手': '第一次五连前可在他人棋子上叠加落子（共存）；五连后能力失效',
  '摸鱼高手': '累计达成 5 次四连直接获胜',
  '截码战专家': '每轮秘密预测两个点：命中可加分，满阈值后减少五连需求或直接获胜'
};
// 截码战专家技能说明随人数缩放（4 人为标准局）
function gmkCodeDesc(cfg, n) {
  const hit = (cfg.hit1 === cfg.hit2) ? ('命中一处 +' + cfg.hit1 + ' 分') : ('命中 1 人 +' + cfg.hit1 + ' 分、命中 2 人 +' + cfg.hit2 + ' 分');
  return '每轮秘密预测两个点（每轮刷新、仅自己可见）：' + hit
    + '；满 ' + cfg.need2 + ' 分五连需求 -1、满 ' + cfg.need1 + ' 分再 -1、满 ' + cfg.win + ' 分直接获胜（' + n + ' 人局阈值）';
}
function gmkRoleDesc(g) {
  const n = (g.players || []).length;
  const cfg = g.codeCfg || gmkCodeConfig(n);
  return Object.assign({}, GMK_ROLE_DESC, { '截码战专家': gmkCodeDesc(cfg, n) });
}
const GMK_COLORS = ['#e7928e', '#8fb2e0', '#9cc79b', '#e2cc94'];   // 淡雅半透明磨砂色（前端再叠光泽与透明度）
const GMK_DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
function gmkIn(r, c) { return r >= 0 && r < GMK_SIZE && c >= 0 && c < GMK_SIZE; }
function gmkCell(g, r, c) { return gmkIn(r, c) ? g.board[r * GMK_SIZE + c] : null; }
function gmkIndex(g, name) { return g.players.findIndex(p => p.name === name); }
function gmkInit(room, names, continueRanking) {
  const players = names.map((n, i) => ({
    name: n, index: i, color: GMK_COLORS[i], role: null,
    five: 0, four: 0, score: 0, need: 3, hitCount: 0, predictHitsThisRound: 0,
    sealCell: null, lastSeal: null, sealCounts: {},
    soulActive: true, soulStones: new Set(), soulFiveFlags: [],
    extraPending: false, extraUsed: false,
    hintsSeen: false, placedOnHint: false, hintRounds: new Set(), hintUsedRounds: new Set(),
    predictRound: 0, predictScored: false, predictFromSeq: 0, predictSkipRound: 0, sealSkipRound: 0, placedRound: 0,
    cleanCount: 0, finished: false, rank: 0, predict: []
  }));
  const board = Array.from({ length: GMK_TOTAL }, () => []);
  return {
    roomId: room.roomId, playerOrder: names.slice(), players, board,
    phase: 'pick', order: null, turnIdx: 0, round: 1, moved: [],
    seal: null, roundMoves: [], over: null, ranking: [],
    seq: 0, moveLog: [],
    codeCfg: gmkCodeConfig(names.length),
    cleanPending: null, notice: null, noticeSeq: 0,
    continueRanking: !!continueRanking, log: [], cancelVotes: [], _recorded: false, winnerInfo: null
  };
}
// 全场可见的技能/关键事件通告（前端在提示条显示 + Toast）
function gmkNotice(g, text, kind) {
  if (!g || !text) return;
  g.noticeSeq = (g.noticeSeq || 0) + 1;
  g.notice = { text, kind: kind || 'info', seq: g.noticeSeq, ts: Date.now() };
  if (g.noticeSeq > 1e9) g.noticeSeq = 1;
}
function gmkCoord(r, c) { return String.fromCharCode(65 + c) + (r + 1); }
// 回合结束前必须完成的技能：截码战专家每轮必须提交预测；封印师每轮必须封印或“空封”
function gmkSkillPending(g, p) {
  if (!p) return '';
  if (p.role === '截码战专家') {
    const done = (p.predict.length === 2 && p.predictRound === g.round) || p.predictSkipRound === g.round;
    if (!done) return 'predict';
  }
  if (p.role === '封印师' && p.sealRound !== g.round && p.sealSkipRound !== g.round) return 'seal';
  return '';
}
// 技能都做完才结束该玩家的回合；否则回合留在本人身上
function gmkMaybeEndTurn(g, idx) {
  const p = gmkP(g, idx);
  const need = gmkSkillPending(g, p);
  if (need) {
    if (!g.skillWaitFor || g.skillWaitFor.idx !== idx || g.skillWaitFor.need !== need) {
      g.skillWaitFor = { idx, need, since: Date.now() };
    }
    return false;
  }
  g.skillWaitFor = null;
  gmkFinishTurn(g, idx);
  return true;
}
// 落子后的回合推进（清洁工选完棋子后也走这里）
function gmkFinishTurn(g, idx) {
  if (!g.moved.includes(idx)) g.moved.push(idx);
  if (gmkActiveIdxs(g).every(i => g.moved.includes(i))) gmkRoundEnd(g);
  if (!g.over) { gmkAdvance(g); gmkSettlePredictions(g); }
}
// 截码战专家：预测持续到“下次自己回合”才结算（覆盖这段时间里其他所有人的落子）
function gmkSettlePredictions(g, force) {
  if (!g || g.over || g.phase !== 'play') return;
  for (const p of g.players) {
    if (p.finished || p.role !== '截码战专家') continue;
    if (!force && g.turnIdx !== p.index) continue;        // 默认只在自己的回合开始时结算
    if (!(p.predict.length === 2) || p.predictScored) continue;
    const hitPlayers = new Set();
    (g.moveLog || []).forEach(mv => {
      if (mv.seq <= (p.predictFromSeq || 0)) return;     // 只统计提交之后的落子
      if (mv.idx === p.index) return;                    // 自己的落子不算
      if (p.predict.some(pd => pd.r === mv.r && pd.c === mv.c)) hitPlayers.add(mv.idx);
    });
    const cfg = g.codeCfg || gmkCodeConfig(g.players.length);
    const gain = hitPlayers.size ? (hitPlayers.size >= 2 ? cfg.hit2 : cfg.hit1) : 0;
    if (gain) {
      p.hitCount += hitPlayers.size;
      p.score += gain;
      gmkNotice(g, '截码战专家 ' + p.name + ' 预测命中！+' + gain + ' 分（共 ' + p.score + ' 分）', 'code');
    }
    p.need = p.score >= cfg.need1 ? 1 : (p.score >= cfg.need2 ? 2 : 3);
    p.predict = [];
    p.predictScored = true;
    p.predictRound = 0;
    p.predictFromSeq = 0;
    if (p.score >= cfg.win) gmkWin(g, p.index, '截码战 ' + cfg.win + ' 分', 'gm_decode');
  }
}
// 可被清洁工移除的敌子（完成名次的玩家棋子不再参与）
function gmkCleanTargets(g, idx) {
  const out = [];
  for (let i = 0; i < g.board.length; i++) {
    const r = Math.floor(i / GMK_SIZE), c = i % GMK_SIZE;
    for (const owner of g.board[i]) {
      if (owner === idx) continue;
      const op = g.players[owner];
      if (!op || op.finished) continue;
      out.push({ r, c, owner, name: op.name });
    }
  }
  return out;
}
function gmkStartClean(g, idx, dirs, r, c) {
  const targets = gmkCleanTargets(g, idx);
  const owners = new Set(targets.map(t => t.owner));
  const p = gmkP(g, idx);
  // 先问本人是否发动技能；发动后才清除自己的五子并进入点选
  g.cleanPending = {
    by: idx, phase: 'ask', need: Math.min(2, targets.length), picks: [],
    multiOwner: owners.size >= 2, startedAt: Date.now(),
    lines: dirs.map(([dr, dc]) => gmkLineCells(g, idx, r, c, dr, dc))
  };
  gmkNotice(g, '清洁工 ' + p.name + ' 达成五连：可选择是否发动清洁技能（清除自己五子并移除两颗敌子）', 'clean');
  return true;
}
// 清洁工决定是否发动技能
function gmkCleanChoose(g, name, use) {
  if (!g || g.over) return { ok: false, msg: '对局已结束' };
  const cp = g.cleanPending;
  if (!cp || cp.phase !== 'ask') return { ok: false, msg: '当前不需要选择' };
  const idx = gmkIndex(g, name);
  if (idx !== cp.by) return { ok: false, msg: '当前不是你在选择' };
  const p = gmkP(g, idx);
  if (!use) {
    g.cleanPending = null;
    gmkNotice(g, '清洁工 ' + p.name + ' 选择不发动清洁技能（自己五连保留在棋盘上）', 'clean');
    gmkMaybeEndTurn(g, idx);
    return { ok: true, declined: true };
  }
  // 发动：清除自己五连的棋子
  (cp.lines || []).forEach(line => line.forEach(([rr, cc]) => {
    g.board[rr * GMK_SIZE + cc] = g.board[rr * GMK_SIZE + cc].filter(x => x !== idx);
  }));
  cp.lines = [];
  p.cleanCount++;
  const targets = gmkCleanTargets(g, idx);
  if (!targets.length) {
    g.cleanPending = null;
    gmkNotice(g, '清洁工 ' + p.name + ' 清除了自己的五连（场上没有可移除的敌子）', 'clean');
    gmkMaybeEndTurn(g, idx);
    return { ok: true, done: true };
  }
  cp.phase = 'pick';
  cp.need = Math.min(2, targets.length);
  cp.multiOwner = new Set(targets.map(t => t.owner)).size >= 2;
  cp.startedAt = Date.now();
  gmkNotice(g, '清洁工 ' + p.name + ' 发动技能：正在选择要移除的敌子（' + cp.need + ' 颗）', 'clean');
  return { ok: true, picking: true };
}
// 清洁工点选要移除的敌子
function gmkCleanPick(g, name, r, c) {
  if (!g || g.over) return { ok: false, msg: '对局已结束' };
  const cp = g.cleanPending;
  if (!cp || cp.phase !== 'pick') return { ok: false, msg: '当前不需要选择棋子' };
  const idx = gmkIndex(g, name);
  if (idx !== cp.by) return { ok: false, msg: '当前不是你在选择' };
  r = Number(r); c = Number(c);
  if (!gmkIn(r, c)) return { ok: false, msg: '位置不合法' };
  const cell = gmkCell(g, r, c);
  const targets = gmkCleanTargets(g, idx);
  const t = targets.find(x => x.r === r && x.c === c);
  if (!t) return { ok: false, msg: '这里没有可移除的敌子' };
  if (cp.multiOwner && cp.picks.length === 1 && cp.picks[0].owner === t.owner) {
    return { ok: false, msg: '两颗敌子要来自不同玩家' };
  }
  g.board[r * GMK_SIZE + c] = g.board[r * GMK_SIZE + c].filter(x => x !== t.owner);
  cp.picks.push({ r, c, owner: t.owner, name: t.name });
  gmkNotice(g, '清洁工 ' + gmkP(g, idx).name + ' 移除了 ' + t.name + ' 的棋子（' + gmkCoord(r, c) + '）', 'clean');
  const remain = cp.multiOwner
    ? gmkCleanTargets(g, idx).filter(x => !cp.picks.some(k => k.owner === x.owner)).length
    : gmkCleanTargets(g, idx).length;
  if (cp.picks.length >= cp.need || remain === 0) {
    g.cleanPending = null;
    gmkMaybeEndTurn(g, idx);
    return { ok: true, done: true };
  }
  return { ok: true };
}
// 某方向上以 (r,c) 为中心的连续己方棋子
function gmkLineCells(g, idx, r, c, dr, dc) {
  const cells = [];
  let rr = r, cc = c;
  while (gmkIn(rr, cc) && gmkCell(g, rr, cc).includes(idx)) { cells.push([rr, cc]); rr -= dr; cc -= dc; }
  rr = r + dr; cc = c + dc;
  while (gmkIn(rr, cc) && gmkCell(g, rr, cc).includes(idx)) { cells.push([rr, cc]); rr += dr; cc += dc; }
  return cells;
}
// 某方向上、以 (r,c) 为中心的两侧连续己方棋子数（不含 (r,c) 本身）
function gmkSideRuns(g, idx, r, c, dr, dc) {
  let left = 0, right = 0;
  let rr = r - dr, cc = c - dc;
  while (gmkIn(rr, cc) && gmkCell(g, rr, cc).includes(idx)) { left++; rr -= dr; cc -= dc; }
  rr = r + dr; cc = c + dc;
  while (gmkIn(rr, cc) && gmkCell(g, rr, cc).includes(idx)) { right++; rr += dr; cc += dc; }
  return [left, right];
}
// 本步“新形成”的五连方向：该方向本次才连成五连（五连以上只算一次，继续延长不再计）
function gmkFiveDirs(g, idx, r, c) {
  return GMK_DIRS.filter(([dr, dc]) => {
    const [l, rt] = gmkSideRuns(g, idx, r, c, dr, dc);
    if (l >= 5 || rt >= 5) return false;          // 该侧早已是五连 → 只是延长，不计
    return (l + rt + 1) >= 5;                     // 本步把两侧拼成五连
  });
}
// 本步“新形成”的四连方向：连续四子（四连以上也只算一次）；<5 子时要求至少一端可延伸
function gmkFourDirs(g, idx, r, c) {
  return GMK_DIRS.filter(([dr, dc]) => {
    const [l, rt] = gmkSideRuns(g, idx, r, c, dr, dc);
    if (l >= 4 || rt >= 4) return false;          // 早已四连 → 只是延长，不计
    const total = l + rt + 1;
    if (total < 4) return false;
    if (total >= 5) return true;                  // 直接成五连：只按一次四连计
    const aIn = gmkIn(r - dr * (l + 1), c - dc * (l + 1));
    const bIn = gmkIn(r + dr * (rt + 1), c + dc * (rt + 1));
    const aOpen = aIn && !gmkCell(g, r - dr * (l + 1), c - dc * (l + 1)).includes(idx);
    const bOpen = bIn && !gmkCell(g, r + dr * (rt + 1), c + dc * (rt + 1)).includes(idx);
    return aOpen || bOpen;                        // 至少一端为空（可延伸成五连）
  });
}
// 四连条数（摸鱼高手计数用：每个方向本步最多 +1）
function gmkFourCount(g, idx, r, c) { return gmkFourDirs(g, idx, r, c).length; }
// 侦探提示：所有“差一子成五连”的空位（可落子处，且放下去是新五连）
function gmkHints(g, idx) {
  const out = [];
  for (let r = 0; r < GMK_SIZE; r++) for (let c = 0; c < GMK_SIZE; c++) {
    const cell = gmkCell(g, r, c);
    if (cell.includes(idx)) continue;
    if (cell.length && !(gmkP(g, idx).role === '灵魂棋手' && gmkP(g, idx).soulActive)) continue;
    g.board[r * GMK_SIZE + c].push(idx);
    if (gmkFiveDirs(g, idx, r, c).length) out.push([r, c]);
    g.board[r * GMK_SIZE + c].pop();
  }
  return out;
}
// 掌权者：找出该玩家所有连续五子窗口，并记录方向
function gmkFiveWindows(g, idx) {
  const wins = [];
  for (const [dr, dc] of GMK_DIRS) {
    for (let r = 0; r < GMK_SIZE; r++) for (let c = 0; c < GMK_SIZE; c++) {
      const cells = [];
      let ok = true;
      for (let k = 0; k < 5; k++) {
        const rr = r + dr * k, cc = c + dc * k;
        if (!gmkIn(rr, cc) || !gmkCell(g, rr, cc).includes(idx)) { ok = false; break; }
        cells.push(rr * GMK_SIZE + cc);
      }
      if (ok) wins.push({ dir: dr + ',' + dc, cells });
    }
  }
  return wins;
}
// 双重五连：两条“不同方向”的五连共用至少一枚棋子（不要求共用的是刚落下的那颗）
// 同方向的长连（6、7 连）只算一个五连，不算双重五连
function gmkHasDoubleFive(g, idx) {
  const wins = gmkFiveWindows(g, idx);
  for (let i = 0; i < wins.length; i++) {
    for (let j = i + 1; j < wins.length; j++) {
      if (wins[i].dir === wins[j].dir) continue;                    // 同方向的窗口不算“两个五连”
      if (wins[i].cells.some(x => wins[j].cells.includes(x))) return true;
    }
  }
  return false;
}
// 截码战专家阈值：随人数缩放（4 人为标准局）
function gmkCodeConfig(n) {
  if (n >= 4) return { need2: 18, need1: 36, win: 54, hit1: 1, hit2: 3, label: '18/36/54' };
  if (n === 3) return { need2: 12, need1: 24, win: 36, hit1: 1, hit2: 3, label: '12/24/36' };
  return { need2: 15, need1: 30, win: 45, hit1: 3, hit2: 3, label: '15/30/45（命中一处即 +3）' };
}

function gmkP(g, i) { return g.players[i]; }
function gmkActiveIdxs(g) { return g.players.map((p, i) => i).filter(i => !g.players[i].finished); }
// 角色专属成就（只有“获胜”的玩家才能拿，2026-09-16 口径确认）：
// - 真相不止一个（侦探）：存在某个“有差一子提示”的轮次，且那一轮里没有落子在任何提示点上
// - 大扫除（清洁工）：一局内移除两次五连
// - 中元快乐（灵魂棋手）：三个五连都含灵魂（共存）棋子
// - 愚言家（截码战专家）：一局 0 命中
function gmkSettleWinnerRoleAchievements(g, p) {
  if (!p) return;
  if (p.role === '侦探') {
    for (const rd of (p.hintRounds || [])) {
      if (!p.hintUsedRounds.has(rd)) { announceAchievement(g, g.roomId, p.name, 'gm_detective'); break; }
    }
  }
  if (p.role === '清洁工' && p.cleanCount >= 2) announceAchievement(g, g.roomId, p.name, 'gm_clean');
  if (p.role === '灵魂棋手' && p.soulFiveFlags.length >= 3 && p.soulFiveFlags.slice(0, 3).every(Boolean)) {
    announceAchievement(g, g.roomId, p.name, 'gm_soul');
  }
  if (p.role === '截码战专家' && p.hitCount === 0) announceAchievement(g, g.roomId, p.name, 'gm_fool');
}
// 轮末：只清理回合数据；预测不在这里结算（改为“下次自己回合”结算）
function gmkRoundEnd(g) {
  // 封印：持续一轮——本轮末不清除，下一轮末再解除（避免“封完立刻被清掉”）
  if (g.seal && g.seal.round < g.round) g.seal = null;
  g.roundMoves = [];
  g.moved = [];
  g.round++;
}
function gmkAdvance(g) {
  const act = gmkActiveIdxs(g);
  if (act.length <= 1) return;
  for (let k = 1; k <= g.players.length; k++) {
    const i = (g.turnIdx + k) % g.players.length;
    if (act.includes(i)) { g.turnIdx = i; return; }
  }
}
// 排名用的五连数：截码战专家的技能进度计入（满 18/12/15 分算 +1，满 36/24/30 分算 +2）；其余技能分不影响排名
function gmkRankFives(p, cfg) {
  let f = p.five;
  if (p.role === '截码战专家') {
    if (p.score >= cfg.need1) f += 2;
    else if (p.score >= cfg.need2) f += 1;
  }
  return f;
}
// 未开启「继续决出排名」时的最终排名：按五连数排名，同数并列；获胜者固定第 1
function gmkApplyFinalRanking(g) {
  const cfg = g.codeCfg || gmkCodeConfig(g.players.length);
  const winIdx = g.ranking.length ? g.ranking[0] : -1;
  const rows = g.players.map(p => ({ idx: p.index, name: p.name, role: p.role, f: gmkRankFives(p, cfg), win: p.index === winIdx }));
  const counts = rows.map(r => r.f);
  rows.forEach(r => { r.rank = r.win ? 1 : 1 + counts.filter(x => x > r.f).length; });
  rows.sort((a, b) => (b.win ? 1 : 0) - (a.win ? 1 : 0) || b.f - a.f || a.idx - b.idx);
  rows.forEach(r => { g.players[r.idx].rank = r.rank; });
  g.ranking = rows.map(r => r.idx);
  return rows.map(r => ({ name: r.name, role: r.role, rank: r.rank, fives: r.f, tie: rows.filter(x => x.rank === r.rank).length > 1 }));
}
function gmkWin(g, idx, reason, achId) {
  const p = gmkP(g, idx);
  if (!p || p.finished) return;
  p.finished = true;
  p.rank = g.ranking.length + 1;
  g.ranking.push(idx);
  if (achId) announceAchievement(g, g.roomId, p.name, achId);
  g.players.forEach(q => {
    if (q.index === idx || q.finished) return;
    if (gmkHints(g, q.index).length) announceAchievement(g, g.roomId, q.name, 'gm_slow');
  });
  const remain = gmkActiveIdxs(g);
  if (!g.continueRanking || remain.length <= 1) {
    remain.forEach(i => { if (!g.players[i].finished) { g.players[i].finished = true; } });
    g.winnerInfo = { name: p.name, reason };
    if (g.continueRanking) {
      // 决出全部名次：按完成顺序排名
      g.ranking.forEach((i, k) => { g.players[i].rank = k + 1; });
      g.over = {
        winner: p.name, reason, rankMode: true,
        ranking: g.ranking.map(i => ({ name: g.players[i].name, rank: g.players[i].rank, role: g.players[i].role, fives: g.players[i].five, tie: false }))
      };
    } else {
      g.over = { winner: p.name, reason, rankMode: false, ranking: gmkApplyFinalRanking(g) };
    }
    gmkNotice(g, p.name + ' 获胜（' + reason + '）', 'win');
    gmkSettlePredictions(g, true);           // 终局把未结算的预测一次性结清（用于统计与成就）
    gmkSettleWinnerRoleAchievements(g, p);   // 角色专属成就：仅获胜者可拿
    recordGomokuGame(g);
  } else {
    gmkAdvance(g);
    gmkSettlePredictions(g);
  }
}
function gmkPlace(g, name, r, c) {
  if (!g) return { ok: false, msg: '对局不存在' };
  if (g.phase !== 'play') return { ok: false, msg: '还没开始' };
  if (g.over) return { ok: false, msg: '对局已结束' };
  const idx = gmkIndex(g, name);
  if (idx < 0) return { ok: false, msg: '你不在本局中' };
  const p = gmkP(g, idx);
  if (p.finished) return { ok: false, msg: '你已完成，等待其他玩家' };
  if (g.turnIdx !== idx) return { ok: false, msg: '还没轮到你' };
  r = Number(r); c = Number(c);
  if (!gmkIn(r, c)) return { ok: false, msg: '位置不合法' };
  const cell = gmkCell(g, r, c);
  if (g.seal && g.seal.r === r && g.seal.c === c) return { ok: false, msg: '该位置被封印' };
  if (cell.includes(idx)) return { ok: false, msg: '这里已有你的棋子' };
  const soulOk = p.role === '灵魂棋手' && p.soulActive && cell.length > 0 && !cell.includes(idx);
  if (cell.length && !soulOk) return { ok: false, msg: '该位置已有棋子' };
  const isExtra = p.extraPending;
  // 每回合只能落一子（幸运儿的额外落子除外）；技能未完成时回合仍在自己身上，不能重复落子
  if (p.placedRound === g.round && !isExtra) return { ok: false, msg: '本轮已经落子了，请完成本回合技能' };
  if (isExtra) { p.extraPending = false; p.extraUsed = true; }
  const hintsBefore = gmkHints(g, idx);
  // 本回合存在“差一子”提示 → 记下这轮；若本轮里落子在任何提示点上，则把这轮标记为“已点提示”
  if (hintsBefore.length) { p.hintsSeen = true; p.hintRounds.add(g.round); }
  if (hintsBefore.some(([hr, hc]) => hr === r && hc === c)) { p.placedOnHint = true; p.hintUsedRounds.add(g.round); }
  cell.push(idx);
  if (cell.length > 1) p.soulStones.add(r + ',' + c);
  g.roundMoves.push({ idx, r, c });
  g.moveLog.push({ seq: ++g.seq, idx, r, c });
  if (g.moveLog.length > 60) g.moveLog.splice(0, g.moveLog.length - 60);
  const dirs = gmkFiveDirs(g, idx, r, c);
  if (dirs.length) {
    p.five += dirs.length;
    gmkNotice(g, p.name + ' 达成第 ' + p.five + ' 次五连（' + gmkCoord(r, c) + '）'
      + (dirs.length >= 2 ? '——一子双五连，计 2 次' : ''), 'five');
    if (p.role === '灵魂棋手') {
      dirs.forEach(([dr, dc]) => {
        const cells = gmkLineCells(g, idx, r, c, dr, dc);
        p.soulFiveFlags.push(cells.some(([rr, cc]) => gmkCell(g, rr, cc).length > 1));
      });
      p.soulActive = false;
    }
    // 幸运儿：每次五连都给一次额外落子；额外回合里再成五连不再追加
    if (p.role === '幸运儿' && !isExtra) {
      p.extraPending = true;
      gmkNotice(g, '幸运儿 ' + p.name + ' 达成五连，获得一次额外落子', 'lucky');
    }
    if (p.role === '幸运儿' && isExtra) announceAchievement(g, g.roomId, p.name, 'gm_lucky');
    // 清洁工：清自己的五子 + 由本人点选移除两颗敌子
    if (p.role === '清洁工') {
      const needPick = gmkStartClean(g, idx, dirs, r, c);
      if (!g.over && p.five >= p.need) gmkWin(g, idx, '3次五连', '');
      if (g.over) return { ok: true, win: true };
      if (needPick && g.cleanPending) { p.placedRound = g.round; return { ok: true, cleaning: true }; }
    }
    if (!g.over && p.five >= p.need) gmkWin(g, idx, '3次五连', '');
  }
  // 掌权者：任意一次落子后，只要棋盘上存在“共用至少一枚棋子的两个五连”即直接获胜
  if (!g.over && p.role === '掌权者' && gmkHasDoubleFive(g, idx)) { gmkWin(g, idx, '双重五连', 'gm_destiny'); return { ok: true, win: true }; }
  if (!g.over && p.role === '摸鱼高手') {
    const nf = gmkFourCount(g, idx, r, c);
    if (nf) {
      p.four += nf;
      gmkNotice(g, '摸鱼高手 ' + p.name + ' 累计四连 ' + p.four + '/5', 'four');
      if (p.four >= 5) gmkWin(g, idx, '5次四连', 'gm_moyu');
    }
  }
  if (g.over) return { ok: true, win: true };
  if (g.cleanPending) { p.placedRound = g.round; return { ok: true, cleaning: true }; }
  if (p.extraPending) { p.placedRound = g.round; return { ok: true, extra: true }; }
  p.placedRound = g.round;
  if (!gmkMaybeEndTurn(g, idx)) return { ok: true, waitSkill: true };
  return { ok: true };
}
function gmkSeal(g, name, r, c) {
  if (!g || g.phase !== 'play' || g.over) return { ok: false, msg: '当前不能封印' };
  const idx = gmkIndex(g, name);
  if (idx < 0) return { ok: false, msg: '你不在本局中' };
  const p = gmkP(g, idx);
  if (p.role !== '封印师') return { ok: false, msg: '只有封印师可以锁定位置' };
  if (g.turnIdx !== idx) return { ok: false, msg: '还没轮到你' };
  if (p.sealRound === g.round) return { ok: false, msg: '本轮已经封印过了' };
  r = Number(r); c = Number(c);
  if (!gmkIn(r, c) || gmkCell(g, r, c).length) return { ok: false, msg: '只能封印空位' };
  const key = r + ',' + c;
  if (p.lastSeal === key) return { ok: false, msg: '不能连续两轮封印同一位置' };
  g.seal = { r, c, by: idx, round: g.round };
  p.lastSeal = key;
  p.sealRound = g.round;
  p.sealCounts[key] = (p.sealCounts[key] || 0) + 1;
  if (p.sealCounts[key] >= 5) announceAchievement(g, g.roomId, p.name, 'gm_seal');
  gmkNotice(g, '封印师 ' + p.name + ' 封印了 ' + gmkCoord(r, c) + '（本轮双方不可落子）', 'seal');
  if (p.placedRound === g.round) gmkMaybeEndTurn(g, idx);   // 已落子 → 技能完成后结束回合
  return { ok: true };
}
// 封印师“空封”：本轮不封锁，但仍视为完成本轮技能
function gmkSealSkip(g, name) {
  if (!g || g.phase !== 'play' || g.over) return { ok: false, msg: '当前不能操作' };
  const idx = gmkIndex(g, name);
  if (idx < 0) return { ok: false, msg: '你不在本局中' };
  const p = gmkP(g, idx);
  if (p.role !== '封印师') return { ok: false, msg: '只有封印师可以封锁位置' };
  if (g.turnIdx !== idx) return { ok: false, msg: '还没轮到你' };
  if (p.sealRound === g.round || p.sealSkipRound === g.round) return { ok: false, msg: '本轮已经处理过了' };
  p.sealSkipRound = g.round;
  gmkNotice(g, '封印师 ' + p.name + ' 本轮选择不封锁（空封）', 'seal');
  if (p.placedRound === g.round) gmkMaybeEndTurn(g, idx);
  return { ok: true };
}
function gmkPredict(g, name, list) {
  if (!g || g.phase !== 'play' || g.over) return { ok: false, msg: '当前不能预测' };
  const idx = gmkIndex(g, name);
  if (idx < 0) return { ok: false, msg: '你不在本局中' };
  const p = gmkP(g, idx);
  if (p.role !== '截码战专家') return { ok: false, msg: '只有截码战专家可以预测' };
  const arr = (Array.isArray(list) ? list : []).slice(0, 2).map(x => ({ r: Number(x.r), c: Number(x.c) })).filter(x => gmkIn(x.r, x.c));
  if (arr.length !== 2) return { ok: false, msg: '需要选择两个预测点' };
  p.predict = arr;
  p.predictRound = g.round;
  p.predictScored = false;
  p.predictFromSeq = g.seq;
  gmkNotice(g, '截码战专家 ' + p.name + ' 提交了本轮预测（持续到下次自己回合才结算，内容仅自己可见）', 'code');
  if (p.placedRound === g.round) gmkMaybeEndTurn(g, idx);   // 已落子 → 预测完成后结束回合
  return { ok: true };
}
// 选角：全部选完后排序（掌权者固定第 1 顺位，其余随机）
function gmkPickRole(g, name, role) {
  if (!g || g.phase !== 'pick') return { ok: false, msg: '当前不能选角色' };
  const idx = gmkIndex(g, name);
  if (idx < 0) return { ok: false, msg: '你不在本局中' };
  if (!GMK_ROLES.includes(role)) return { ok: false, msg: '角色不存在' };
  if (g.players.some(p => p.index !== idx && p.role === role)) return { ok: false, msg: '该角色已被选择' };
  g.players[idx].role = role;
  if (g.players.every(p => p.role)) {
    const others = g.players.map(p => p.index).filter(i => g.players[i].role !== '掌权者');
    for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
    const order = g.players.some(p => p.role === '掌权者') ? [g.players.findIndex(p => p.role === '掌权者')].concat(others) : others;
    g.order = order;
    g.turnIdx = order[0];
    g.phase = 'play';
    g.round = 1;
    g.moved = [];
  }
  return { ok: true, started: g.phase === 'play' };
}
function gmkView(g, name, room) {
  const idx = gmkIndex(g, name);
  const online = {};
  for (const p of g.players) {
    const hb = userLastHeartbeat.get(p.name);
    const sid = room && room.playerMap.get(p.name);
    online[p.name] = !!(hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && gomoAtGame.get(p.name) === sid && io.sockets.sockets.has(sid));
  }
  const you = idx >= 0 ? g.players[idx] : null;
  return {
    phase: g.phase, you: name, round: g.round, turnIdx: g.turnIdx,
    turn: (g.phase === 'play' && g.players[g.turnIdx]) ? g.players[g.turnIdx].name : '',
    players: g.players.map(p => ({
      name: p.name, index: p.index, color: p.color, role: p.role,
      five: p.five, four: p.four, score: p.score, need: p.need,
      finished: p.finished, rank: p.rank, extraPending: !!p.extraPending,
      sealedThisRound: p.sealRound === g.round, online: online[p.name],
      sealSkippedThisRound: p.sealSkipRound === g.round,
      placedThisRound: p.placedRound === g.round,
      predictedRound: p.predictRound,
      predictedThisRound: (p.predict || []).length === 2 && p.predictRound === g.round
    })),
    board: g.board.map(cell => cell.slice()),
    seal: g.seal, over: g.over || null, winnerInfo: g.winnerInfo || null,
    myHints: (you && you.role === '侦探' && g.phase === 'play') ? gmkHints(g, idx) : [],
    myPredict: you ? (you.predict || []) : [],
    roleReady: g.phase === 'pick', roles: GMK_ROLES, roleDesc: gmkRoleDesc(g),
    takenRoles: g.players.map(p => p.role).filter(Boolean),
    codeCfg: g.codeCfg || gmkCodeConfig(g.players.length),
    totalPlayers: g.players.length,
    notice: g.notice || null,
    cleanPending: g.cleanPending ? {
      by: g.players[g.cleanPending.by].name,
      phase: g.cleanPending.phase || 'pick',
      need: g.cleanPending.need,
      picks: g.cleanPending.picks.map(k => ({ r: k.r, c: k.c, name: k.name })),
      multiOwner: !!g.cleanPending.multiOwner
    } : null,
    myPredictScored: you ? !!you.predictScored : false,
    waitingSkill: (function () {
      if (!you || g.over || g.phase !== 'play' || g.turnIdx !== idx) return '';
      return gmkSkillPending(g, you);
    })(),
    stdNote: g.players.length < 4 ? '该玩法标准局为四人局，少人开局将会影响游戏性' : '',
    cancelVotes: (g.cancelVotes || []).slice()
  };
}
function gmkBroadcast(room, g) {
  room.playerMap.forEach((sid, n) => {
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('gomoku_state', gmkView(g, n, room));
  });
}
function gmkBroadcastFor(roomId) {
  const room = GAME_ROOMS.gomoku;
  const g = gomokuGames[roomId];
  if (room && g && g.roomId === roomId) gmkBroadcast(room, g);
}
function gmkCancel(room, g) {
  delete gomokuGames[room.roomId];
  io.to(room.roomId).emit('gomoku_cancel');
  Object.keys(room.seats).forEach(sid => { if (room.seats[sid]) room.seats[sid].ready = false; });
  broadcastRoom(room);
}
// 时光墙：记录角色/名次/获胜方式（个人空间角色统计从这里汇总）
// 名次分口径：只有开启「继续决出排名」的对局才给名次分（第1名=人数、第2名=人数-1…），否则一律 0
function recordGomokuGame(g) {
  if (!g || !g.over || g._recorded) return;
  g._recorded = true;
  const officials = g.players.filter(p => isOfficialPlayer(p.name));
  if (!officials.length) return;
  const rankMode = !!g.continueRanking;
  const n = g.players.length;
  addTimeline({
    ts: Date.now(), type: 'game', game: 'gomoku', totalPlayers: n, mode: n + '人', rankMode,
    players: officials.map(p => p.name),
    winner: g.over.winner, reason: g.over.reason,
    roles: g.players.map(p => ({ name: p.name, role: p.role, rank: p.rank })),
    results: officials.map(p => ({ name: p.name, rank: p.rank, fives: p.five, score: rankMode ? (n - p.rank + 1) : 0 }))
  });
}






// ======================== 魔法气泡 PuyoPuyo 核心 ========================
// 规格见 development/制作笔记/puyopuyo.md：6×12、2~4 人独立棋盘、连锁→干扰气泡→相杀
const PPO_COLS = 6;
const PPO_ROWS = 12;
const PPO_CELLS = PPO_COLS * PPO_ROWS;
const PPO_TICK_MS = 80;              // 服务端节拍（≈12.5Hz）
const PPO_GARBAGE = 9;               // 干扰气泡
const PPO_ORIENT = [[-1, 0], [0, 1], [1, 0], [0, -1]];   // 附属气泡：上/右/下/左
const PPO_CHAIN_MULT = [1, 2, 4, 8, 16];                 // 连锁倍率（5 连锁及以上 ×16）
const PPO_LOCK_DELAY = 350;          // 落地缓冲（ms）
const PPO_GARBAGE_DELAY = 1200;      // 干扰气泡延迟落地（ms）＝相杀窗口
const PPO_SOFT_MS = 190;             // 加速下落速度（按住时每格毫秒）
const PPO_OFFLINE_ELIM_MS = Number(process.env.PPO_OFFLINE_MS || 0) || 45000;   // 离线超时淘汰（可用 PPO_OFFLINE_MS 覆盖，便于测试）
const PPO_DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const puyopuyoGames = {};            // roomId -> 对局
const puyoAtGame = new Map();        // playerName -> 当前打开气泡页的 socket.id

function ppoIn(r, c) { return r >= 0 && r < PPO_ROWS && c >= 0 && c < PPO_COLS; }
function ppoI(r, c) { return r * PPO_COLS + c; }
function ppoRand(colors) { return 1 + Math.floor(Math.random() * colors); }
function ppoMakePiece(colors) { return { r: 1, c: 2, orient: 0, colors: [ppoRand(colors), ppoRand(colors)] }; }
function ppoLevel(g, now) { return Math.max(1, Math.min(10, 1 + Math.floor(((now || Date.now()) - g.startedAt) / 30000))); }
function ppoFallMs(level) { return Math.max(140, 820 - (level - 1) * 70); }
function ppoHeight(p) {
  for (let r = 0; r < PPO_ROWS; r++) for (let c = 0; c < PPO_COLS; c++) if (p.board[ppoI(r, c)]) return PPO_ROWS - r;
  return 0;
}
function ppoPieceCells(piece) {
  const [dr, dc] = PPO_ORIENT[piece.orient];
  return [piece.r, piece.c, piece.r + dr, piece.c + dc];
}
function ppoFits(p, piece) {
  const [ar, ac, cr, cc] = ppoPieceCells(piece);
  if (!ppoIn(ar, ac) || !ppoIn(cr, cc)) return false;
  return p.board[ppoI(ar, ac)] === 0 && p.board[ppoI(cr, cc)] === 0;
}
function ppoCanFall(p) {
  if (!p.piece) return false;
  return ppoFits(p, Object.assign({}, p.piece, { r: p.piece.r + 1 }));
}
function ppoMove(p, dc) {
  if (!p.piece) return false;
  const np = Object.assign({}, p.piece, { c: p.piece.c + dc });
  if (!ppoFits(p, np)) return false;
  p.piece = np; p.lockAcc = 0; return true;
}
// 旋转（顺/逆时针），带简单踢墙：原位 → 左右 1 格 → 左右 2 格
function ppoRotate(p, dir) {
  if (!p.piece) return false;
  const o = (p.piece.orient + (dir > 0 ? 1 : 3)) % 4;
  for (const off of [0, -1, 1, -2, 2]) {
    const np = Object.assign({}, p.piece, { orient: o, c: p.piece.c + off });
    if (ppoFits(p, np)) { p.piece = np; p.lockAcc = 0; return true; }
  }
  return false;
}
// 重力：每列向下压实
function ppoGravity(p) {
  for (let c = 0; c < PPO_COLS; c++) {
    const col = [];
    for (let r = PPO_ROWS - 1; r >= 0; r--) if (p.board[ppoI(r, c)]) col.push(p.board[ppoI(r, c)]);
    for (let r = PPO_ROWS - 1, k = 0; r >= 0; r--, k++) p.board[ppoI(r, c)] = k < col.length ? col[k] : 0;
  }
}
// BFS 找出所有 ≥4 的同色连通组（干扰气泡不参与）
function ppoGroups(p) {
  const seen = new Array(PPO_CELLS).fill(false);
  const groups = [];
  for (let i = 0; i < PPO_CELLS; i++) {
    const col = p.board[i];
    if (!col || col === PPO_GARBAGE || seen[i]) continue;
    const stack = [i], cells = [];
    seen[i] = true;
    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const r = Math.floor(cur / PPO_COLS), c = cur % PPO_COLS;
      for (const [dr, dc] of PPO_DIRS4) {
        const nr = r + dr, nc = c + dc;
        if (!ppoIn(nr, nc)) continue;
        const ni = ppoI(nr, nc);
        if (seen[ni] || p.board[ni] !== col) continue;
        seen[ni] = true; stack.push(ni);
      }
    }
    if (cells.length >= 4) groups.push({ color: col, cells });
  }
  return groups;
}
// 连锁 → 发送干扰数：按原作（Puyo Puyo Tsu）的“三角数”口径 n(n-1)/2，单次上限 30
// 2连锁1、3连锁3、4连锁6、5连锁10、6连锁15、7连锁21、8连锁28、9连锁及以上30
function ppoGarbageOfChain(chain) {
  if (chain <= 1) return 0;
  return Math.min(30, Math.floor(chain * (chain - 1) / 2));
}
// 全消奖励（Zenkeshi）：连锁结算后棋盘被彻底清空 → 额外 30 颗干扰（原作关键机制）
const PPO_ZENKESHI_GARBAGE = 30;
// 同时消加成：同一波里同时消除多组 → 每多一组额外 2 颗干扰（原版 Fever 的“同时消”简化版）
const PPO_SIMUL_BONUS_PER_GROUP = 2;
// AI 加速下落速度（对齐并到位后按此速度下落，避免 AI 瞬移刷局）
const PPO_AI_SOFT_MS = 150;

function ppoNewPlayer(name, index, colors, ai) {
  return {
    name, index, board: new Array(PPO_CELLS).fill(0),
    piece: null, next: ppoMakePiece(colors),
    pending: 0, pendingAt: 0, score: 0, maxChain: 0, maxCleared: 0,
    alive: true, rank: 0, fallAcc: 0, lockAcc: 0, soft: false,
    offlineSince: 0, heightBeforeChain: 0, played: 0,
    ai: ai || null, aiPlan: null, aiMoveAt: 0, aiSoft: false, aiLastTick: 0, aiStuck: 0, aiLast: ''
  };
}
function ppoNotice(g, text, kind) {
  g.seq = (g.seq || 0) + 1;
  g.notice = { text, kind: kind || 'info', seq: g.seq, ts: Date.now() };
}
function ppoInit(room, names, opts) {
  const colors = (opts && opts.colors === 5) ? 5 : 4;
  const now = Date.now();
  const aiList = (opts && Array.isArray(opts.ai)) ? opts.ai : [];   // [{ name, difficulty }]
  const players = names.map((n, i) => ppoNewPlayer(n, i, colors, null))
    .concat(aiList.map((a, k) => ppoNewPlayer(a.name, names.length + k, colors, a.difficulty || 'normal')));
  const g = {
    roomId: room.roomId, gameType: 'puyopuyo', phase: 'play',
    playerOrder: players.map(p => p.name), colors,
    garbageMode: (opts && opts.garbageMode === 'random') ? 'random' : 'all',
    startedAt: now, lastTick: now, lastBroadcast: 0,
    players,
    ranking: [], elimOrder: [], over: null, notice: null, seq: 0, cancelVotes: [], _recorded: false
  };
  g.players.forEach(p => ppoSpawn(g, p, now));
  return g;
}
// 生成下一对（用 next 的颜色）；生成位被占 → 该玩家失败
function ppoSpawn(g, p, now) {
  const src = p.next || ppoMakePiece(g.colors);
  p.piece = { r: 1, c: 2, orient: 0, colors: src.colors.slice() };
  p.next = ppoMakePiece(g.colors);
  p.fallAcc = 0; p.lockAcc = 0; p.soft = false;
  if (!ppoFits(p, p.piece)) {
    p.piece = null;
    ppoEliminate(g, p, 'stack', now);
    return false;
  }
  return true;
}
// 干扰气泡落地（每 tick 最多 2 颗；随机列、落在该列堆顶）
function ppoDropGarbage(p, now) {
  if (!p.pending || now < p.pendingAt) return false;
  let dropped = 0;
  const n = Math.min(p.pending, 2);
  for (let k = 0; k < n; k++) {
    const cols = [];
    for (let c = 0; c < PPO_COLS; c++) if (p.board[ppoI(0, c)] === 0) cols.push(c);
    if (!cols.length) break;
    const c = cols[Math.floor(Math.random() * cols.length)];
    let r = -1;
    for (let rr = PPO_ROWS - 1; rr >= 0; rr--) if (p.board[ppoI(rr, c)] === 0) { r = rr; break; }
    if (r < 0) break;
    p.board[ppoI(r, c)] = PPO_GARBAGE;
    p.pending--; dropped++;
  }
  if (p.pending <= 0) { p.pending = 0; p.pendingAt = 0; }
  return dropped > 0;
}
// 落地 → 先压实（补上悬空气泡）→ 连锁结算 → 生成新对
function ppoLock(g, p, now) {
  if (!p.piece) return;
  const [ar, ac, cr, cc] = ppoPieceCells(p.piece);
  p.board[ppoI(ar, ac)] = p.piece.colors[0];
  p.board[ppoI(cr, cc)] = p.piece.colors[1];
  p.piece = null;
  p.played++;
  ppoGravity(p);                      // 关键：锁定后立即让悬空的气泡落下来
  p.heightBeforeChain = ppoHeight(p);
  ppoResolve(g, p, now);
  if (g.over) return;
  ppoSpawn(g, p, now);
}
// 连锁结算：BFS 消除 → 重力 → 再检测；返回连锁数
function ppoResolve(g, p, now) {
  let chain = 0, totalCleared = 0, totalGarbage = 0, gained = 0, simultBonus = 0;
  for (;;) {
    const groups = ppoGroups(p);
    if (!groups.length) break;
    chain++;
    // 同时消加成：同一波里同时消除多组（多组不同色一起消）→ 额外干扰
    if (groups.length > 1) simultBonus += (groups.length - 1) * PPO_SIMUL_BONUS_PER_GROUP;
    const remove = new Set();
    groups.forEach(gr => gr.cells.forEach(i => remove.add(i)));
    const cleared = remove.size;
    const gb = new Set();
    remove.forEach(i => {
      const r = Math.floor(i / PPO_COLS), c = i % PPO_COLS;
      for (const [dr, dc] of PPO_DIRS4) {
        const nr = r + dr, nc = c + dc;
        if (!ppoIn(nr, nc)) continue;
        const ni = ppoI(nr, nc);
        if (p.board[ni] === PPO_GARBAGE) gb.add(ni);
      }
    });
    const mult = PPO_CHAIN_MULT[Math.min(chain, PPO_CHAIN_MULT.length) - 1];
    const add = cleared * 10 * mult;
    p.score += add; gained += add;
    p.maxCleared = Math.max(p.maxCleared, cleared);
    totalCleared += cleared; totalGarbage += gb.size;
    remove.forEach(i => { p.board[i] = 0; });
    gb.forEach(i => { p.board[i] = 0; });
    ppoGravity(p);
  }
  if (!chain) return 0;
  p.maxChain = Math.max(p.maxChain, chain);
  g.lastChain = { name: p.name, chain, cleared: totalCleared, ts: now };
  // 全消奖励（Zenkeshi）：棋盘被清空 → 额外 30 颗干扰
  const zenkeshi = p.board.every(v => v === 0);
  // 干扰气泡：连锁数决定数量（＋同时消加成）；先用本次连锁抵消待落干扰（相杀）
  const send0 = ppoGarbageOfChain(chain) + simultBonus + (zenkeshi ? PPO_ZENKESHI_GARBAGE : 0);
  let send = send0, offset = 0;
  if (send0 && p.pending > 0) {
    offset = Math.min(p.pending, send0);
    p.pending -= offset;
    send = send0 - offset;
    if (p.pending <= 0) { p.pending = 0; p.pendingAt = 0; }
  }
  if (send > 0) {
    const others = g.players.filter(q => q.alive && q.index !== p.index);
    const targets = (g.garbageMode === 'random' && others.length > 1)
      ? [others[Math.floor(Math.random() * others.length)]] : others;
    targets.forEach(q => {
      q.pending += send;
      if (!q.pendingAt || q.pendingAt < now) q.pendingAt = now + PPO_GARBAGE_DELAY;
    });
  }
  let txt = p.name + ' 达成 ' + chain + ' 连锁（消除 ' + totalCleared + ' 颗气泡';
  if (totalGarbage) txt += '、震碎 ' + totalGarbage + ' 颗干扰';
  txt += '，+' + gained + ' 分）';
  if (zenkeshi) txt += '，全消（Zenkeshi）额外 ' + PPO_ZENKESHI_GARBAGE + ' 颗干扰';
  if (simultBonus) txt += '，同时消加成 ' + simultBonus + ' 颗';
  if (offset) txt += '，相杀抵消 ' + offset + ' 颗';
  if (send) txt += '，发出 ' + send + ' 颗干扰';
  ppoNotice(g, txt, chain >= 3 ? 'chain' : 'info');
  ppoCheckAchievements(g, p);
  return chain;
}
// ======================== 魔法气泡 AI（三档：简单/普通/困难） ========================
// 评估函数：模拟在某一列某一朝向落子后的局面（消除数 / 潜在连接 / 三连潜力 / 高度 / 空洞 / 起伏）
function ppoFitsB(b, col, r, orient) {
  const [dr, dc] = PPO_ORIENT[orient];
  const ar = r, ac = col, crr = r + dr, cc = col + dc;
  if (!ppoIn(ar, ac) || !ppoIn(crr, cc)) return false;
  return b[ppoI(ar, ac)] === 0 && b[ppoI(crr, cc)] === 0;
}
function ppoSimDrop(b, col, orient, colors) {
  let r = 1;
  while (ppoFitsB(b, col, r + 1, orient)) r++;
  if (!ppoFitsB(b, col, r, orient)) return null;
  const [dr, dc] = PPO_ORIENT[orient];
  const nb = b.slice();
  nb[ppoI(r, col)] = colors[0];
  nb[ppoI(r + dr, col + dc)] = colors[1];
  return { board: nb, r, cells: [ppoI(r, col), ppoI(r + dr, col + dc)] };
}
function ppoHoles(b) {
  let holes = 0;
  for (let c = 0; c < PPO_COLS; c++) {
    let seenBlock = false;
    for (let r = 0; r < PPO_ROWS; r++) {
      if (b[ppoI(r, c)]) seenBlock = true;
      else if (seenBlock) holes++;
    }
  }
  return holes;
}
function ppoBump(b) {
  let sum = 0;
  const hs = [];
  for (let c = 0; c < PPO_COLS; c++) {
    let h = 0;
    for (let r = 0; r < PPO_ROWS; r++) if (b[ppoI(r, c)]) { h = PPO_ROWS - r; break; }
    hs.push(h);
  }
  for (let i = 1; i < hs.length; i++) sum += Math.abs(hs[i] - hs[i - 1]);
  return sum;
}
function ppoEvalBoard(b, cells) {
  const groups = ppoGroups({ board: b });
  let clears = 0, threePlus = 0;
  groups.forEach(gr => { clears += gr.cells.length; if (gr.cells.length >= 3) threePlus++; });
  let adj = 0;
  cells.forEach(i => {
    const r = Math.floor(i / PPO_COLS), c = i % PPO_COLS, col = b[i];
    for (const [dr, dc] of PPO_DIRS4) {
      const nr = r + dr, nc = c + dc;
      if (ppoIn(nr, nc) && b[ppoI(nr, nc)] === col) adj++;
    }
  });
  return { clears, adj, threePlus, height: ppoHeight({ board: b }), holes: ppoHoles(b), bump: ppoBump(b) };
}
// 在给定棋盘上跑完整连锁，返回连锁数（只算消除，不涉及干扰/分数；AI 评估用）
function ppoSimChain(b) {
  let chain = 0;
  for (;;) {
    const groups = ppoGroups({ board: b });
    if (!groups.length) break;
    chain++;
    const rm = new Set();
    groups.forEach(gr => gr.cells.forEach(i => rm.add(i)));
    rm.forEach(i => { b[i] = 0; });
    ppoGravity({ board: b });
  }
  return chain;
}
// 单次落子的完整评估（含“链”潜力）：返回 { chainLen, ev }
function ppoEvalDrop(board, sim, colors) {
  const b2 = sim.board.slice();
  const chainLen = ppoSimChain(b2);
  const ev = ppoEvalBoard(b2, sim.cells);
  return { chainLen, ev };
}
// 为某个难度挑选落子方案（返回 { col, orient, score }）
function ppoAiPlan(g, p) {
  const colors = p.piece.colors;
  const diff = p.ai || 'normal';
  const cands = [];
  const baseScore = (r, diff) => {
    const { chainLen, ev } = r;
    if (diff === 'easy') return chainLen * 55 + ev.adj * 2 - ev.height * 3 + Math.random() * 90;
    // 真·连消最值钱；低堆时只消 4 颗＝浪费弹药，压低这种走法（鼓励攒连锁）
    const chainReward = chainLen >= 2 ? chainLen * 260 : 0;
    const waste = (chainLen === 1 && ev.height <= 7) ? (8 - ev.height) * 22 : 0;
    return chainReward + ev.threePlus * 45 + ev.adj * 6
      - ev.height * 12 - ev.holes * 34 - ev.bump * 3 - waste
      - (ev.height > 10 ? 260 : 0) + Math.random() * (diff === 'hard' ? 4 : 12);
  };
  for (let col = 0; col < PPO_COLS; col++) {
    for (let orient = 0; orient < 4; orient++) {
      const sim = ppoSimDrop(p.board, col, orient, colors);
      if (!sim) continue;
      cands.push({ col, orient, score: baseScore(ppoEvalDrop(p.board, sim, colors), diff), sim });
    }
  }
  if (!cands.length) return null;
  if (diff === 'hard') {
    // 困难：对最好的几个候选再看一眼“下一对”（1 层前瞻）
    const nx = p.next ? p.next.colors : null;
    if (nx) {
      cands.sort((a, b) => b.score - a.score);
      for (const c of cands.slice(0, 5)) {
        let best2 = -1e9;
        for (let c2 = 0; c2 < PPO_COLS; c2++) for (let o2 = 0; o2 < 4; o2++) {
          const s2 = ppoSimDrop(c.sim.board, c2, o2, nx);
          if (!s2) continue;
          const v = baseScore(ppoEvalDrop(c.sim.board, s2, nx), 'hard');
          if (v > best2) best2 = v;
        }
        if (best2 > -1e8) c.score += best2 * 0.45;
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  if (diff === 'easy' && cands.length > 2) return cands[Math.floor(Math.random() * Math.min(4, cands.length))];
  return cands[0];
}
// AI 每 tick 行动：与人类同速下落（不瞬移）→ 对齐目标后加速下落 → 落地缓冲 → 锁定
function ppoAiTick(g, p, now) {
  if (!p.piece) {                       // 兜底：没有气泡对就补一个
    ppoSpawn(g, p, now);
    p.aiPlan = null; p.aiSoft = false; p.aiStuck = 0; p.aiLast = ''; p.fallAcc = 0; p.lockAcc = 0;
    return !!p.piece;
  }
  const dt = Math.max(0, Math.min(400, now - (p.aiLastTick || now)));
  p.aiLastTick = now;
  // 1) 下落：未对齐用普通速度，对齐后按“加速下落”速度（仍然不是瞬移）
  const stepMs = p.aiSoft ? PPO_AI_SOFT_MS : ppoFallMs(ppoLevel(g, now));
  p.fallAcc = (p.fallAcc || 0) + dt;
  let moved = false;
  while (p.fallAcc >= stepMs) {
    p.fallAcc -= stepMs;
    if (ppoCanFall(p)) { p.piece = Object.assign({}, p.piece, { r: p.piece.r + 1 }); p.lockAcc = 0; moved = true; }
    else break;
  }
  // 2) 落地缓冲（与人类一致 350ms，期间还能微调）
  if (!ppoCanFall(p)) {
    p.lockAcc += dt;
    if (p.lockAcc >= PPO_LOCK_DELAY) {
      p.aiPlan = null; p.aiSoft = false; p.fallAcc = 0; p.lockAcc = 0;
      ppoLock(g, p, now);
      return true;
    }
    if (!moved) return false;
  }
  // 3) 对齐目标列/朝向
  if (!p.aiPlan) {
    p.aiPlan = ppoAiPlan(g, p);
    p.aiMoveAt = now;
    p.aiStuck = 0; p.aiLast = '';
    if (!p.aiPlan) { p.aiSoft = true; return moved; }   // 没有可评估落点：加速直接落下
  }
  if (now < p.aiMoveAt) return moved;
  p.aiMoveAt = now + (p.ai === 'easy' ? 260 : p.ai === 'hard' ? 120 : 190);
  const plan = p.aiPlan;
  const key = p.piece.c + ':' + p.piece.orient;
  if (key === p.aiLast) p.aiStuck++; else { p.aiStuck = 0; p.aiLast = key; }
  if (p.aiStuck > 12) { p.aiSoft = true; return moved; }   // 目标不可达 → 就地加速落下
  const needRot = (plan.orient - p.piece.orient + 4) % 4;
  if (needRot !== 0 && ppoRotate(p, needRot === 3 ? -1 : 1)) return true;
  if (p.piece.c !== plan.col && ppoMove(p, p.piece.c < plan.col ? 1 : -1)) return true;
  if (p.piece.c === plan.col && p.piece.orient === plan.orient) p.aiSoft = true;   // 到位 → 加速下落
  return moved;
}

function ppoCheckAchievements(g, p) {
  if (p.ai) return;   // AI 不计成就
  const c = p.maxChain;
  if (c >= 3) announceAchievement(g, g.roomId, p.name, 'pp_chain3');
  if (c >= 5) announceAchievement(g, g.roomId, p.name, 'pp_chain5');
  if (c >= 7) announceAchievement(g, g.roomId, p.name, 'pp_chain7');
  if (c >= 9) announceAchievement(g, g.roomId, p.name, 'pp_chain9');
  if (p.maxCleared >= 20) announceAchievement(g, g.roomId, p.name, 'pp_gun');
  if (p.board.every(x => x === 0)) announceAchievement(g, g.roomId, p.name, 'pp_empty');
  if (p.heightBeforeChain >= 10 && ppoHeight(p) <= 3) announceAchievement(g, g.roomId, p.name, 'pp_save');
}

function ppoIsOffline(g, p) {
  const room = GAME_ROOMS.puyopuyo;
  const sid = room && room.playerMap.get(p.name);
  const sid2 = puyoAtGame.get(p.name);
  const hb = userLastHeartbeat.get(p.name);
  return !(sid && sid === sid2 && io.sockets.sockets.has(sid) && hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT);
}
function ppoEliminate(g, p, reason, now) {
  if (!p.alive) return;
  p.alive = false; p.piece = null;
  // 名次：当前仍存活的玩家人数 + 1（第一个被淘汰的排最后）
  p.rank = g.players.filter(q => q.alive).length + 1;
  if (!g.elimOrder) g.elimOrder = [];
  g.elimOrder.push(p.index);
  ppoNotice(g, p.name + ' 的棋盘堆满，以第 ' + p.rank + ' 名结束对局', 'out');
  const alive = g.players.filter(q => q.alive);
  if (alive.length <= 1) ppoFinish(g, alive[0] || null, now);
}
function ppoFinish(g, winner, now) {
  if (g.over) return;
  if (winner) winner.rank = 1;
  g.phase = 'over';
  const order = [];
  if (winner) order.push(winner.index);
  (g.elimOrder || []).forEach(i => { if (!order.includes(i)) order.push(i); });
  g.players.forEach(p => { if (!order.includes(p.index)) order.push(p.index); });
  order.forEach((i, k) => { if (i === (winner && winner.index)) return; if (!g.players[i].rank) g.players[i].rank = k + 1; });
  g.ranking = order.slice().sort((a, b) => (g.players[a].rank || 99) - (g.players[b].rank || 99));
  g.over = {
    winner: winner ? winner.name : null,
    ranking: g.ranking.map(i => ({ name: g.players[i].name, rank: g.players[i].rank, score: g.players[i].score, maxChain: g.players[i].maxChain }))
  };
  ppoNotice(g, winner ? (winner.name + ' 存活到最后，获得胜利！') : '对局结束', 'win');
  recordPuyoGame(g);
}
function ppoView(g, name, room) {
  const me = g.players.find(p => p.name === name) || null;
  const info = p => ({
    name: p.name, index: p.index, board: p.board.join(''), alive: p.alive, rank: p.rank,
    score: p.score, pending: p.pending, maxChain: p.maxChain, played: p.played,
    offline: p.ai ? false : ppoIsOffline(g, p), ai: p.ai || null,
    piece: p.piece, next: p.next
  });
  return {
    phase: g.phase, over: g.over || null, you: name, colors: g.colors, garbageMode: g.garbageMode,
    level: ppoLevel(g), notice: g.notice || null,
    lastChain: (g.lastChain && (Date.now() - g.lastChain.ts) < 1600) ? g.lastChain : null,
    ranking: (g.ranking || []).map(i => g.players[i].name),
    me: me ? info(me) : null,
    players: g.players.map(info),
    cancelVotes: (g.cancelVotes || []).slice()
  };
}
function ppoBroadcast(room, g) {
  room.playerMap.forEach((sid, n) => {
    if (sid && io.sockets.sockets.has(sid)) io.to(sid).emit('puyopuyo_state', ppoView(g, n, room));
  });
}
function ppoBroadcastFor(roomId) {
  const room = GAME_ROOMS.puyopuyo;
  const g = puyopuyoGames[roomId];
  if (room && g && g.roomId === roomId) ppoBroadcast(room, g);
}
function ppoCancel(room, g) {
  delete puyopuyoGames[room.roomId];
  io.to(room.roomId).emit('puyopuyo_cancel');
  Object.keys(room.seats).forEach(sid => { if (room.seats[sid]) room.seats[sid].ready = false; });
  broadcastRoom(room);
}
// 玩家输入：left / right / cw / ccw / soft(on) / hard
function ppoInput(g, name, data) {
  if (!g || g.phase !== 'play' || g.over) return { ok: false, msg: '对局已结束' };
  const p = g.players.find(x => x.name === name);
  if (!p) return { ok: false, msg: '你不在本局中' };
  if (!p.alive) return { ok: false, msg: '你已被淘汰' };
  const action = data && data.action;
  if (action === 'soft') { p.soft = !!data.on; return { ok: true }; }
  if (!p.piece) return { ok: false, msg: '等待新气泡' };
  const now = Date.now();
  switch (action) {
    case 'left': ppoMove(p, -1); break;
    case 'right': ppoMove(p, 1); break;
    case 'cw': ppoRotate(p, 1); break;
    case 'ccw': ppoRotate(p, -1); break;
    case 'softStep':                       // 触屏下滑一格
      if (ppoCanFall(p)) p.piece = Object.assign({}, p.piece, { r: p.piece.r + 1 });
      break;
    case 'hard':
      while (ppoCanFall(p)) p.piece = Object.assign({}, p.piece, { r: p.piece.r + 1 });
      ppoLock(g, p, now);
      break;
    default: return { ok: false, msg: '未知操作' };
  }
  ppoBroadcastFor(g.roomId);
  return { ok: true };
}
// 服务端节拍：干扰落地 → 下落/锁定 → 淘汰检查 → 广播
function ppoTick(now) {
  for (const roomId of Object.keys(puyopuyoGames)) {
    const g = puyopuyoGames[roomId];
    if (!g || g.phase !== 'play' || g.over) continue;
    const dt = Math.max(0, Math.min(400, now - (g.lastTick || now)));
    g.lastTick = now;
    let changed = false;
    for (const p of g.players) {
      if (!p.alive) continue;
      if (p.ai) {                       // AI：由 AI 逻辑驱动（不看心跳、不判离线）
        if (ppoAiTick(g, p, now)) changed = true;
        if (g.over) break;
        continue;
      }
      if (ppoIsOffline(g, p)) {
        if (!p.offlineSince) p.offlineSince = now;
        if (now - p.offlineSince > PPO_OFFLINE_ELIM_MS) { ppoEliminate(g, p, 'offline', now); changed = true; }
        continue;
      }
      p.offlineSince = 0;
      if (ppoDropGarbage(p, now)) changed = true;
      if (!p.piece) continue;
      const fallMs = p.soft ? PPO_SOFT_MS : ppoFallMs(ppoLevel(g, now));
      p.fallAcc += dt;
      while (p.fallAcc >= fallMs) {
        p.fallAcc -= fallMs;
        if (ppoCanFall(p)) { p.piece = Object.assign({}, p.piece, { r: p.piece.r + 1 }); p.lockAcc = 0; changed = true; }
        else break;
      }
      if (!ppoCanFall(p)) {
        p.lockAcc += dt;
        if (p.lockAcc >= PPO_LOCK_DELAY) { ppoLock(g, p, now); changed = true; }
      } else p.lockAcc = 0;
      if (g.over) break;
    }
    if (g.over) { g.needReset = true; }        // 交由外层安排房间复位（含 tick 淘汰结束的情况）
    if (changed || now - (g.lastBroadcast || 0) >= 400) {
      g.lastBroadcast = now;
      ppoBroadcastFor(roomId);
    }
  }
}
// 时光墙：记录名次/分数/最高连锁
function recordPuyoGame(g) {
  if (!g || !g.over || g._recorded) return;
  g._recorded = true;
  const officials = g.players.filter(p => isOfficialPlayer(p.name));
  if (!officials.length) return;
  addTimeline({
    ts: Date.now(), type: 'game', game: 'puyopuyo', totalPlayers: g.players.length, mode: g.players.length + '人',
    players: officials.map(p => p.name),
    winner: g.over.winner, reason: '独立棋盘下落对战',
    results: officials.map(p => ({ name: p.name, rank: p.rank || 0, score: p.score, maxChain: p.maxChain }))
  });
}
const drawingAtGame = new Map(); // playerName -> 当前正打开“画猜接龙游戏页”的 socket.id（用于判定谁真正在对局内）
const lobbyViewers = new Map(); // playerName -> 正在大厅页的 socket.id（表情包跨页互发用）
const bomberAtGame = new Map(); // playerName -> 正在炸飞机游戏页的 socket.id（离开/返回与取消判定）
// 通用取"某房间当前进行中的对局"（yahtzee / light / drawing 共用）
function activeGameOf(room) {
  if (!room) return null;
  if (room.gameType === 'drawing') return drawingGames[room.roomId] || null;
  if (room.gameType === 'bomber') return bomberGames[room.roomId] || null;
  if (room.gameType === 'minesweeper') return minesweeperGames[room.roomId] || null;
  if (room.gameType === 'othello') return othelloGames[room.roomId] || null;
  if (room.gameType === 'quoridor') return quoridorGames[room.roomId] || null;
  if (room.gameType === 'gomoku') return gomokuGames[room.roomId] || null;
  if (room.gameType === 'puyopuyo') return puyopuyoGames[room.roomId] || null;
  return yahtzeeGames[room.roomId] || null;
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
  const game = { gameType: 'drawing', roomId, order: names.slice(), playerOrder: names.slice(), round: 1, chains, points: {}, done: {}, stage: 'writeDraw', reviewIdx: 0, voted: [], chainVotes: [], cancelVotes: [], settled: [], mvpVotes: {}, culpritVotes: {} };
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
  // 全链结算完成进入 result：按一局最终积分触发花菜成就 + 写时光墙/花菜榜
  if (g.stage === 'result') {
    for (const n of g.order) {
      const p = g.points[n] || 0;
      if (p >= 18) announceAchievement(g, room.roomId, n, 'dg_cabbage_grand');
      if (p <= -18) announceAchievement(g, room.roomId, n, 'dg_cabbage_killer');
    }
    recordDrawingGame(g);
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
function dgApplyReward(g, room) {
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
    if (chain.match === true) {
      g.mvpVotes[target] = (g.mvpVotes[target] || 0) + n;
      // 成就：同一链条 3 票投同一人 → MVP
      if (n >= 3) announceAchievement(g, room.roomId, target, 'dg_fmvp');
    } else {
      g.culpritVotes[target] = (g.culpritVotes[target] || 0) + n;
      // 成就：同一链条 3 票投同一人 → 罪魁
      if (n >= 3) announceAchievement(g, room.roomId, target, 'dg_spirit');
    }
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
      const byPlayer = g.achievementsByPlayer || {};
      const achSummary = {};
      for (const p of g.order) {
        const ids = byPlayer[p] || [];
        if (!ids.length) continue;
        achSummary[p] = ids.map(id => ({ id, name: (ACHIEVEMENTS[id] && ACHIEVEMENTS[id].name) || id, quality: (ACHIEVEMENTS[id] && ACHIEVEMENTS[id].quality) || 'common' }));
      }
      view.achSummary = achSummary;
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
    roomId: room.roomId, hostName: room.hostName, maxPlayers: room.maxPlayers, skipOffline: !!room.skipOffline, msTeam: !!room.msTeam, continueRanking: !!room.continueRanking,
    puyoColors: room.puyoColors === 5 ? 5 : 4, puyoGarbage: room.puyoGarbage === 'random' ? 'random' : 'all',
    puyoAI: Math.max(0, Math.min(3, Number(room.puyoAI) || 0)), puyoAIDifficulty: ['easy', 'normal', 'hard'].includes(room.puyoAIDifficulty) ? room.puyoAIDifficulty : 'normal',
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
    skipOffline: !!room.skipOffline, msTeam: !!room.msTeam,
    seats: room.seats,
    spectators: room.spectators,
    gameStarted,
    gamePlayers,
    continueRanking: !!room.continueRanking,
    puyoColors: room.puyoColors === 5 ? 5 : 4,
    puyoGarbage: room.puyoGarbage === 'random' ? 'random' : 'all',
    puyoAI: Math.max(0, Math.min(3, Number(room.puyoAI) || 0)),
    puyoAIDifficulty: ['easy', 'normal', 'hard'].includes(room.puyoAIDifficulty) ? room.puyoAIDifficulty : 'normal'
  });
  room.playerMap.forEach((_, uname) => {
    const mySeat = Object.entries(room.seats).find(([k, v]) => v?.name === uname)?.[0] || null;
    const sid = room.playerMap.get(uname);
    if (sid && io.sockets.sockets.has(sid)) {
      io.to(sid).emit('room_update', {
        roomId: room.roomId,
        hostName: room.hostName,
        maxPlayers: room.maxPlayers,
        skipOffline: !!room.skipOffline, msTeam: !!room.msTeam,
        seats: room.seats,
        spectators: room.spectators,
        mySeat,
        myReady: mySeat ? room.seats[mySeat].ready : false,
        gameStarted,
        gamePlayers,
        continueRanking: !!room.continueRanking,
        puyoColors: room.puyoColors === 5 ? 5 : 4,
        puyoGarbage: room.puyoGarbage === 'random' ? 'random' : 'all',
        puyoAI: Math.max(0, Math.min(3, Number(room.puyoAI) || 0)),
        puyoAIDifficulty: ['easy', 'normal', 'hard'].includes(room.puyoAIDifficulty) ? room.puyoAIDifficulty : 'normal'
      });
    }
  });
}

// ========== 房间重置：当房间里所有玩家（含观战）都离线后，把房间彻底还原成可重新开局的状态 ==========
function resetRoom(room) {
  if (room.playerMap.size > 0) return; // 还有人则不动
  room.maxPlayers = room.gameType === 'othello' ? 2 : 4;
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
  if (bomberGames[room.roomId]) {
    delete bomberGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的炸飞机已清除`);
  }
  if (minesweeperGames[room.roomId]) {
    const mg = minesweeperGames[room.roomId];
    if (mg.roundTimer) clearTimeout(mg.roundTimer);
    delete minesweeperGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的扫雷已清除`);
  }
  if (othelloGames[room.roomId]) {
    delete othelloGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的翻转棋已清除`);
  }
  if (quoridorGames[room.roomId]) {
    delete quoridorGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的路墙棋已清除`);
  }
  if (gomokuGames[room.roomId]) {
    delete gomokuGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的技能五子棋已清除`);
  }
  if (puyopuyoGames[room.roomId]) {
    delete puyopuyoGames[room.roomId];
    console.log(`🔄 房间 ${room.roomId} 的魔法气泡已清除`);
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
  // 炸飞机：对局进行中同样“离线只标记不除名”，座位/对局保留，可重进继续
  if (room.gameType === 'bomber' && bomberGames[room.roomId]) {
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
  // 扫雷 / 翻转棋 / 路墙棋：同熟人局规则——离线不除名、原地等待，可重连继续
  if ((room.gameType === 'minesweeper' && minesweeperGames[room.roomId]) || (room.gameType === 'othello' && othelloGames[room.roomId]) || (room.gameType === 'quoridor' && quoridorGames[room.roomId]) || (room.gameType === 'gomoku' && gomokuGames[room.roomId]) || (room.gameType === 'puyopuyo' && puyopuyoGames[room.roomId])) {
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
    persistLastOffline(name);
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
    // 魔法气泡仍在测试阶段：房间入口只对测试账号开放（正式玩家/游客一律挡在门外）
    if (game === 'puyopuyo' && !isTestAccount(playerName)) {
      if (typeof cb === 'function') cb({ success: false, msg: '魔法气泡还在测试中，暂时只对测试账号开放～' });
      return;
    }
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
    } else if (gameData && room.gameType === 'yahtzee') {
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
    // bomber：状态由 bomber_state/bomber_pull 单独推送（不走快艇格式）
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
    // 已在座则不再重复占座（避免同一人出现两个座位，导致人数/准备校验错乱）
    if (Object.values(room.seats).some(s => s && s.name === name)) return;
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

  socket.on('change_settings', ({ maxPlayers, skipOffline, msTeam, continueRanking, puyoColors, puyoGarbage, puyoAI, puyoAIDifficulty }, cb) => {
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
    if (room.gameType === 'drawing' && maxPlayers != null) {
      // 画猜接龙固定四人，不支持改人数
      if (cb) cb({ success: false, msg: '画猜接龙固定 4 人' });
      return;
    }
    if (room.gameType === 'othello' && maxPlayers != null) {
      // 翻转棋固定双人
      if (cb) cb({ success: false, msg: '翻转棋固定 2 人' });
      return;
    }
    if (activeGameOf(room)) return;

    // 离线是否自动跳过：默认 false（不跳），仅在房间设置勾选后生效
    if (typeof skipOffline === 'boolean') room.skipOffline = skipOffline;
    // 扫雷赛制：个人赛/2v2
    if (typeof msTeam === 'boolean') room.msTeam = msTeam;
    // 技能五子棋：是否继续决出排名
    if (typeof continueRanking === 'boolean') room.continueRanking = continueRanking;
    // 魔法气泡：气泡颜色数（4/5）与干扰发送模式（所有人/随机一人）
    if (puyoColors === 4 || puyoColors === 5) room.puyoColors = puyoColors;
    if (puyoGarbage === 'all' || puyoGarbage === 'random') room.puyoGarbage = puyoGarbage;
    // 魔法气泡：单机练手 AI（数量 0~3 与难度）
    if (puyoAI != null) room.puyoAI = Math.max(0, Math.min(3, Number(puyoAI) || 0));
    if (['easy', 'normal', 'hard'].includes(puyoAIDifficulty)) room.puyoAIDifficulty = puyoAIDifficulty;

    if (maxPlayers != null) {
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
    }
    broadcastRoom(room);
    if (cb) cb({ success: true, maxPlayers: room.maxPlayers, skipOffline: !!room.skipOffline });
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
        : (room.gameType === 'bomber' || room.gameType === 'minesweeper' || room.gameType === 'othello' || room.gameType === 'quoridor' || room.gameType === 'gomoku' || room.gameType === 'puyopuyo')
          ? game.phase === 'over'
          : game.phase === 'finished';
      if (!finished) { cleared = false; break; } // 进行中：仅退出页面，对局保留
      if (gameEndTimers[room.roomId]) {
        clearTimeout(gameEndTimers[room.roomId]);
        delete gameEndTimers[room.roomId];
      }
      delete yahtzeeGames[room.roomId];
      delete drawingGames[room.roomId];
      delete bomberGames[room.roomId];
      if (minesweeperGames[room.roomId]) {
        if (minesweeperGames[room.roomId].roundTimer) clearTimeout(minesweeperGames[room.roomId].roundTimer);
        delete minesweeperGames[room.roomId];
      }
      delete othelloGames[room.roomId];
      delete quoridorGames[room.roomId];
      delete gomokuGames[room.roomId];
      delete puyopuyoGames[room.roomId];
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
        meta: ACHIEVEMENTS,
        flagTotals: Object.fromEntries(msFlagTotals)
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
    const already = ACHIEVEMENTS[achievementId].group === 'ms_flag' && achTestRecords.some(r => r.playerName === name && r.achievementId === achievementId);
    if (!already) {
      const need = MS_FLAG_NEED[achievementId];
      if (need) msFlagTotals.set(name, Math.max(msFlagTotals.get(name) || 0, need)); // 演示：直接触发旗手档 = 认为累计已到该档
      recordAchievement(name, achievementId); // 测试者：内存记录，重启即刷新
    }
    if (cb) cb({ success: true, name, achievementId, achievementName: ACHIEVEMENTS[achievementId].name, already });
  });

  // 测试助手：一键给若干测试账号批量触发一组成就（画猜场景预览用）
  socket.on('test_trigger_achievements', ({ ids = [], targets } = {}, cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    const list = (Array.isArray(targets) && targets.length ? targets : [me]).filter(n => TEST_NAMES.includes(n));
    const validIds = ids.filter(id => ACHIEVEMENTS[id]);
    const rows = [];
    list.forEach(n => validIds.forEach(id => {
      // 旗手是可升级成就：每个等级每人最多记录一次，重复点不再累计次数
      if ((ACHIEVEMENTS[id].group === 'ms_flag') && achTestRecords.some(r => r.playerName === n && r.achievementId === id)) return;
      const need = MS_FLAG_NEED[id];
      if (need) msFlagTotals.set(n, Math.max(msFlagTotals.get(n) || 0, need)); // 演示：累计雷数随档位同步，荣誉墙可直接看排版
      recordAchievement(n, id);
      rows.push(`${n} → ${ACHIEVEMENTS[id].name}`);
    }));
    if (cb) cb({ success: true, count: rows.length, rows });
  });

  // 测试助手：宠物演示（成长 +200 / 今日签到 / 一条串门日志，测试账号专属内存态）
  socket.on('test_pet_demo', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    const other = TEST_NAMES.find(n => n !== me);
    const key = syncPairKey(me, other);
    petEnsure(key);
    petGain(key, 200);
    petSign(key, me);
    const p = petEnsure(key);
    p.gold = (p.gold || 0) + 50;
    p.lastActivity = 0; // 触发一次“行动日志”
    const snap = petSnapshot(key, me);
    if (cb) cb({ success: true, msg: '宠物已演示成长（level=' + snap.level + '，金币 ' + snap.gold + '），可在默契空间对应组合查看', level: snap.level, exp: snap.exp, gold: snap.gold });
  });

  // 测试助手：模拟“游客达成稀有成就 → 游客留言板系统推送”
  socket.on('test_guest_ach_board', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    pushBoard('guest', {
      name: '系统',
      text: `🏆 游客「游客9527」在画猜接龙解锁稀有成就「花菜大满贯」！`,
      ts: Date.now()
    });
    if (cb) cb({ success: true, msg: '已推送到游客留言板（去留言板 → 游客留言查看）' });
  });

  // 测试助手：重置当前测试账号的成就与模拟个人空间（内存，重启也会清空）
  socket.on('test_reset_achievements', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    achTestRecords = [];
    testProfileSeeds.clear();
    if (cb) cb({ success: true, msg: '测试成就 / 模拟战绩已重置' });
  });

  // 测试助手：查看四名测试号各自“已正确标记雷数”与旗手各档解锁情况（每档每人最多一次）
  socket.on('dev_ms_flag_info', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（测试者1~测试者4）可使用' });
      return;
    }
    const defs = [
      { id: 'ms_flag_c', need: 10 },
      { id: 'ms_flag_b', need: 100 },
      { id: 'ms_flag_a', need: 500 },
      { id: 'ms_flag_s1', need: 1000 }
    ];
    const rows = TEST_NAMES.map(t => ({
      name: t,
      total: msFlagTotals.get(t) || 0,
      levels: defs.map(d => ({
        id: d.id, name: ACHIEVEMENTS[d.id].name, quality: ACHIEVEMENTS[d.id].quality, need: d.need,
        unlocked: achTestRecords.some(r => r.playerName === t && r.achievementId === d.id)
      }))
    }));
    if (cb) cb({ success: true, rows });
  });

  // 测试助手：扫雷生态一键预览（成绩榜个人/组队 + 流水 + 时光墙 + 当前账号个人战绩；可清除重造）
  socket.on('dev_seed_ms_preview', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（测试者1~测试者4）可使用' });
      return;
    }
    msProfileRemoveMine(me);
    const r = seedMsBoardsInto(me);
    msProfileMergeMine(me, r.profileModes);
    if (cb) cb({ success: true, solo: r.solo, team: r.team,
      msg: `扫雷生态预览已生成（${r.solo} 场个人赛 + ${r.team} 场 2v2）：扫雷·个人/组队榜、分数流水、时光墙、个人战绩（2人/3人/4人/2v2）都可以看了` });
  });
  socket.on('dev_reset_ms_preview', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（测试者1~测试者4）可使用' });
      return;
    }
    msPreviewClean();
    msProfileRemoveMine(me);
    if (cb) cb({ success: true, msg: '扫雷生态预览已清除（榜单流水/时光墙/个人战绩），正式真实数据不受影响' });
  });

  // 测试助手：翻转棋生态一键预览（榜单+流水+时光墙+当前账号个人战绩；可清除重造）
  socket.on('dev_seed_othello_preview', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（测试者1~测试者4）可使用' });
      return;
    }
    othProfileRemoveMine(me);
    const r = seedOthPreviewInto(me);
    othProfileMergeMine(me, r.modes);
    if (cb) cb({ success: true, msg: '翻转棋生态预览已生成（4 局，含 1 局平局）：翻转棋榜、流水、时光墙、个人战绩都可以看了' });
  });
  socket.on('dev_reset_othello_preview', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（测试者1~测试者4）可使用' });
      return;
    }
    othPreviewClean();
    othProfileRemoveMine(me);
    if (cb) cb({ success: true, msg: '翻转棋生态预览已清除（榜单流水/时光墙/个人战绩），正式真实数据不受影响' });
  });

  // 测试助手：技能五子棋生态一键预览（4 局时光墙 + 当前账号个人空间模拟数据；可清除重造）
  socket.on('dev_seed_gomoku_preview', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（测试者1~测试者4）可使用' });
      return;
    }
    const peers = TEST_NAMES.filter(n => n !== me);
    const roles = GMK_ROLES.slice();
    const now = Date.now();
    const mineModes = {};
    // 4 局：2 人×2（含 1 局开启决出排名）、3 人×1、4 人×1（4 人局开启决出排名）
    const plans = [
      { names: [me, peers[0]], rankMode: false },
      { names: [me, peers[0]], rankMode: true },
      { names: [me, peers[0], peers[1]], rankMode: false },
      { names: [me, peers[0], peers[1], peers[2]], rankMode: true }
    ];
    plans.forEach((pl, i) => {
      const all = pl.names.slice();
      const n = all.length;
      const myRank = (i % 3) + 1;
      const others = all.slice(1).map((nm, k) => ({ name: nm, rank: (myRank === 1 ? 2 + k : (k === 0 ? 1 : 2 + k)) }));
      const results = [{ name: me, rank: myRank, fives: Math.max(1, 3 - (myRank - 1)) }].concat(others.map((o, k) => ({ name: o.name, rank: o.rank, fives: 1 + (k % 2) })))
        .map(r => Object.assign(r, { score: pl.rankMode ? (n - r.rank + 1) : 0 }));
      addTimeline({
        ts: now - (plans.length - i) * 3600000, type: 'game', game: 'gomoku', totalPlayers: n, mode: n + '人', rankMode: pl.rankMode,
        players: all, winner: results.find(r => r.rank === 1).name, reason: i % 2 ? '双重五连' : '3次五连',
        roles: all.map((nm, k) => ({ name: nm, role: roles[(i * 3 + k) % roles.length] || roles[k], rank: results.find(r => r.name === nm).rank })),
        results, _test: true, _gmkPreview: true
      });
      // 当前账号在该人数下的模拟战绩
      const mk = n + '人';
      const myRes = results.find(r => r.name === me);
      const m = mineModes[mk] || (mineModes[mk] = { mode: mk, games: 0, wins: 0, totalScore: 0, best: 0, rankModeGames: 0 });
      m.games++;
      if (myRes.rank === 1) m.wins++;
      m.totalScore += myRes.score;
      if (myRes.score > m.best) m.best = myRes.score;
      if (pl.rankMode) m.rankModeGames++;
    });
    const modes = Object.keys(mineModes).sort().map(k => {
      const m = mineModes[k];
      return { mode: m.mode, games: m.games, wins: m.wins, winRate: m.games ? Math.round(m.wins / m.games * 100) : 0, totalScore: m.totalScore, best: m.best, rankModeGames: m.rankModeGames };
    });
    gmkProfileMergeMine(me, modes);
    if (cb) cb({ success: true, msg: '技能五子棋预览已生成（4 局：2/3/4 人，含 2 局决出排名）：个人空间角色/人数统计、时光墙明细都可以看了' });
  });
  socket.on('dev_reset_gomoku_preview', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（测试者1~测试者4）可使用' });
      return;
    }
    for (let i = timelineEntries.length - 1; i >= 0; i--) if (timelineEntries[i]._gmkPreview) timelineEntries.splice(i, 1);
    if (PERSIST_TIMELINE) {
      try { fs.writeFileSync(TIMELINE_FILE, JSON.stringify(timelineEntries, null, 2)); } catch (e) { console.error('❌ 时光墙写入失败：', e.message); }
    }
    gmkProfileRemoveMine(me);
    if (cb) cb({ success: true, msg: '技能五子棋预览已清除（时光墙与个人空间模拟数据），正式真实数据不受影响' });
  });

  // 测试助手：生成几条测试时光墙记录（标记 _test，可一键重置；开发期不落盘）
  socket.on('test_seed_timeline', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    const now = Date.now();
    const peers = TEST_NAMES.filter(n => n !== me).slice(0, 3);
    const all = [me].concat(peers);
    const seeds = [
      { ts: now - 61000, type: 'achievement', player: me, achievementId: 'dg_fmvp', achievementName: 'FMVP', quality: 'common', _test: true },
      {
        ts: now - 45000, type: 'game', game: 'drawing', totalPlayers: 4, players: all.slice(0, 2), _test: true,
        results: [
          { name: me, score: 12, rank: 1, mvpVotes: 6, culpritVotes: 1 },
          { name: peers[0], score: 6, rank: 2, mvpVotes: 2, culpritVotes: 0 },
          { name: peers[1], score: -3, rank: 3, mvpVotes: 0, culpritVotes: 5 },
          { name: peers[2], score: -15, rank: 4, mvpVotes: 0, culpritVotes: 2 }
        ]
      },
      {
        ts: now - 12000, type: 'game', game: 'yahtzee', totalPlayers: 2, players: all.slice(0, 2), _test: true,
        results: [
          { name: peers[0], score: 262, rank: 1 },
          { name: me, score: 238, rank: 2 }
        ]
      },
      {
        ts: now - 8000, type: 'game', game: 'bomber', totalPlayers: 4, players: all, _test: true,
        results: [
          { name: me, score: 6, rank: 1, heads: 6 },
          { name: peers[0], score: 3, rank: 2, heads: 3 },
          { name: peers[1], score: 1, rank: 3, heads: 1 },
          { name: peers[2], score: 0, rank: 4, heads: 0 }
        ]
      },
      { ts: now - 5000, type: 'achievement', player: me, achievementId: 'bomber_edge', achievementName: '描边大师', quality: 'common', _test: true }
    ];
    seeds.forEach(e => addTimeline(e));
    if (cb) cb({ success: true, count: seeds.length, msg: '已生成 3 条对局 + 2 条成就的测试时光墙（含炸飞机）' });
  });

  // 测试助手：清掉测试生成的时光墙记录（保留正式记录）
  socket.on('test_reset_timeline', (cb) => {
    const me = socketToUser.get(socket.id);
    if (!me || !TEST_NAMES.includes(me)) {
      if (cb) cb({ success: false, msg: '仅测试账号（test1~test4）可使用' });
      return;
    }
    timelineEntries = timelineEntries.filter(e => !e._test);
    if (cb) cb({ success: true, msg: '测试时光墙记录已清除' });
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
    pushBoard(type, msg);
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
      theme: resolveUserTheme(name),
      title: playerTitle(name),
      unlockedTitles: playerUnlockedTitles(name),
      titleChoice: (u.title || ''),
      emojiIds: (u.emoji || []).slice(),
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
        group: (meta.group || r.achievementId), baseName: (meta.base || meta.name),
        count: r.count, firstTime: r.firstTime, lastTime: r.lastTime
      };
    }).sort((a, b) => (ACH_QUALITY_NO[b.quality] || 0) - (ACH_QUALITY_NO[a.quality] || 0));
    let stats, drawingCareer;
    if (isTestAccount(target)) {
      const seed = testProfileSeeds.get(target);
      stats = seed ? { totals: seed.totals, byGame: seed.byGame } : { totals: { games: 0, wins: 0, winRate: 0, totalScore: 0, best: 0 }, byGame: [] };
      drawingCareer = seed ? seed.drawingCareer : { games: 0, wins: 0, winRate: 0, totalScore: 0, best: 0, mvp: 0, culprit: 0 };
    } else {
      stats = { totals: summarizeProfileStats(target), byGame: buildProfileByGame(target) };
      drawingCareer = buildDrawingCareer(target);
    }
    const online = onlineUsers.has(target);
    const onlineRec = onlineUsers.get(target);
    cb({
      success: true,
      name: target,
      displayName: getDisplayName(target),
      title: playerTitle(target),
      theme: resolveUserTheme(target),
      online,
      lastSeen: online ? (onlineRec && onlineRec.lastSeen) : (userLastOnline.get(target) || null),
      stats,
      drawingCareer,
      gomokuRoles: buildGomokuRoles(target),
      puyoStats: buildPuyoStats(target),
      achievements,
      totalAch: totalAchCount()
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
    // 花菜榜（画猜接龙）：单局最高分
    const drawingArr = [];
    for (const [name, best] of drawingHighBoard) {
      drawingArr.push({
        name,
        displayName: OFFICIAL_ACCOUNT_NAMES.includes(name) ? getDisplayName(name) : name,
        title: playerTitle(name),
        best
      });
    }
    drawingArr.sort((a, b) => b.best - a.best || (a.name < b.name ? -1 : 1));
    // 成就榜：仍只统计正式玩家
    const achRow = new Map();
    for (const r of achRecords) {
      if (!OFFICIAL_ACCOUNT_NAMES.includes(r.playerName)) continue;
      const row = achRow.get(r.playerName) || { count: 0, groups: new Set() };
      const g = achGroupOf(r.achievementId);
      if (!row.groups.has(g)) { row.groups.add(g); row.count++; }
      achRow.set(r.playerName, row);
    }
    const achArr = OFFICIAL_ACCOUNT_NAMES
      .map(n => ({ name: n, displayName: getDisplayName(n), title: playerTitle(n), count: (achRow.get(n) || { count: 0 }).count }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
    // 烟火师榜（炸飞机）：单局最高炸毁机头数，平分按名字
    const bomberArr = [];
    for (const [name, best] of bomberSparkBoard) {
      bomberArr.push({
        name,
        displayName: OFFICIAL_ACCOUNT_NAMES.includes(name) ? getDisplayName(name) : name,
        title: playerTitle(name),
        best
      });
    }
    bomberArr.sort((a, b) => b.best - a.best || (a.name < b.name ? -1 : 1));
    // 扫雷个人榜（最佳=每人最好；分数流水=前20可重复）
    const msBestArr = [...msBestBoard.entries()].map(([name, best]) => {
      const info = msBestInfo.get(name) || {};
      return {
        name, displayName: getDisplayName(name), best,
        mode: info.mode || 'solo', partner: info.partner || null,
        displayPartner: info.partner ? getDisplayName(info.partner) : null
      };
    })
      .sort((a, b) => b.best - a.best || (a.name < b.name ? -1 : 1));
    const msHistArr = msHistory.slice().sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, 20)
      .map(r => Object.assign({}, r, { displayName: getDisplayName(r.name), displayPartner: r.partner ? getDisplayName(r.partner) : null }));
    // 扫雷组队榜
    const msTeamBestArr = [...msTeamBest.entries()].map(([key, total]) => {
      const players = key.split('\u0001');
      return { players, displayPlayers: players.map(getDisplayName), total };
    }).sort((a, b) => b.total - a.total);
    const msTeamHistArr = msTeamHistory.slice().sort((a, b) => b.total - a.total || a.ts - b.ts).slice(0, 20)
      .map(r => Object.assign({}, r, { displayPlayers: (r.players || []).map(getDisplayName) }));
    const highHistArr = highHist.slice().sort((a, b) => b.total - a.total || a.ts - b.ts).slice(0, 20).map(r => Object.assign({}, r, { displayName: getDisplayName(r.name) }));
    const drawingHistArr = drawingHist.slice().sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, 20).map(r => Object.assign({}, r, { displayName: getDisplayName(r.name) }));
    const bomberHistArr = bomberHist.slice().sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, 20).map(r => Object.assign({}, r, { displayName: getDisplayName(r.name) }));
    // 翻转棋榜：单局最高终局棋子数 + 流水
    const othBestArr = [...othBestBoard.entries()].map(([name, best]) => ({ name, displayName: getDisplayName(name), best }))
      .sort((a, b) => b.best - a.best || (a.name < b.name ? -1 : 1));
    const othHistArr = othHistory.slice().sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, 20)
      .map(r => Object.assign({}, r, { displayName: getDisplayName(r.name) }));
    if (cb) cb({ success: true, game: '快艇骰子', board: gamesArr, achBoard: achArr, drawingBoard: drawingArr, bomberBoard: bomberArr,
      highHistBoard: highHistArr, drawingHistBoard: drawingHistArr, bomberHistBoard: bomberHistArr,
      othBestBoard: othBestArr, othHistBoard: othHistArr,
      msBestBoard: msBestArr, msHistBoard: msHistArr, msTeamBestBoard: msTeamBestArr, msTeamHistBoard: msTeamHistArr });
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
    const needPlayers = room.gameType === 'drawing' ? 4
      : (room.gameType === 'puyopuyo' ? 1 : 2);  // 魔法气泡：1 人也能开局（不足时自动补齐 AI 陪练）
    if (players.length < needPlayers || !players.every(p => p.ready)) return;
    if (room.gameType === 'minesweeper' && room.msTeam && players.length < 4) return; // 2v2 固定 4 人
    if (room.gameType === 'othello' && players.length !== 2) return; // 翻转棋固定 2 人
    if (room.gameType === 'yahtzee') {
      const playerNames = players.map(p => p.name);
      initYahtzeeGame(room.roomId, playerNames);
    } else if (room.gameType === 'drawing') {
      const playerNames = players.map(p => p.name);
      dgInit(room.roomId, playerNames);
    } else if (room.gameType === 'bomber') {
      const playerNames = players.map(p => p.name);
      bomberGames[room.roomId] = bmbMakeGame(room, playerNames);
    } else if (room.gameType === 'minesweeper') {
      const playerNames = players.map(p => p.name);
      minesweeperGames[room.roomId] = msInit(room, playerNames, room.msTeam === true);
    } else if (room.gameType === 'othello') {
      const playerNames = players.map(p => p.name);
      othelloGames[room.roomId] = othInit(room, playerNames);
    } else if (room.gameType === 'quoridor') {
      const playerNames = players.map(p => p.name);
      quoridorGames[room.roomId] = quoInit(room, playerNames);
    } else if (room.gameType === 'gomoku') {
      const playerNames = players.map(p => p.name);
      gomokuGames[room.roomId] = gmkInit(room, playerNames, room.continueRanking === true);
    } else if (room.gameType === 'puyopuyo') {
      const playerNames = players.map(p => p.name);
      const aiCount0 = Math.max(0, Math.min(3, Number(room.puyoAI) || 0));
      // 单人（或人数不足 2）时自动补齐 AI，保证一定能开：至少 1 个 AI、总人数不少于 2
      const aiCount = (playerNames.length < 2) ? Math.max(1, aiCount0) : aiCount0;
      const aiDiff = ['easy', 'normal', 'hard'].includes(room.puyoAIDifficulty) ? room.puyoAIDifficulty : 'normal';
      const label = { easy: '简单', normal: '普通', hard: '困难' }[aiDiff];
      const ai = Array.from({ length: aiCount }, (_, k) => ({ name: 'AI·' + label + (aiCount > 1 ? ('·' + (k + 1)) : ''), difficulty: aiDiff }));
      puyopuyoGames[room.roomId] = ppoInit(room, playerNames, {
        colors: room.puyoColors === 5 ? 5 : 4,
        garbageMode: room.puyoGarbage === 'random' ? 'random' : 'all',
        ai
      });
    }
    broadcastRoom(room);
    if (room.gameType === 'drawing') {
      dgBroadcast(room);
    } else if (room.gameType === 'bomber') {
      bmbBroadcast(room, bomberGames[room.roomId]);
    } else if (room.gameType === 'minesweeper') {
      bmsBroadcast(room, minesweeperGames[room.roomId]);
    } else if (room.gameType === 'othello') {
      othBroadcast(room, othelloGames[room.roomId]);
    } else if (room.gameType === 'quoridor') {
      quoBroadcast(room, quoridorGames[room.roomId]);
    } else if (room.gameType === 'gomoku') {
      gmkBroadcast(room, gomokuGames[room.roomId]);
    } else if (room.gameType === 'puyopuyo') {
      ppoBroadcast(room, puyopuyoGames[room.roomId]);
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
    if (needPre === 'reward') dgApplyReward(g, room);
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
      return { a, b, key, score: p.score, titles: p.titles, alias: p.alias || '', aliasHistory: (p.aliasHistory || []).slice(), pendingName: (p.pending && p.pending.name) || '', pendingBy: (p.pending && p.pending.by) || '' };
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
      if (cb) cb({ success: true, role: 'viewer', key, score: p.score, titles: p.titles, alias: p.alias || '', aliasHistory: (p.aliasHistory || []).slice(), pendingName: (p.pending && p.pending.name) || '', pendingBy: (p.pending && p.pending.by) || '' });
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
    if (cb) cb({ success: true, role: 'member', members: [...sess.members], phase: sess.phase, game: sess.game, score: syncGetPair(key).score, titles: syncGetPair(key).titles, alias: syncGetPair(key).alias || '', aliasHistory: (syncGetPair(key).aliasHistory || []).slice(), pendingName: (syncGetPair(key).pending && syncGetPair(key).pending.name) || '', pendingBy: (syncGetPair(key).pending && syncGetPair(key).pending.by) || '' });
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
      if (p.alias && p.alias !== p.pending.name) {
        const h = p.aliasHistory || (p.aliasHistory = []);
        h.push({ name: p.alias, ts: Date.now() });
        if (h.length > 20) h.shift();
      }
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
      if (cb) cb({ success: true, started: false, readyGame: sess.readyGame || null, readyVotes: (sess.readyVotes || []).slice() });
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
    if (cb) cb({ success: true, started: false, readyGame: sess.readyGame || null, readyVotes: (sess.readyVotes || []).slice() });
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
      // 答对：结束画面会带全部尝试，画者同样能看到
      paintSendTo(sess, pt.painter, 'paint_attempt_ok', { t: g });
      finishPaintRound(key, true);
      if (cb) cb({ success: true, correct: true });
    } else {
      paintSendTo(sess, name, 'paint_guess_miss', { n: pt.attempts.length });
      // 实时让画者看到猜者提交的尝试词
      paintSendTo(sess, pt.painter, 'paint_attempt', { t: g, n: pt.attempts.length });
      if (cb) cb({ success: true, correct: false });
    }
  });

  // 猜者输入过程实时同步给画者（画者也能看到对面在猜什么）
  socket.on('paint_typing', ({ pair, text }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || sess.game !== 'paint' || !sess.paint || sess.paint.guesser !== name || sess.paint.stage !== 'draw') return;
    const clean = String(text || '').slice(0, 12);
    paintSendTo(sess, sess.paint.painter, 'paint_typing', { text: clean });
    if (cb) cb({ success: true });
  });

  // 结束画面 → 需要双方都点“下一轮”才开始（有一方先点就等待并同步状态）
  socket.on('paint_next', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    const sess = syncSessions.get(key);
    if (!sess || !sess.members.has(name) || sess.game !== 'paint' || !sess.paint || sess.paint.stage !== 'end') {
      if (cb) cb({ success: false });
      return;
    }
    const pt = sess.paint;
    pt.nextVotes = pt.nextVotes || {};
    if (!pt.nextVotes[name]) pt.nextVotes[name] = true;
    const ready = Object.keys(pt.nextVotes);
    const [a, b] = sess.players;
    const both = ready.includes(a) && ready.includes(b);
    paintSendTo(sess, a, 'paint_next_state', { ready, both });
    paintSendTo(sess, b, 'paint_next_state', { ready, both });
    if (both) {
      pt.nextVotes = {};
      startPaintRound(key);
    }
    if (cb) cb({ success: true });
  });

  // 中止你画我猜（回到小游戏菜单；另一方收到“对方已取消”）
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
      io.to('sync:' + key).emit('sync_result', {
        qi: sess.qi,
        match,
        total: sess.roundQs.length,
        gainSoFar: sess.gains,
        players: [pa, pb],
        choices: { [pa]: sess.answers[pa], [pb]: sess.answers[pb] } // 双方各自的选择，用于“看到对面作答”
      });
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

  // ===== 默契宠物 v2：查看 / 双人签到 / 买外观 =====
  socket.on('sync_pet_get', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    if (!name || !aliasMemberGuard(name, key)) { if (cb) cb({ success: false, msg: '仅组合成员可查看宠物' }); return; }
    const snap = petSnapshot(key, name);
    if (cb) cb({ success: true, ...snap });
  });
  socket.on('sync_pet_sign', ({ pair }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    if (!name || !aliasMemberGuard(name, key)) { if (cb) cb({ success: false, msg: '仅组合成员可签到' }); return; }
    const r = petSign(key, name);
    const snap = petSnapshot(key, name);
    if (cb) cb({ success: true, added: r.added, done: r.done, ...snap });
  });
  socket.on('sync_pet_buy', ({ pair, color }, cb) => {
    const name = socketToUser.get(socket.id);
    const key = String(pair || '');
    if (!name || !aliasMemberGuard(name, key)) { if (cb) cb({ success: false, msg: '仅组合成员可购买' }); return; }
    const r = petBuy(key, color);
    const snap = petSnapshot(key, name);
    if (cb) cb({ success: !!r.ok, msg: r.msg || '已换好新颜色', ...snap });
  });

  // ===== 大厅在场（表情包可在主页互相看见/发送） =====
  socket.on('lobby_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    lobbyViewers.set(name, socket.id);
  });

  // ===== 表情包：取可装配清单 / 保存装配 / 游戏内发送 =====
  socket.on('get_emoji', (cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || (name.startsWith('游客') && !GUEST_KEY)) { if (cb) cb({ success: false }); return; }
    const allowed = isTestAccount(name) ? exprList() : exprAllowedFor(name); // 测试号可预览全部
    if (cb) cb({ success: true, items: allowed.map(x => ({ id: x.id, url: x.url })), mine: ((usersData[name] || {}).emoji || []).slice() });
  });
  socket.on('set_emoji', ({ ids = [] }, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || name.startsWith('游客')) { if (cb) cb({ success: false, msg: '暂不支持游客装配' }); return; }
    const allowed = isTestAccount(name) ? exprList() : exprAllowedFor(name);
    const valid = [];
    for (const id of ids.slice(0, 3)) {
      if (valid.length >= 3) break;
      if (allowed.some(x => x.id === id) && !valid.includes(id)) valid.push(id);
    }
    usersData[name] = usersData[name] || {};
    usersData[name].emoji = valid;
    saveUsers();
    if (cb) cb({ success: true, mine: valid.slice() });
  });
  socket.on('emoji_send', ({ id, url }, cb) => {
    const name = socketToUser.get(socket.id);
    if (!name || name.startsWith('游客')) { if (cb) cb({ success: false, msg: '仅正式玩家/测试号可发送表情' }); return; }
    const allowed = isTestAccount(name) ? exprList() : exprAllowedFor(name);
    const ok = allowed.some(x => x.url === url && x.id === id);
    if (!ok) { if (cb) cb({ success: false, msg: '未装配该表情' }); return; }
    const syncKey = socketSyncKey.get(socket.id);
    const payload = { from: name, id, url };
    if (syncKey && syncSessions.has(syncKey)) {
      socket.to('sync:' + syncKey).emit('emoji_burst', payload);
    } else {
      let inRoom = false;
      for (const room of Object.values(GAME_ROOMS)) {
        if (room.playerMap.has(name) && (activeGameOf(room) || Object.values(room.seats).some(s => s && s.name === name))) {
          socket.to(room.roomId).emit('emoji_burst', payload);
          inRoom = true;
          break;
        }
      }
      if (!inRoom) {
        // 大厅互发：发给其他正在主页的人
        for (const [uname, sid] of lobbyViewers) {
          if (uname !== name && io.sockets.sockets.has(sid)) io.to(sid).emit('emoji_burst', payload);
        }
      }
    }
    if (cb) cb({ success: true });
  });

  // 玩家真正打开炸飞机页：登记在场（房间页/大厅不算在线）
  socket.on('bomber_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    bomberAtGame.set(name, socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'bomber') : null;
    const g = room && bomberGames[room.roomId];
    if (room && g) bmbBroadcast(room, g);
  });
  // 取消对局：在线者全员同意（离线不计票，离开的人可在房间页“返回游戏”继续玩）
  socket.on('bomber_cancel_vote', ({ revoke } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'bomber') : null;
    const g = room && bomberGames[room.roomId];
    if (!room || !g || !g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    if (revoke) {
      g.cancelVotes = (g.cancelVotes || []).filter(n => n !== name);
      bmbBroadcast(room, g);
      if (cb) cb({ success: true, votes: g.cancelVotes.slice(), revoked: true });
      return;
    }
    const onlineNames = g.playerOrder.filter(n => {
      const hb = userLastHeartbeat.get(n);
      const sid = room.playerMap.get(n);
      return hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && bomberAtGame.get(n) === sid && io.sockets.sockets.has(sid);
    });
    if (!g.cancelVotes.includes(name)) g.cancelVotes.push(name);
    if (onlineNames.length && g.cancelVotes.length >= onlineNames.length) {
      delete bomberGames[room.roomId];
      io.to(room.roomId).emit('bomber_cancel');
      Object.keys(room.seats).forEach(seatId => { if (room.seats[seatId]) room.seats[seatId].ready = false; });
      broadcastRoom(room);
      if (cb) cb({ success: true, cancelled: true });
      return;
    }
    bmbBroadcast(room, g);
    if (cb) cb({ success: true, votes: g.cancelVotes.slice() });
  });
  // ========== 炸飞机：摆放 / 开火 ==========
  socket.on('bomber_pull', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'bomber') : null;
    const g = room && bomberGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false }); return; }
    if (g.phase === 'battle' && bmbAdvance(g, room)) bmbBroadcast(room, g);
    if (cb) cb({ success: true, ...bmbState(g, name, room) });
  });
  socket.on('bomber_place', ({ planes }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'bomber') : null;
    const g = room && bomberGames[room.roomId];
    console.log('🎯 bomber_place', name, 'phase=', g && g.phase, 'ready=', g && g.ready && g.ready[name]);
    if (!room || !g || g.phase !== 'deploy' || g.ready[name]) { if (cb) cb({ success: false, msg: '当前不能摆放' }); return; }
    if (!g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '你不在本局中' }); return; }
    const norm = (planes || []).map(p => ({ type: Number(p.type), rotation: Number(p.rotation || 0), headR: Number(p.headR), headC: Number(p.headC) }));
    const err = bmbValidate(norm, g.config);
    console.log('  validate=', err || 'OK', 'config=', g.config);
    if (err) { if (cb) cb({ success: false, msg: err }); return; }
    g.planes[name] = norm.map(p => {
      const cells = bmbCellsOf(p);
      return Object.assign({}, p, { cells, headKey: p.type + '@' + p.headR + ',' + p.headC });
    });
    g.ready[name] = true;
    const onlineAt = g.playerOrder.filter(n => {
      const hb = userLastHeartbeat.get(n);
      const sid = room.playerMap.get(n);
      return hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT && sid && bomberAtGame.get(n) === sid && io.sockets.sockets.has(sid);
    });
    if (g.playerOrder.every(n => g.ready[n])) {
      g.phase = 'battle';
      g.turn = g.playerOrder[0];
      if (g.autoT) { clearTimeout(g.autoT); g.autoT = null; }
    } else if (!g.autoT && onlineAt.length && onlineAt.every(n => g.ready[n])) {
      // 在线者都已摆好、还有缺席未摆 → 8 秒后替缺席者随机布阵自动开局（缺席者回来后仍可取消/继续）
      g.autoT = setTimeout(() => {
        const g2 = bomberGames[room.roomId];
        if (!g2 || g2.phase !== 'deploy') return;
        let ok = true;
        for (const n of g2.playerOrder) {
          if (g2.ready[n]) continue;
          const planes = bmbRandomPlanes(g2.config);
          if (!planes) { ok = false; break; }
          g2.planes[n] = planes;
          g2.ready[n] = true;
        }
        if (!ok) return;
        g2.phase = 'battle';
        g2.turn = g2.playerOrder[0];
        bmbBroadcast(room, g2);
        if (bmbAdvance(g2, room)) bmbBroadcast(room, g2);
        console.log('🛫 自动布阵完成，bomber 进入 battle，当前回合=', g2.turn);
      }, 8000);
    }
    bmbBroadcast(room, g);
    if (cb) cb({ success: true });
  });
  socket.on('bomber_fire', ({ target, x, y }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'bomber') : null;
    const g = room && bomberGames[room.roomId];
    console.log('💣 bomber_fire', name, '->', target, x, y, 'turn=', g && g.turn, 'phase=', g && g.phase, 'alive=', g && g.alive);
    if (!room || !g || g.phase !== 'battle') { if (cb) cb({ success: false, msg: '对局尚未开始' }); return; }
    const r = Number(y), c = Number(x);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || r > 15 || c < 1 || c > 15) { if (cb) cb({ success: false, msg: '目标格无效' }); return; }
    if (!g.playerOrder.includes(name) || !g.alive.includes(name)) { if (cb) cb({ success: false, msg: '你已不在本局中' }); return; }
    if (!g.alive.includes(target) || target === name) { if (cb) cb({ success: false, msg: '请选择存活的对手' }); return; }
    if (g.turn !== name) { if (cb) cb({ success: false, msg: '还没轮到你行动' }); return; }
    const fkey = r + ',' + c;
    if ((g.firedCoords[target] || []).includes(fkey)) { if (cb) cb({ success: false, msg: '这个位置已被其他人轰炸过' }); return; }
    const outcome = bmbAttack(g, room, name, target, r, c);
    if (cb) cb({ success: true, res: outcome });
  });

  // ========== 扫雷（minesweeper）事件 ==========
  socket.on('minesweeper_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    msAtGame.set(name, socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'minesweeper') : null;
    const g = room && minesweeperGames[room.roomId];
    if (room && g) bmsBroadcast(room, g);
  });
  socket.on('minesweeper_pull', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'minesweeper') : null;
    const g = room && minesweeperGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false }); return; }
    if (cb) cb({ success: true, ...bmsView(g, name, room) });
  });
  socket.on('minesweeper_pick', ({ r, c, op }, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(rr => rr.playerMap.has(name) && rr.gameType === 'minesweeper') : null;
    const g = room && minesweeperGames[room.roomId];
    if (!room || !g || g.phase !== 'pick') { if (cb) cb({ success: false, msg: '当前不能选择格子' }); return; }
    if (!g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '你不在本局中' }); return; }
    const rr = Number(r), cc = Number(c);
    if (!Number.isInteger(rr) || !Number.isInteger(cc) || rr < 1 || rr > MS_SIZE || cc < 1 || cc > MS_SIZE) { if (cb) cb({ success: false, msg: '格子无效' }); return; }
    if (op !== 'open' && op !== 'flag') { if (cb) cb({ success: false, msg: '操作类型无效' }); return; }
    const k = msKey(rr, cc);
    if (g.revealed.has(k) || g.flagged.has(k) || g.exploded.has(k)) { if (cb) cb({ success: false, msg: '该格子不可操作' }); return; }
    if (g.picks[name]) { if (cb) cb({ success: false, msg: '本轮已提交，不能再修改' }); return; }
    g.picks[name] = { r: rr, c: cc, op };
    bmsBroadcast(room, g);
    const allPicked = g.playerOrder.every(n => g.picks[n]);
    if (allPicked) {
      // 所有人都选完：停 0.5 秒再统一揭晓
      setTimeout(() => {
        if (!minesweeperGames[room.roomId] || minesweeperGames[room.roomId] !== g || g.phase !== 'pick') return;
        msSettle(g);
        recordMinesweeperGame(g, room);
        if (g.phase === 'over') broadcastAchievementSummary(room.roomId, g);
        bmsBroadcast(room, g);
        if (g.phase === 'over') {
          if (!gameEndTimers[room.roomId]) {
            gameEndTimers[room.roomId] = setTimeout(() => {
              if (minesweeperGames[room.roomId] === g) delete minesweeperGames[room.roomId];
              if (minesweeperGames[room.roomId] && minesweeperGames[room.roomId].roundTimer) clearTimeout(minesweeperGames[room.roomId].roundTimer);
              delete gameEndTimers[room.roomId];
              Object.keys(room.seats).forEach(seatId => { if (room.seats[seatId]) room.seats[seatId].ready = false; });
              broadcastRoom(room);
              console.log(`🔄 扫雷 ${room.roomId} 已结算，房间已复位`);
            }, 5000);
          }
        }
      }, 500);
    }
    if (cb) cb({ success: true });
  });
  // 取消对局：沿用熟人局全员同意（可撤回），只统计真正在场玩家
  socket.on('minesweeper_cancel_vote', ({ revoke } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? Object.values(GAME_ROOMS).find(rr => rr.playerMap.has(name) && rr.gameType === 'minesweeper') : null;
    const g = room && minesweeperGames[room.roomId];
    if (!room || !g || !g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const onlineNames = g.playerOrder.filter(n => {
      const sid = room.playerMap.get(n);
      const sid2 = msAtGame.get(n);
      const hb = userLastHeartbeat.get(n);
      return sid && sid === sid2 && io.sockets.sockets.has(sid) && hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT;
    });
    if (revoke) {
      g.cancelVotes = (g.cancelVotes || []).filter(n => n !== name);
      bmsBroadcast(room, g);
      if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
      return;
    }
    g.cancelVotes = g.cancelVotes || [];
    if (!g.cancelVotes.includes(name)) g.cancelVotes.push(name);
    if (onlineNames.length && g.cancelVotes.length >= onlineNames.length) {
      bmsCancel(room, g);
      if (cb) cb({ success: true, cancelled: true });
      return;
    }
    bmsBroadcast(room, g);
    if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
  });

  // ======================== 翻转棋（othello）事件 ========================
  function othFindRoomOf(name) {
    return Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'othello') || null;
  }
  socket.on('othello_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    othAtGame.set(name, socket.id);
    const room = othFindRoomOf(name);
    const g = room && othelloGames[room.roomId];
    if (room && g) othBroadcast(room, g);
  });
  socket.on('othello_pull', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? othFindRoomOf(name) : null;
    const g = room && othelloGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false }); return; }
    if (cb) cb(Object.assign({ success: true }, othView(g, name, room)));
  });
  socket.on('othello_place', ({ r, c } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? othFindRoomOf(name) : null;
    const g = room && othelloGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = othPlace(g, name, r, c);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    othBroadcast(room, g);
    if (res.finished) broadcastAchievementSummary(room.roomId, g);
    // 终局：8 秒后自动结算房间（复位准备状态，可开新局）；客户端保留本地棋局，仍可展开查看
    if (res.finished && !gameEndTimers[room.roomId]) {
      gameEndTimers[room.roomId] = setTimeout(() => {
        if (othelloGames[room.roomId] !== g) { delete gameEndTimers[room.roomId]; return; }
        delete othelloGames[room.roomId];
        Object.keys(room.seats).forEach(i => { if (room.seats[i]) room.seats[i].ready = false; });
        broadcastRoom(room);
        delete gameEndTimers[room.roomId];
        console.log(`🔄 翻转棋 ${room.roomId} 已结算，房间已复位`);
      }, 8000);
    }
    if (cb) cb({ success: true, pass: !!res.pass, finished: !!res.finished });
  });
  // 取消对局：沿用熟人局全员同意（可撤回）
  socket.on('othello_cancel_vote', ({ revoke } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? othFindRoomOf(name) : null;
    const g = room && othelloGames[room.roomId];
    if (!room || !g || !g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const onlineNames = g.playerOrder.filter(n => {
      const sid = room.playerMap.get(n);
      const sid2 = othAtGame.get(n);
      const hb = userLastHeartbeat.get(n);
      return sid && sid === sid2 && io.sockets.sockets.has(sid) && hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT;
    });
    if (revoke) {
      g.cancelVotes = (g.cancelVotes || []).filter(n => n !== name);
      othBroadcast(room, g);
      if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
      return;
    }
    g.cancelVotes = g.cancelVotes || [];
    if (!g.cancelVotes.includes(name)) g.cancelVotes.push(name);
    if (onlineNames.length && g.cancelVotes.length >= onlineNames.length) {
      othCancel(room, g);
      if (cb) cb({ success: true, cancelled: true });
      return;
    }
    othBroadcast(room, g);
    if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
  });

  // ======================== 路墙棋（quoridor）事件 ========================
  function quoFindRoomOf(name) {
    return Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'quoridor') || null;
  }
  socket.on('quoridor_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    quoriAtGame.set(name, socket.id);
    const room = quoFindRoomOf(name);
    const g = room && quoridorGames[room.roomId];
    if (room && g) quoBroadcast(room, g);
  });
  socket.on('quoridor_pull', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? quoFindRoomOf(name) : null;
    const g = room && quoridorGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false }); return; }
    if (cb) cb(Object.assign({ success: true }, quoView(g, name, room)));
  });
  socket.on('quoridor_snapshot', ({ index } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? quoFindRoomOf(name) : null;
    const g = room && quoridorGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false }); return; }
    const snap = quoSnapshotOf(g, Number(index));
    if (!snap) { if (cb) cb({ success: false, msg: '没有这一步记录' }); return; }
    if (cb) cb(Object.assign({ success: true }, snap));
  });
  // 终局后复位房间（保留走步记录在客户端本地）
  function quoAfterAction(room, g, res) {
    if (!res.ok) return;
    quoBroadcast(room, g);
    if (g.over) {
      broadcastAchievementSummary(room.roomId, g);
      if (!gameEndTimers[room.roomId]) {
        gameEndTimers[room.roomId] = setTimeout(() => {
          if (quoridorGames[room.roomId] !== g) { delete gameEndTimers[room.roomId]; return; }
          delete quoridorGames[room.roomId];
          Object.keys(room.seats).forEach(i => { if (room.seats[i]) room.seats[i].ready = false; });
          broadcastRoom(room);
          delete gameEndTimers[room.roomId];
          console.log(`🔄 路墙棋 ${room.roomId} 已结算，房间已复位`);
        }, 12000);
      }
    }
  }
  socket.on('quoridor_move', ({ r, c } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? quoFindRoomOf(name) : null;
    const g = room && quoridorGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = quoApplyMove(g, name, r, c);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    quoAfterAction(room, g, res);
    if (cb) cb({ success: true, finished: !!res.finished });
  });
  socket.on('quoridor_wall', ({ r, c, o } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? quoFindRoomOf(name) : null;
    const g = room && quoridorGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = quoApplyWall(g, name, r, c, o);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    quoAfterAction(room, g, res);
    if (cb) cb({ success: true });
  });
  socket.on('quoridor_cancel_vote', ({ revoke } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? quoFindRoomOf(name) : null;
    const g = room && quoridorGames[room.roomId];
    if (!room || !g || !g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const onlineNames = g.playerOrder.filter(n => {
      const sid = room.playerMap.get(n);
      const sid2 = quoriAtGame.get(n);
      const hb = userLastHeartbeat.get(n);
      return sid && sid === sid2 && io.sockets.sockets.has(sid) && hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT;
    });
    if (revoke) {
      g.cancelVotes = (g.cancelVotes || []).filter(n => n !== name);
      quoBroadcast(room, g);
      if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
      return;
    }
    g.cancelVotes = g.cancelVotes || [];
    if (!g.cancelVotes.includes(name)) g.cancelVotes.push(name);
    if (onlineNames.length && g.cancelVotes.length >= onlineNames.length) {
      quoCancel(room, g);
      if (cb) cb({ success: true, cancelled: true });
      return;
    }
    quoBroadcast(room, g);
    if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
  });

  // ======================== 技能五子棋（gomoku）事件 ========================
  function gmkFindRoomOf(name) {
    return Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'gomoku') || null;
  }
  socket.on('gomoku_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    gomoAtGame.set(name, socket.id);
    const room = gmkFindRoomOf(name);
    const g = room && gomokuGames[room.roomId];
    if (room && g) gmkBroadcast(room, g);
  });
  socket.on('gomoku_pull', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false }); return; }
    if (cb) cb(Object.assign({ success: true }, gmkView(g, name, room)));
  });
  function gmkAfterAction(room, g) {
    gmkBroadcast(room, g);
    if (g.over) {
      broadcastAchievementSummary(room.roomId, g);
      if (!gameEndTimers[room.roomId]) {
        gameEndTimers[room.roomId] = setTimeout(() => {
          if (gomokuGames[room.roomId] !== g) { delete gameEndTimers[room.roomId]; return; }
          delete gomokuGames[room.roomId];
          Object.keys(room.seats).forEach(i => { if (room.seats[i]) room.seats[i].ready = false; });
          broadcastRoom(room);
          delete gameEndTimers[room.roomId];
          console.log(`🔄 技能五子棋 ${room.roomId} 已结算，房间已复位`);
        }, 12000);
      }
    }
  }
  socket.on('gomoku_pick_role', ({ role } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = gmkPickRole(g, name, role);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    gmkBroadcast(room, g);
    if (cb) cb({ success: true, started: !!res.started });
  });
  socket.on('gomoku_place', ({ r, c } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = gmkPlace(g, name, r, c);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    gmkAfterAction(room, g);
    if (cb) cb({ success: true, win: !!res.win, extra: !!res.extra });
  });
  socket.on('gomoku_seal', ({ r, c } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = gmkSeal(g, name, r, c);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    gmkBroadcast(room, g);
    if (cb) cb({ success: true });
  });
  socket.on('gomoku_predict', ({ points } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = gmkPredict(g, name, points);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    gmkBroadcast(room, g);   // 预测点仅自己可见，但要让本人立刻看到标记
    if (cb) cb({ success: true });
  });
  socket.on('gomoku_clean_pick', ({ r, c } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = gmkCleanPick(g, name, r, c);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    gmkBroadcast(room, g);
    if (cb) cb({ success: true, done: !!res.done });
  });
  // 清洁工：是否发动技能（二选一）
  socket.on('gomoku_clean_choice', ({ use } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = gmkCleanChoose(g, name, use !== false);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    gmkBroadcast(room, g);
    if (cb) cb({ success: true, declined: !!res.declined, picking: !!res.picking });
  });
  // 封印师：本轮空封（不封锁）
  socket.on('gomoku_seal_skip', (_p, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = gmkSealSkip(g, name);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    gmkBroadcast(room, g);
    if (cb) cb({ success: true });
  });
  socket.on('gomoku_cancel_vote', ({ revoke } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? gmkFindRoomOf(name) : null;
    const g = room && gomokuGames[room.roomId];
    if (!room || !g || !g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const onlineNames = g.playerOrder.filter(n => {
      const sid = room.playerMap.get(n);
      const sid2 = gomoAtGame.get(n);
      const hb = userLastHeartbeat.get(n);
      return sid && sid === sid2 && io.sockets.sockets.has(sid) && hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT;
    });
    if (revoke) {
      g.cancelVotes = (g.cancelVotes || []).filter(n => n !== name);
      gmkBroadcast(room, g);
      if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
      return;
    }
    g.cancelVotes = g.cancelVotes || [];
    if (!g.cancelVotes.includes(name)) g.cancelVotes.push(name);
    if (onlineNames.length && g.cancelVotes.length >= onlineNames.length) {
      gmkCancel(room, g);
      if (cb) cb({ success: true, cancelled: true });
      return;
    }
    gmkBroadcast(room, g);
    if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
  });

  // ======================== 魔法气泡（puyopuyo）事件 ========================
  function ppoFindRoomOf(name) {
    return Object.values(GAME_ROOMS).find(r => r.playerMap.has(name) && r.gameType === 'puyopuyo') || null;
  }
  socket.on('puyopuyo_enter', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    puyoAtGame.set(name, socket.id);
    const room = ppoFindRoomOf(name);
    const g = room && puyopuyoGames[room.roomId];
    if (room && g) ppoBroadcast(room, g);
  });
  socket.on('puyopuyo_pull', (cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? ppoFindRoomOf(name) : null;
    const g = room && puyopuyoGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false }); return; }
    if (cb) cb(Object.assign({ success: true }, ppoView(g, name, room)));
  });
  function ppoAfterAction(room, g) {
    ppoBroadcast(room, g);
    if (g.over) {
      broadcastAchievementSummary(room.roomId, g);
      ppoScheduleReset(room.roomId, g);
    }
  }
  // 终局后 12 秒复位房间（无论对局是「玩家操作结束」还是「节拍淘汰结束」都会走这里）
  function ppoScheduleReset(roomId, g) {
    const room = GAME_ROOMS.puyopuyo;
    if (!room || puyopuyoGames[roomId] !== g || g._resetScheduled) return;
    g._resetScheduled = true;
    if (gameEndTimers[roomId]) clearTimeout(gameEndTimers[roomId]);
    gameEndTimers[roomId] = setTimeout(() => {
      if (puyopuyoGames[roomId] === g) {
        delete puyopuyoGames[roomId];
        Object.keys(room.seats).forEach(i => { if (room.seats[i]) room.seats[i].ready = false; });
        broadcastRoom(room);
        console.log(`🔄 魔法气泡 ${roomId} 已结算，房间已复位`);
      }
      delete gameEndTimers[roomId];
    }, 12000);
  }
  socket.on('puyopuyo_input', (data = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? ppoFindRoomOf(name) : null;
    const g = room && puyopuyoGames[room.roomId];
    if (!room || !g) { if (cb) cb({ success: false, msg: '对局不存在' }); return; }
    const res = ppoInput(g, name, data);
    if (!res.ok) { if (cb) cb({ success: false, msg: res.msg }); return; }
    if (g.over) ppoAfterAction(room, g);
    if (cb) cb({ success: true });
  });
  socket.on('puyopuyo_cancel_vote', ({ revoke } = {}, cb) => {
    const name = socketToUser.get(socket.id);
    const room = name ? ppoFindRoomOf(name) : null;
    const g = room && puyopuyoGames[room.roomId];
    if (!room || !g || !g.playerOrder.includes(name)) { if (cb) cb({ success: false, msg: '未在对局中' }); return; }
    const onlineNames = g.playerOrder.filter(n => {
      const sid = room.playerMap.get(n);
      const sid2 = puyoAtGame.get(n);
      const hb = userLastHeartbeat.get(n);
      return sid && sid === sid2 && io.sockets.sockets.has(sid) && hb && (Date.now() - hb) < HEARTBEAT_TIMEOUT;
    });
    if (revoke) {
      g.cancelVotes = (g.cancelVotes || []).filter(n => n !== name);
      ppoBroadcast(room, g);
      if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
      return;
    }
    g.cancelVotes = g.cancelVotes || [];
    if (!g.cancelVotes.includes(name)) g.cancelVotes.push(name);
    if (onlineNames.length && g.cancelVotes.length >= onlineNames.length) {
      ppoCancel(room, g);
      if (cb) cb({ success: true, cancelled: true });
      return;
    }
    ppoBroadcast(room, g);
    if (cb) cb({ success: true, votes: g.cancelVotes.slice(), total: onlineNames.length });
  });


  socket.on('disconnect', () => {
    const name = socketToUser.get(socket.id);
    if (!name) return;
    socketToUser.delete(socket.id);
    // 离开画猜游戏页：清除“正在对局页”标记（仅当标记还指向本 socket）
    if (drawingAtGame.get(name) === socket.id) drawingAtGame.delete(name);
    // 离开大厅页
    if (lobbyViewers.get(name) === socket.id) lobbyViewers.delete(name);
    // 离开炸飞机游戏页
    if (bomberAtGame.get(name) === socket.id) bomberAtGame.delete(name);
    if (msAtGame.get(name) === socket.id) msAtGame.delete(name);
    if (othAtGame.get(name) === socket.id) othAtGame.delete(name);
    if (quoriAtGame.get(name) === socket.id) quoriAtGame.delete(name);
    if (gomoAtGame.get(name) === socket.id) gomoAtGame.delete(name);
    if (puyoAtGame.get(name) === socket.id) puyoAtGame.delete(name);

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
    persistLastOffline(name);

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

// 魔法气泡：服务端节拍（气泡下落 / 干扰落地 / 败北判定 / 状态广播）
setInterval(() => ppoTick(Date.now()), PPO_TICK_MS);
// 魔法气泡：节拍内判定结束后安排房间复位（避免“对局结束但对局对象一直存在”）
setInterval(() => {
  for (const roomId of Object.keys(puyopuyoGames)) {
    const g = puyopuyoGames[roomId];
    if (!g || !g.over || !g.needReset || g._resetScheduled) continue;
    const room = GAME_ROOMS.puyopuyo;
    if (!room || puyopuyoGames[roomId] !== g) continue;
    g._resetScheduled = true;
    if (gameEndTimers[roomId]) clearTimeout(gameEndTimers[roomId]);
    gameEndTimers[roomId] = setTimeout(() => {
      if (puyopuyoGames[roomId] === g) {
        delete puyopuyoGames[roomId];
        Object.keys(room.seats).forEach(i => { if (room.seats[i]) room.seats[i].ready = false; });
        broadcastRoom(room);
        console.log(`🔄 魔法气泡 ${roomId} 已结算，房间已复位`);
      }
      delete gameEndTimers[roomId];
    }, 12000);
    console.log('🏁 魔法气泡 ' + roomId + ' 对局结束，12 秒后复位房间');
  }
}, 1000);

setInterval(() => {
  for (const room of Object.values(GAME_ROOMS)) {
    broadcastRoom(room);
  }
  broadcast();
}, 3000);

// 技能五子棋兜底：清洁工决定/选子、以及“技能未完成”导致的卡轮，超时自动放行
setInterval(() => {
  for (const roomId of Object.keys(gomokuGames)) {
    const g = gomokuGames[roomId];
    if (!g || g.over) continue;
    // 1) 清洁工：60 秒未决定 → 视为不发动；45 秒未选子 → 自动代选
    const cp = g.cleanPending;
    if (cp) {
      const started = cp.startedAt || (cp.startedAt = Date.now());
      const idx = cp.by;
      if (cp.phase === 'ask') {
        if (Date.now() - started > 60000) { gmkCleanChoose(g, g.players[idx].name, false); gmkBroadcastFor(roomId); }
        continue;
      }
      if (Date.now() - started < 45000) continue;
      const targets = gmkCleanTargets(g, idx);
      if (!targets.length) { g.cleanPending = null; gmkMaybeEndTurn(g, idx); gmkBroadcastFor(roomId); continue; }
      const t = cp.picks.length ? (targets.find(x => x.owner !== cp.picks[0].owner) || targets[0]) : targets[0];
      gmkCleanPick(g, g.players[idx].name, t.r, t.c);
      gmkBroadcastFor(roomId);
      continue;
    }
    // 2) 回合卡在“必须用技能”：90 秒后自动完成（截码战放弃本轮预测 / 封印师空封）
    const sw = g.skillWaitFor;
    if (sw && g.phase === 'play' && g.turnIdx === sw.idx && Date.now() - sw.since > 90000) {
      const p = g.players[sw.idx];
      if (sw.need === 'predict') p.predictSkipRound = g.round;
      if (sw.need === 'seal') p.sealSkipRound = g.round;
      gmkNotice(g, (sw.need === 'predict' ? '截码战专家 ' + p.name + ' 超时未预测，本轮视为放弃' : '封印师 ' + p.name + ' 超时未操作，本轮视为空封'), 'info');
      gmkMaybeEndTurn(g, sw.idx);
      gmkBroadcastFor(roomId);
    }
  }
}, 5000);

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
// 正式玩家“上次离线时间”持久化：重启后回填，列表/个人空间仍显示上次离线时间
for (const off of OFFICIAL_ACCOUNT_NAMES) {
  const saved = usersData[off] && usersData[off].lastOffline;
  if (saved && !userLastOnline.has(off)) userLastOnline.set(off, saved);
}
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

// ========== 留言板（可落盘：PERSIST_BOARD=true 时写入 data/board.json） ==========
const BOARD_MAX = 120; // 每块最多保留条数
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const PERSIST_BOARD = process.env.PERSIST_BOARD === 'true';
function loadBoard() {
  try { const d = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')) || {}; return { official: Array.isArray(d.official) ? d.official : [], guest: Array.isArray(d.guest) ? d.guest : [] }; }
  catch (e) { return { official: [], guest: [] }; }
}
let boardMessages = PERSIST_BOARD ? loadBoard() : { official: [], guest: [] }; // { name, text, ts }
function saveBoard() {
  if (!PERSIST_BOARD) return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BOARD_FILE, JSON.stringify(boardMessages, null, 2)); } catch (e) { console.error('❌ 留言板写入失败：', e.message); }
}
function pushBoard(type, msg) {
  boardMessages[type].push(msg);
  if (boardMessages[type].length > BOARD_MAX) boardMessages[type].shift();
  saveBoard();
  io.emit('board_new', { type, msg });
}

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
const DRAW_TIME = 80 * 1000; // 你画我猜每轮限时 80 秒（2026-09-07 反馈：原 60 偏短）
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
    aliasHistory: (p.aliasHistory || []).slice(),
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
// ========== 默契宠物 v2（圆身极简线条 + 金币 + 外观 + 双人签到；预留素材替换位） ==========
const PET_SKINS = ['#f2c94c', '#e8a0b8', '#8fb7e8', '#6ec6a0', '#b79ae0', '#e89a7a']; // 0=淡黄初始
const PET_LOGS2 = [
  { t: '💛 打了半天工，赚到 ', g: 3 },
  { t: '🐭 溜去隔壁家顺了点金币 +', g: 5 },
  { t: '🍃 出门散步，捡到金币 +', g: 2 },
  { t: '💤 晒着太阳睡了个午觉', g: 0 }
];
function petToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function petEnsure(pk) {
  const pair = syncGetPair(pk);
  if (!pair.pet) pair.pet = { exp: 0, gold: 10, color: PET_SKINS[0], signDay: '', signs: [], logs: [], lastActivity: 0 };
  return pair.pet;
}
function petAddLog(p, text) {
  p.logs.unshift({ t: text, ts: Date.now() });
  if (p.logs.length > 8) p.logs.pop();
}
function petTick(pk) {
  const p = petEnsure(pk);
  const now = Date.now();
  if (now - (p.lastActivity || 0) < 6 * 3600 * 1000) return;
  p.lastActivity = now;
  const act = PET_LOGS2[Math.floor(Math.random() * PET_LOGS2.length)];
  if (act.g > 0) p.gold = (p.gold || 0) + act.g;
  petAddLog(p, act.t + (act.g ? act.g + ' 🪙' : ''));
  syncSavePair(pk);
}
function petSnapshot(pk, name) {
  const p = petEnsure(pk);
  petTick(pk);
  if (p.signDay !== petToday()) { p.signDay = petToday(); p.signs = []; }
  const exp = p.exp || 0;
  return {
    exp, gold: p.gold || 0, color: p.color || PET_SKINS[0],
    level: Math.floor(Math.sqrt(exp / 4)) + 1,
    signs: (p.signs || []).slice(), meSigned: (p.signs || []).includes(name),
    done: (p.signs || []).length >= 2, skins: PET_SKINS,
    logs: (p.logs || []).slice(0, 8)
  };
}
function petSign(pk, name) {
  const p = petEnsure(pk);
  if (p.signDay !== petToday()) { p.signDay = petToday(); p.signs = []; }
  if (p.signs.includes(name)) return { added: 0, done: p.signs.length >= 2 };
  p.signs.push(name);
  const done = p.signs.length >= 2;
  const added = done ? 20 : 10; // 双方都签才算完成
  p.exp = (p.exp || 0) + added;
  petAddLog(p, done ? '✅ 今天两人都来看我啦 +20' : '🖐 收到一次签到，等另一半… +10');
  syncSavePair(pk);
  return { added, done };
}
function petBuy(pk, color) {
  const p = petEnsure(pk);
  const c = String(color || '');
  if (!PET_SKINS.includes(c)) return { ok: false };
  if (p.color === c) return { ok: false, msg: '已经是这个颜色了' };
  const cost = 30;
  if ((p.gold || 0) < cost) return { ok: false, msg: '金币不够（需要 30）' };
  p.gold -= cost;
  p.color = c;
  petAddLog(p, '🛍 用 30 🪙 换了个新颜色');
  syncSavePair(pk);
  return { ok: true };
}
function petGain(pk, n) {
  const p = petEnsure(pk);
  p.exp = (p.exp || 0) + n;
  syncSavePair(pk);
  return p.exp;
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
    pushBoard('official', { name: '系统', text, ts: Date.now() });
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
  petGain(pairKey, gains > 0 ? 3 : 1); // 完成默契问答：宠物成长
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
  sess.paint = { painter, guesser, stage: 'word', word: null, strokes: [], attempts: [], deadline: 0, idx: 0, nextVotes: {} };
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
  petGain(pairKey, win ? 3 : 1); // 完成你画我猜：宠物成长
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

// 监听：可用环境变量 PORT / HOST 覆盖（默认 3000 / 0.0.0.0，公网可达）
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`🏰 服务器启动：http://${HOST}:${PORT}`);
  console.log(`💾 持久化：成就=${process.env.PERSIST_ACHIEVEMENTS === 'true' ? 'ON' : 'OFF(内存)'} / 时光墙=${process.env.PERSIST_TIMELINE === 'true' ? 'ON' : 'OFF(内存)'} / 默契=${process.env.PERSIST_SYNC === 'true' ? 'ON' : 'OFF(内存)'}`);
  console.log('✅ 单房间系统已启动');
  console.log('✅ 自动房主转移已开启');
  console.log('✅ 3秒自动同步已开启');
  console.log('✅ 游戏进行中禁止新玩家入座已开启');
  console.log('✅ 心跳检测（30秒超时）已开启');
  console.log('✅ 主动退出房间逻辑已新增');
  console.log('✅ 游戏状态主动拉取接口已新增');
});