# 技术细节

> 本文档由 AI 助手维护（对应开发原则中的 Dev/Technology.md）。实际路径：development/technology.md
> 规则：每次修改/开发之前都应先阅读本文档；每次开发之后都应把必要的对接技术细节补充进来。

---

## 1. 房间系统（server.js）

### 1.1 房间数据结构 GAME_ROOMS[gameType]
```js
{
  roomId: 'yahtzee_001',     // 同时作为 socket.io room 名 = 广播目标
  gameType: 'yahtzee',       // 'yahtzee' | 'light'
  hostName: null,            // 房主玩家名
  maxPlayers: 4,
  seats: { 1: { name, ready }, 2: null, 3: null, 4: null },  // 空位是 null；删座用 delete
  spectators: [],            // 观战者玩家名数组
  playerMap: new Map(),      // 玩家名 -> socket.id（进房即加入，观战者也在里面）
  leaveTimers: {}            // 玩家名 -> 断线移除计时器（30 秒宽限）
}
```

### 1.2 room_update 事件结构
- 公共字段（所有人一样）：`roomId`、`hostName`、`maxPlayers`、`seats`、`spectators`
- 个性化字段（每份单独发）：`mySeat`（null 或座位号字符串）、`myReady`（bool）
- broadcastRoom 内部广播两轮：
  1. `io.to(room.roomId).emit('room_update', 公共字段)` → 房间内全部 socket；
  2. 遍历 `room.playerMap`，对每个仍在线成员单独 `emit('room_update', 公共字段 + mySeat + myReady)`。

### 1.3 两个同步函数的分工（勿混用）
- `syncRoomState(room, selfName)`：只给 selfName 这一个玩家发 room_update（含 ta 的 mySeat / myReady）。
- `broadcastRoom(room)`：先调 transferHost(room) 处理房主转移/清空，再向全房间广播。用于所有房间级变更（入座/离座/观战/准备/改人数/房主变化/移除离线玩家）。

### 1.4 join_room 处理顺序（重要，勿乱序）
1. `socketToUser.set(socket.id, playerName)`
2. 清理 offlineTimers / room.leaveTimers[playerName]
3. 登记 onlineUsers + userLastHeartbeat + broadcast()
4. `room.playerMap.set(playerName, socket.id)`；`socket.join(room.roomId)`
5. 入座 / 观战判断（A008 修复后约定：**先判断是否已在座**）：
   - 若 playerName 已在某个座位 → 保留座位，并把它从 spectators 名单中移除（防止"座位+观战"并存）；
   - 否则：若游戏已开始（yahtzeeGames[room.roomId] 存在）或座位已满 → 加入 spectators；
   - 否则：自动坐最小空位（seats[1] 起）；房间无房主则设 playerName 为房主。
6. `cb({ roomId, isHost })`（供 room.html 初始化）
7. `syncRoomState(room, playerName)` → 给新玩家本人
8. `broadcastRoom(room)` → 通知房间内所有人（新玩家会收到两遍 room_update：一遍公共、一遍个性化，属正常现象）
9. 若 yahtzeeGames[room.roomId] 已存在 → 再补发一份 game_state 给新玩家（socket.emit，不是 io.to）

### 1.5 心跳 / 离线 / 房主转移（0.3 版起为"身份自动续接"机制）
- 客户端【所有页面】统一心跳：连接成功立即发一次 + 每 10 秒一次，参数为 `(playerName, isTest, inRoom)`：
  - yahtzee.html / room.html（房间上下文）：`inRoom = true`
  - lobby.html（大厅）：`inRoom = false`
- 服务器 heartbeat 处理器职责：
  1. `socketToUser.set(socket.id, playerName)`（新页面/刷新后的 socket 身份续接，yahtzee_action 依赖它）；
  2. 官方玩家/游客若不在 onlineUsers（被旧连接断开时删了）则重新登记为在线；
  3. 当 `inRoom === true`：把该玩家所在房间的 `playerMap` 指向新 socket、`socket.join(room.roomId)`、取消 `room.leaveTimers[playerName]`（避免 30 秒后被误踢）；
  4. 更新 userLastHeartbeat → broadcast()。
- disconnect：不立即删除玩家，先查"该玩家名是否已被另一条活跃连接接管"：
  - 已接管（刷新/跳转场景）→ 直接 return，不删在线、不排队移除；
  - 未接管（真离线）→ 删 onlineUsers、设 `room.leaveTimers[name]`（30 秒宽限，供刷新/断线重连）。
- `removeOfflinePlayer(room, name, force)`：force 缺省时先做保险——若 playerMap 对应 socket 仍在线则跳过移除（防后台节流/跳转误杀）；force=true（主动退出房间 leave_room）无条件移除。移除动作：删座位 → 删观战 → 删 playerMap → 清理计时器/心跳 → transferHost → broadcastRoom。
- 服务器每 3 秒 setInterval 对所有房间 broadcastRoom() + broadcast() 兜底。
- transferHost：取第一个有人的座位作为新房主；无人则 hostName = null。变更时会 `io.to(roomId).emit('host_changed', { newHost })`。

### 1.6 快艇骰子服务器状态
- `yahtzeeGames[roomId]`：`{ roomId, players: { 名: { dice[5], kept[5], rollCount, scores, previewScores } }, playerOrder: [名字], currentPlayerIndex, phase: 'playing'|'finished', round: 1..13 }`
- `broadcastYahtzeeState(roomId)` 用 `io.to(roomId).emit('game_state', ...)` 广播游戏状态。
- 轮到玩家时回合结束：`currentPlayerIndex++`；越界则归 0 且 `round++`；round > 13 → phase = 'finished'。清理本局的两种方式：
  1. 玩家点"返回房间"→ 前端 emit `return_room` → 服务器立即删 yahtzeeGames、复位全部座位 ready=false、broadcastRoom（正常流程）；
  2. 兜底：`gameEndTimers[roomId]` 60 秒后自动清理（防误删下一局：start_game 与 return_room 都会先 clearTimeout）。
- 服务器端禁用动作：`!game || 非当前回合玩家 || phase !== 'playing'` 时 yahtzee_action 直接 return。

---

## 2. 快艇骰子联机页（public/yahtzee.html）

### 2.1 身份与进入方式
- 玩家名：`sessionStorage.getItem('playerName')`；房间号：URL 参数 `?room=...`。
- 从 room.html 跳转过来后【不要】再 emit join_room（页面已换新 socket，但还在房间的 socket.io room 内，可直接收 game_state / room_update）。
- 连接成功（socket.on('connect')）后主动 emit `get_game_state` 拉一次状态（解决刷新丢失）。
  - 【返回方式】服务器收到 get_game_state 后：游戏不存在 → 仅 cb（无则沉默）；游戏存在 → **直接 `socket.emit('game_state', 数据)`**（与 broadcastYahtzeeState 结构一致）+ 可选 cb。前端只监听 game_state 事件即可（A004 修复后约定）。
- 身份对应关系：服务端靠 socketToUser 记住 name ↔ socket.id；游戏动作 yahtzee_action 依赖它校验轮到谁。

### 2.2 game_state 事件结构（服务器 → 前端）
```js
{
  players: { '玩家名': { dice: [1..6×5], kept: [bool×5], rollCount, scores: {类别:分}, previewScores: {...} } },
  playerOrder: ['玩家名', ...],   // 出招顺序（A005 修复后三处发送入口都必须带）
  currentPlayer: '玩家名',
  phase: 'playing' | 'finished',
  round: 1..13,
  allDice: { '玩家名': [...] },
  allScores: { '玩家名': {...} },
  allPreviewScores: { '玩家名': {...} }
}
```
- 发送入口共三处，结构必须保持一致：broadcastYahtzeeState（io.to 广播）、get_game_state（socket.emit 单发）、join_room 尾部（游戏已开始时 socket.emit 补发）。
- 前端全局：gameState / isMyTurn = (state.currentPlayer === myName)；updateUI 用 `order = state.playerOrder || Object.keys(state.players)` 兜底渲染。

### 2.3 updateUI 状态机与页面结构（0.6 版重构后约定）
- 页面区块（自上而下）：
  1. status：状态行（等待/轮到谁 + 第几轮/13）；
  2. `#playerStrips` 玩家实时状态条：每人一张 `.pstrip`（名字 + `.mdice` 5 颗小骰子 + 总分）；`me` 蓝框、`turn` 金框+🎲；观战者与所有玩家都能看到每人实时骰面（数据源 = gs.players[name].dice / kept）；
  3. `#diceArea` 我的大骰子操作区：自己是玩家且 phase=playing 才显示（kept 蓝框 / 非自己回合 locked）；观战者显示"👀 观战中"提示；
  4. 按钮行：rollBtn / submitBtn / rollInfo；
  5. `#scoreTable` 合并计分总表（行=类别，列=玩家）。
- 合并计分总表渲染规则（renderScoreTable）：
  - 类别行 = CATEGORIES（上半区 6 行 → 上半区小计 → 奖励 → 下半区 7 行 → 下半区小计 → 总分）；
  - 列 class：自己的列 `col-me`（浅蓝）、当前行动玩家的列 `col-turn`（浅黄 + 🎲）；
  - 格子内容优先级：已填分数 →（当前玩家可点时）previewScores 预览 `.pv` → `-`；
  - 可点格 `.pickable`（仅当前玩家自己的未填格，绿色描边），点选后 `.picked`（金色高亮，可再点取消）；
  - 本地选中变量 selectedCategory；提交按钮依赖它；game_state 中 currentPlayer 变化或该格已填时自动清空。
- `!gameState`（等待游戏开始）：status 等待文本 + renderInitialDice() 灰色骰子 + renderEmptyTable()（只有类别列）+ 按钮禁用。
- phase === 'finished' 时：status 文本 + `#resultPanel` 结算面板（renderResultPanel：按总分排名、同分同名次、🥇🥈🥉 + 冠军 🏆 + 自己行高亮 + 「返回房间」按钮 backToRoom）；中间操作区提示"本局已结束"；大计分总表仍保留展示。
- 脚本末尾必须调用一次 updateUI()，保证游戏开始前也有初始界面。
- 按钮规则：rollBtn 可用 = isMyTurn && rollCount < 3 && phase !== 'finished'；submitBtn 可用 = isMyTurn && selectedCategory && phase !== 'finished'。

### 2.4 计分类别与结算
- 类别：ones/sixes 上半区 6 项；threeOfAKind/fourOfAKind/fullHouse/smallStraight/largeStraight/yahtzee/chance 下半区 7 项；共 13 轮。
- 上半区 ≥ 63 分奖励 35 分（前端 getTotal 计算展示，服务端 1.6 中未落盘，后续做结算/记录时注意）。

---

## 3. 页面 / Socket 事件速查

| 页面 | 发出事件 | 监听事件 |
|------|---------|---------|
| public/index.html（登录） | login / guest_login | — |
| public/lobby.html（大厅） | get_online_users、heartbeat | online_users |
| public/room.html（房间） | join_room、heartbeat、take_seat、leave_seat、spectate、leave_spectate、toggle_ready、change_settings、start_game | room_update、game_start、host_changed |
| public/yahtzee.html（游戏） | get_game_state、yahtzee_action{roll/toggle_keep/select_category/submit_score}、heartbeat、return_room | game_state、room_update |

- heartbeat 统一格式：`socket.emit('heartbeat', playerName, isTest, inRoom)`，所有页面 connect 后立即发一次 + 每 10 秒一次（A003 修复后约定）。
- 账号体系（v0.8）：正式玩家密钥 aaaa/bbbb/cccc/dddd；测试账号密钥 test1~test4（名 测试者1~4），`login` 的 isTest 判定为 `key.startsWith('test')`，服务端 `TEST_NAMES` 用于开发者鉴权。
- 密钥安全约定（v0.9）：密钥只存在服务器端 VALID_KEYS；客户端（index/lobby/light/room/yahtzee 等任何 html）不得出现密钥明文或"名字→密钥"映射；刷新页面后的在线身份一律靠统一 heartbeat 心跳自动续接，不再自动重发 login。
- 身份标记约定（v1.1）：登录/切换账号时必须完整重置 sessionStorage 的 playerName / isGuest / isTest（游客登录强制 isTest='false'）；开发者工具（lobby 浮窗、yahtzee 直接结算）显示条件 = isTest && 非游客。
- 成就系统（v1.2）：正式玩家写 `data/achievements.json`，测试账号（测试者1~4）写 `data/test-achievements.json`；mock/模拟局不判定。服务器广播事件：`achievement_unlocked`{id,name,quality,playerName}（隐藏品质不广播）与 `achievement_summary`{players:{名:[{id,name,quality}]}}（结算时）。快艇重复快艇：`playerData.yahtzeeBonus += 100`（已填快艇格后的后续快艇）。前端 yahtzee.html 总分 = 上区 + 奖励35 + 下区 + yahtzeeBonus，计分表含"重复快艇奖励"行，结算面板显示本局成就汇总。
- 开发者工具「直接结算」：游戏页右下角 🧪 按钮（仅 isTest 显示）→ 填玩家与总分 → `socket.emit('dev_finish_yahtzee', { players:[{name,total}] }, cb)`。服务端校验 name ∈ TEST_NAMES，用 buildMockScores(total) 摊成 13 格模拟分，生成/覆盖一场 phase='finished' 对局并 `broadcastYahtzeeState`，无需打完 13 轮即可看结算界面（mock 局不判定成就不落盘）。
- 开发者工具「自定义本轮骰子」：`socket.emit('dev_set_dice', { name, dice:[5 个 1~6] }, cb)`（仅测试账号；name 为空=当前行动玩家）。服务端把它当作一次掷骰：rollCount+1、kept 重置、preview 刷新，并调用公共函数 `afterYahtzeeRoll()` 做即时成就判定（真实 roll 分支也用同一函数）。需对局进行中（phase='playing'）。
- change_settings 服务端规则：maxPlayers 必须 ∈ {2,3,4} 且 ≥ 当前已入座人数，失败经 `cb({success:false,msg})` 返回；前端收到失败要恢复下拉框为 serverMaxPlayers（A006 修复后约定）。
- room.html 交互提示约定（v1.0）：开始按钮始终可点，startGame 内做本地校验——非房主→toast 提示并阻止；人数 <2→toast 并阻止；有人未准备→toast 并阻止；人数 ≥2 但未满 maxPlayers→toast 提示后 1.2s 自动开始（不阻止）。提示统一用 `showToast()`（网页内小弹条，2.2s 自动消失），不使用浏览器 alert（仅"加入房间失败"这类致命错误保留 alert）。
- start_game：房主点击后服务端校验（≥2 人且全部 ready）→ initYahtzeeGame → broadcastRoom → broadcastYahtzeeState → 300ms 后 io.to(roomId) emit game_start{gameUrl}，前端收到后跳转游戏页。
- yahtzee_action 服务端校验顺序：name 存在 → 找到所在房间与游戏 → 必须是当前回合玩家 → phase 必须 playing；非法则直接 return。
