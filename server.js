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
    const m = games[gk][mk] || { games: 0, wins: 0, totalScore: 0, best: 0, teamScore: 0, teamBest: 0 };
    m.games++;
    m.totalScore += my.score;
    if (my.score > m.best) m.best = my.score;
    if (timelineWin(e, name)) m.wins++;
    if (e.game === 'minesweeper' && e.mode === 'team' && my.teamTotal != null) {
      m.teamScore = (m.teamScore || 0) + my.teamTotal;
      if (my.teamTotal > (m.teamBest || 0)) m.teamBest = my.teamTotal;
    }
    games[gk][mk] = m;
  }
  return order.map(gk => ({
    game: gk,
    modes: Object.keys(games[gk])
      .map(mode => { const s = games[gk][mode]; return { mode, games: s.games, wins: s.wins, winRate: s.games ? Math.round(s.wins / s.games * 100) : 0, totalScore: s.totalScore, best: s.best, teamScore: s.teamScore || 0, teamBest: s.teamBest || 0 }; })
      .sort((a, b) => profileModeRank(a.mode) - profileModeRank(b.mode))
  }));
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
  }];
  const totals = { games: 18, wins: 9, winRate: 50, totalScore: 2143, best: 336 };
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
  ms_flag_s1:  { name: 'S1旗手',        quality: 'legend', game: 'minesweeper', base: '旗手', group: 'ms_flag' }
};
const ACH_QUALITY_NO = { common: 1, rare: 2, epic: 3, legend: 4, hidden: 5 };
// 旗手升级档位（累计正确插旗数）：同组 id 靠品质最高档展示
const MS_FLAG_LEVELS = [['ms_flag_s1', 1000], ['ms_flag_a', 500], ['ms_flag_b', 100], ['ms_flag_c', 10]];
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
  minesweeper: '/minesweeper.html'
};
const GAME_NAME_LABEL = { yahtzee: '快艇骰子', light: '拍灯大作战', drawing: '画猜接龙', bomber: '炸飞机', minesweeper: '扫雷' };
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
const drawingAtGame = new Map(); // playerName -> 当前正打开“画猜接龙游戏页”的 socket.id（用于判定谁真正在对局内）
const lobbyViewers = new Map(); // playerName -> 正在大厅页的 socket.id（表情包跨页互发用）
const bomberAtGame = new Map(); // playerName -> 正在炸飞机游戏页的 socket.id（离开/返回与取消判定）
// 通用取"某房间当前进行中的对局"（yahtzee / light / drawing 共用）
function activeGameOf(room) {
  if (!room) return null;
  if (room.gameType === 'drawing') return drawingGames[room.roomId] || null;
  if (room.gameType === 'bomber') return bomberGames[room.roomId] || null;
  if (room.gameType === 'minesweeper') return minesweeperGames[room.roomId] || null;
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
    roomId: room.roomId, hostName: room.hostName, maxPlayers: room.maxPlayers, skipOffline: !!room.skipOffline, msTeam: !!room.msTeam,
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
        skipOffline: !!room.skipOffline, msTeam: !!room.msTeam,
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
  // 扫雷：同熟人局规则——离线不除名、原地等待，可重连继续
  if (room.gameType === 'minesweeper' && minesweeperGames[room.roomId]) {
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

  socket.on('change_settings', ({ maxPlayers, skipOffline, msTeam }, cb) => {
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
    if (activeGameOf(room)) return;

    // 离线是否自动跳过：默认 false（不跳），仅在房间设置勾选后生效
    if (typeof skipOffline === 'boolean') room.skipOffline = skipOffline;
    // 扫雷赛制：个人赛/2v2
    if (typeof msTeam === 'boolean') room.msTeam = msTeam;

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
        : (room.gameType === 'bomber' || room.gameType === 'minesweeper')
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
    const already = ACHIEVEMENTS[achievementId].group === 'ms_flag' && achTestRecords.some(r => r.playerName === name && r.achievementId === achievementId);
    if (!already) recordAchievement(name, achievementId); // 测试者：内存记录，重启即刷新
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
    if (cb) cb({ success: true, game: '快艇骰子', board: gamesArr, achBoard: achArr, drawingBoard: drawingArr, bomberBoard: bomberArr,
      highHistBoard: highHistArr, drawingHistBoard: drawingHistArr, bomberHistBoard: bomberHistArr,
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
    const needPlayers = room.gameType === 'drawing' ? 4 : 2; // 画猜接龙为四人版；其余默认至少 2 人
    if (players.length < needPlayers || !players.every(p => p.ready)) return;
    if (room.gameType === 'minesweeper' && room.msTeam && players.length < 4) return; // 2v2 固定 4 人
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
    }
    broadcastRoom(room);
    if (room.gameType === 'drawing') {
      dgBroadcast(room);
    } else if (room.gameType === 'bomber') {
      bmbBroadcast(room, bomberGames[room.roomId]);
    } else if (room.gameType === 'minesweeper') {
      bmsBroadcast(room, minesweeperGames[room.roomId]);
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