# 错误档案

> 本文档由 AI 助手维护（对应开发原则中的 Dev/error.md），实际路径：development/error.md。
> 规则：每次修改代码之前必须先阅读本文档，避免重复犯错。
> 每次新错误都要有专属错误编码（A000、A001、A002……依次递增），在对话框中用该编码定位问题。

---

## 一、错误编号占用表

| 错误编码 | 问题 | 位置 | 状态 |
|---------|------|------|------|
| A000 | 新玩家进房后其他人看不到，无法入座/观战 | server.js → join_room | 已修复（核实 2026-09-04） |
| A001 | 快艇骰子联机版初始不显示骰子和计分卡 | public/yahtzee.html → updateUI | 已修复（2026-09-04，版本 0.2） |
| A002 | 房主离线后房间状态未及时更新 | server.js → disconnect | 待优化（未开始） |
| A003 | 跳转/刷新后被误判离线踢出房间、在线状态混乱 | server.js → heartbeat/disconnect/removeOfflinePlayer | 已修复（2026-09-04，版本 0.3） |
| A004 | 进入快艇骰子页一直"等待游戏开始"，无法开始 | server.js → get_game_state | 已修复（2026-09-04，版本 0.4） |
| A005 | 快艇骰子显示"轮到你了"但无法掷骰子 | server.js → game_state 数据缺 playerOrder | 已修复（2026-09-04，版本 0.5） |
| A006 | 已入座 3 人时房主仍可把人数改成 2 | server.js → change_settings | 已修复（2026-09-04，版本 0.5） |
| A007 | 游戏结束后没有返回房间按钮、不显示冠军与排名 | server.js → return_room；public/yahtzee.html → 结算面板 | 已修复（2026-09-04，版本 0.7） |
| A008 | 玩家返回房间后同时显示在座位和观战席 | server.js → join_room | 已修复（2026-09-04，版本 0.9） |
| A009 | 前端页面出现密钥明文 | public/index.html / lobby.html / light.html | 已修复（2026-09-04，版本 0.9） |
| A010 | 游客登录后也看到开发者工具 | public/index.html / lobby.html / yahtzee.html | 已修复（2026-09-04，版本 1.1） |

> 下一个可用编码：**A011**

---

## 二、新增错误的书写格式（模板）

每个错误按下面格式写，一条一个 `##` 标题，编码接在占用表最后一个之后：

```markdown
## A003 — 一句话概括问题
- 错误编码：A003
- 状态：已修复 / 待修复 / 待优化
- 位置：文件名 → 函数 / 事件
- 错误现象：出现了什么问题（玩家/用户看到了什么现象）
- 错误原因：根本原因是什么
- 解决办法：具体是怎么改的（可贴关键代码）
- 如何避免：以后怎么防止再犯
```

**重要约定**：
1. 新增前先查「一、错误编号占用表」，从下一个空号开始编号，禁止重复占用（例如 git 未安装这类环境报错若真要记录，应从 A003 起，并注明是环境问题）。
2. A 系列编码只记录「项目代码 / 逻辑 / 用户反馈」的问题；终端环境命令的普通输出（如端口查询无结果）不是项目 bug，不占用编码。
3. 某条错误修复后，在对应明细里把「状态」改成"已修复"，并在 development/log.md 补一条版本日志。

---

## 三、错误档案明细

### A000 — 新玩家进房后其他人看不到，无法入座/观战
- 错误编码：A000
- 状态：已修复（核实日期 2026-09-04）
- 位置：server.js → join_room / syncRoomState / broadcastRoom
- 错误现象：新玩家加入房间后，房间内其他玩家看不到新成员，无法正确入座或观战。
- 错误原因：join_room 只调用了 syncRoomState（仅给新玩家本人发送状态），没有调用 broadcastRoom 广播给房间内所有人。
- 解决办法：
  1. join_room 中先 `syncRoomState(room, playerName)`：给新玩家本人发送带 mySeat / myReady 的状态；
  2. 再 `broadcastRoom(room)`：先 transferHost 处理房主转移，然后 `io.to(room.roomId)` 广播公共字段（roomId / hostName / maxPlayers / seats / spectators），再遍历 playerMap 给每个在线成员补发带个人 mySeat / myReady 的状态。
  - 现网代码位置：server.js join_room 事件末尾（`syncRoomState(room, playerName); broadcastRoom(room);`），另有每 3 秒 setInterval 全房间兜底广播。
- 如何避免：以后凡是房间级状态变更（入座、离座、观战、取消观战、准备、改人数、房主转移、踢人），一律调用 broadcastRoom(room)；只有「只给单个玩家发新增字段」时才用 syncRoomState(room, selfName)。

---

### A001 — 快艇骰子联机版初始不显示骰子和计分卡
- 错误编码：A001
- 状态：已修复（修改日期 2026-09-04，版本 0.2）
- 位置：public/yahtzee.html → updateUI
- 错误现象：进入快艇骰子页、游戏尚未开始时，页面只显示按钮，看不到骰子和计分卡。
- 错误原因：updateUI() 只在 socket.on('game_state')、selectCategory、viewOpponent 中被调用，页面加载时从未调用；gameState 为 null 时即使有渲染初始界面的代码也不会执行。
- 解决办法：
  1. 脚本末尾（`</script>` 前）新增一次 `updateUI()` 调用，页面加载即先渲染「等待游戏开始」界面；
  2. updateUI() 的 `!gameState` 分支调用 renderInitialDice()（渲染 5 颗灰色 `.die.locked` 骰子）和 renderInitialScorecard()（渲染 13 行 `-` 计分卡），同时清空 totalScores / playerTabs，并禁用 rollBtn / submitBtn、清空 rollInfo，再 return。
- 如何避免：凡是由 gameState 驱动的页面，页面加载后必须主动调用一次渲染入口；空状态分支不要直接 return，应先渲染默认占位 UI（灰色骰子 + 初始计分卡）。

---

### A002 — 房主离线后房间状态未及时更新
- 错误编码：A002
- 状态：待优化（未开始处理）
- 位置：server.js → disconnect / transferHost / leaveTimers
- 错误现象：房主断线后，座位 / 房主信息不会立刻变化，需等待约 30 秒宽限期（removeOfflinePlayer 触发）后才会移除并自动转移房主。
- 当前机制：disconnect 时不清除玩家，而是设置 `room.leaveTimers[name]`，30 秒后由 removeOfflinePlayer 真正移除座位 / 观战 / playerMap，并 transferHost + broadcastRoom；另有每 3 秒定时 broadcastRoom 兜底同步。
- 备注：该宽限期也可能是「断线重连」的有意设计，优化方案需先与用户确认后再实施，禁止擅自改动。

---

### A003 — 跳转/刷新后被误判离线踢出房间、在线状态混乱
- 错误编码：A003
- 状态：已修复（2026-09-04，版本 0.3）
- 位置：server.js → heartbeat / disconnect / removeOfflinePlayer；public/yahtzee.html、room.html、lobby.html
- 错误现象：
  1. 玩家从房间页跳转到快艇骰子页后，房间显示"无人/玩家离线"，约 30 秒后被"移除离线玩家"；
  2. 操作一个窗口时，另一个窗口（切后台或已跳游戏页）的玩家显示离线，刷新后才恢复。
- 错误原因：页面跳转/刷新会断开旧 socket、建立新 socket，但新连接不被服务器识别身份（游戏页不 login、不 join_room）；旧连接的 disconnect 会把玩家移出 onlineUsers 并安排 30 秒后移除；且只有 yahtzee.html 有心跳，房间页与大厅页都没有，服务器无法持续确认玩家在线。
- 解决办法：
  1. server.js heartbeat 升级为"身份自动续接"：记录 名字↔新socket、恢复 onlineUsers、inRoom=true 时把 playerMap 指向新 socket 并 socket.join(房间)、取消 leaveTimers；
  2. server.js disconnect 防误删：若同名已被另一条活跃连接接管则直接 return；
  3. server.js removeOfflinePlayer 加在线保险（force 缺省时 socket 活着就跳过）；leave_room 主动退出用 removeOfflinePlayer(room, name, true) 强制移除；
  4. 三个前端页面统一心跳：connect 立即发一次 + 每 10 秒一次，参数 (playerName, isTest, inRoom)；房间页/游戏页 inRoom=true，大厅 inRoom=false。
- 如何避免：凡是"刷新/跳转页面产生新连接"的流程，必须通过心跳或专门的续接事件把新连接与玩家身份/所在房间重新绑定；不要依赖页面不刷新生效的连接状态。

---

### A004 — 进入快艇骰子页一直"等待游戏开始"，无法开始
- 错误编码：A004
- 状态：已修复（2026-09-04，版本 0.4）
- 位置：server.js → get_game_state
- 错误现象：进入快艇骰子页后一直显示"等待游戏开始..."，拿不到游戏状态、无法掷骰/提交计分。
- 错误原因：服务器 get_game_state 在游戏存在时只用回调 cb 返回数据；但前端 `socket.emit('get_game_state', roomId)` 没有传 cb，且页面只监听 game_state 事件 → 数据永远发不到前端。
- 解决办法：服务器 get_game_state 改为直接 `socket.emit('game_state', 数据)`（结构与 broadcastYahtzeeState 完全一致），保留 cb 兼容其他调用方。
- 如何避免：前后端 Socket 事件约定要一致——凡是"前端靠监听某事件接收数据"的接口，服务器端必须 emit 该事件；回调 cb 只是可选补充，不能作为唯一返回通道。

---

### A005 — 快艇骰子显示"轮到你了"但无法掷骰子
- 错误编码：A005
- 状态：已修复（2026-09-04，版本 0.5）
- 位置：server.js → broadcastYahtzeeState / get_game_state / join_room；public/yahtzee.html → updateUI
- 错误现象：进入游戏页后能显示"轮到你了"，但掷骰/提交按钮点了没反应（按钮实际处于禁用态）。
- 错误原因：服务器三处发送 game_state 的数据都缺 playerOrder 字段；前端 updateUI 用 gs.playerOrder.map 渲染总分区/玩家标签 → 抛 TypeError，updateUI 在写完状态文本（第 1 步）后中断，后面"启用按钮/渲染骰子"的代码永远执行不到，按钮停留在加载等待态设的 disabled=true。
- 解决办法：
  1. 服务器三处 game_state 数据都补上 `playerOrder: game.playerOrder / gameData.playerOrder`；
  2. 前端 updateUI 加兜底 `const order = gs.playerOrder || Object.keys(gs.players);` 并改用 order.map。
- 如何避免：凡是"前端 JS 渲染依赖某个字段"的服务端数据，都要保证所有发送该事件的入口字段完整一致；前端关键渲染路径不要因为一个字段缺失就整段中断（可用兜底值）。

---

### A006 — 已入座 3 人时房主仍可把人数改成 2
- 错误编码：A006
- 状态：已修复（2026-09-04，版本 0.5）
- 位置：server.js → change_settings；public/room.html → changeMaxPlayers
- 错误现象：房间已有 3 人入座时，房主仍可把人数从 4 改成 2；改完后第 3 名玩家在 UI 上看不到座位，但仍占着服务器座位，start_game 仍会把他算进开局。
- 错误原因：change_settings 没有任何下限校验，直接把 maxPlayers 赋值。
- 解决办法：
  1. 服务端 change_settings 增加校验：maxPlayers 必须是 2/3/4，且不能小于"当前已入座人数"，失败通过 cb({success:false, msg}) 返回；
  2. 前端 changeMaxPlayers 接收回调结果，失败时 alert 提示并把下拉框恢复为服务器实际人数（新增 serverMaxPlayers 变量，room_update 时同步）。
- 如何避免：凡是"房间容量"类设置，服务端必须先算已占用量再校验；前端交互控件要以服务端实际状态为准，失败要回滚 UI。

---

### A007 — 游戏结束后没有返回房间按钮、不显示冠军与排名
- 错误编码：A007
- 状态：已修复（2026-09-04，版本 0.7）
- 位置：server.js → return_room / gameEndTimers；public/yahtzee.html → renderResultPanel / backToRoom
- 错误现象：游戏结束后只显示"你的总分 xx"，没有最终排名（冠军是谁），也没有返回房间的按钮。
- 错误原因：结算 UI 只更新了一行状态文字；缺少排名计算与展示；缺少"清理本局 + 跳回房间"的通道；且原"结算后 5 秒自动删对局"的定时器没有句柄管理，存在误删下一局的风险。
- 解决办法：
  1. 前端 renderResultPanel()：按总分排序生成结算面板（同分同名次、🥇🥈🥉、冠军 🏆 高亮、自己行高亮），并提供"返回房间"按钮；
  2. 前端 backToRoom()：emit `return_room` → 跳 /room.html?game=yahtzee（1.5s 兜底）；
  3. 服务端 return_room 事件：清结算定时器 → 删 yahtzeeGames[roomId] → 复位座位 ready → broadcastRoom；
  4. 服务端 gameEndTimers{}：管理"结算后自动清理"定时器；start_game / return_room 前先 clearTimeout，防旧定时器误删新局；兜底自动清理改 60 秒。
- 如何避免：任何"局结束 → 清理 → 重新开局"的流程，定时器必须持有句柄并在一局开始时清除；需要"看完结果再返回"的 UI 要提供显式出口，不要只改一行文字。

---

### A008 — 玩家返回房间后同时显示在座位和观战席
- 错误编码：A008
- 状态：已修复（2026-09-04，版本 0.9）
- 位置：server.js → join_room
- 错误现象：玩家点"返回房间"回到房间页后，既坐在原来的座位上，观战席列表里也有他。
- 错误原因：join_room 先判断"游戏进行中 / 座位已满"→ 满足就进观战；只有没进观战才检查"是否已在座"。当房间满座（如 4/4）或上一局刚结束时，玩家自己的座位还在但会因"满座/游戏进行中"被判成观战，于是出现 座位+观战 并存。
- 解决办法：把"是否已在座"的判断提前——已在座则保留座位并从观战名单移除（room.spectators filter 掉自己）；否则再按 游戏进行中或满座 → 观战、有空位 → 自动入座。
- 如何避免：座位归属判断永远优先于"容量/对局状态"判断；任何可能把玩家放进观战名单的路径，都要先排除"该玩家已在座"。

---

### A009 — 前端页面出现密钥明文
- 错误编码：A009
- 状态：已修复（2026-09-04，版本 0.9）
- 位置：public/index.html / lobby.html / light.html
- 错误现象：登录页提示明文密钥（aaaa/bbbb…、test1~test4）；lobby.html 与 light.html 的客户端 JS 里有"玩家名→密钥"映射表，任何查看网页源码的人都可拿到全部密钥。
- 错误原因：为了"刷新页面后自动重新登录"，前端在代码里内置了密钥映射。
- 解决办法：
  1. index.html 改为「🔒 密钥由管理员单独发放，请勿公开分享」；
  2. 删除 lobby.html / light.html 中的密钥映射与重发 login 逻辑；
  3. 刷新后的在线身份改由统一 heartbeat 心跳自动续接（服务器已支持按玩家名恢复 onlineUsers/socketToUser/房间绑定）。
- 如何避免：密钥只存在于服务器端 VALID_KEYS 与玩家的记忆中；客户端永不出现密钥明文或密钥映射；页面刷新后的身份恢复交给心跳/会话续接，而不是重新登录。

---

### A010 — 游客登录后也看到开发者工具
- 错误编码：A010
- 状态：已修复（2026-09-04，版本 1.1）
- 位置：public/index.html → 游客登录；public/lobby.html / yahtzee.html → 开发者工具显示条件
- 错误现象：用游客身份登录后，大厅角落的"🔧 开发者工具"或游戏页的"🧪 直接结算"仍然可见/可用。
- 错误原因：游客登录分支只写了 playerName 和 isGuest，没有重置 sessionStorage 的 isTest。若同一标签页之前登录过测试账号，残留的 isTest=true 使游客被当成测试账号。
- 解决办法：
  1. 游客登录时强制 `sessionStorage.setItem('isTest', 'false')`；
  2. 开发者工具的显示条件统一为"isTest 且非游客"（lobby 浮窗、yahtzee 直接结算按钮）。
- 如何避免：登录流程（正式/测试/游客）切换时必须完整重置身份标记（playerName / isGuest / isTest）；凡涉权限的 UI 显示条件用"白名单式"判断（必须同时满足），不要只依赖单个可残留的标记。





