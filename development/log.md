# 版本日志

> 本文档由 AI 助手维护（对应开发原则中的 Dev/log.md）。实际路径：development/log.md
> 版本号规则：每次修改后 +0.1。

---

## 版本 4.4（2026-09-05）
- 新增 p2/p3/p4 专属主题；统一主题引擎（粉/绿强调+各素材背景）；主题名：p1我永远都是我o、p2神秘粉毛、p3摸鱼ing、p4人生喵喵又咪咪。



### 修改文件
- server.js
- public/achievements.html
- public/settings.html
- public/lobby.html

### 修改原因
1. 修复荣誉墙"一直加载中"：主题脚本此前插在 socket 定义之前导致 JS 报错中断；已移到 socket 之后；
2. 测试账号可体验 p1 主题：get_profile 的 allowedThemes 对测试者追加 p1；update_profile 权限拆分（昵称仅正式玩家、测试者只能改主题体验）；settings 相应显示主题区并提示；
3. 大厅 p1 粉色补充：竞技锦标赛/娱乐赛链接、玩家"在线"文字改为粉色。

### 当前版本
- 4.3（上个版本 4.2，+0.1）



### 修改文件
- public/room.html / timeline.html / achievements.html / messages.html / yahtzee.html / lobby.html / settings.html

### 修改原因
1. p1（玩家1素材）主题铺到全站页面：
   - 房间、时光墙、荣誉墙、留言板、快艇骰子、设置：body.theme-p1 素材背景 + 粉色点缀（房间深灰"开始游戏"按钮→粉、占座/就绪/你 标签粉色系；留言板/荣誉墙切换标签蓝→粉；大厅快艇下划线→浅粉；游戏返回大厅/掷骰按钮粉；toast 粉深色）；
   - 各页面新增 applyTheme：按个人主题给 body 加 theme 类（未选 p1 保持原配色）；
2. 其它玩家主题素材到位后按同一套规则单独配色。

### 当前版本
- 4.2（上个版本 4.1，+0.1）



### 修改文件
- public/lobby.html
- public/assets/avatars/p1/（用户更新为 sticker1~4.png 透明 PNG；移除复制用 avif）

### 修改原因
1. 表情贴纸改用透明 PNG 版（用户提供）：引用改为 .png、移除 mix-blend-mode（透明后无需混合弱化），保留点击轮换与左下角展示；清理旧 sticker*.avif 副本。

### 当前版本
- 4.1（上个版本 4.0，+0.1）



### 修改文件
- public/lobby.html

### 修改原因
1. 手机端从其它页面返回大厅丢主题/贴纸：大厅监听 pageshow 与 visibilitychange，返回/切回标签页时自动重新应用主题与显示名（无需手动刷新）；
2. 表情贴纸改为：左下角只放一枚，点击可轮换 4 个表情（stickerNext）；用 mix-blend-mode:multiply 弱化白色背景（真正透明需用工具抠成透明 PNG，前端无法凭空去白底）。

### 当前版本
- 4.0（上个版本 3.9，+0.1）



### 修改文件
- server.js
- public/settings.html
- public/lobby.html

### 修改原因
1. 专属主题归属限制：OWNER_THEME（玩家1→p1）；get_profile 返回 allowedThemes；update_profile 拒绝他人使用专属主题；设置页只渲染当前账号可用的主题；
2. 大厅主题/显示名应用加固：body 主题 class 改为通用 theme-*，启动/连接后重试拉取 profile 与显示名（600ms 保险），降低"切了没效果"的时序问题。

### 当前版本
- 3.9（上个版本 3.8，+0.1）



### 修改文件
- server.js
- public/settings.html
- public/lobby.html
- public/assets/avatars/（新建素材库：p1~p4 + README；p1 已放背景 beijing.png.jpg 与 4 个小表情，已复制为 sticker1~4.avif 便于引用）

### 修改原因
1. 专属 UI 第一版（玩家1素材主题 p1）：
   - server THEMES 增加 'p1'；
   - 设置页主题区改为可切换列表「初始配色 / 玩家1专属主题」，选择即实时预览背景；
   - 大厅应用 p1 主题：背景 beijing 半透明白叠层 + 右下 4 个缩小表情贴纸（54px）；按 profile.theme 切换/恢复；
   - p2~p4 素材加入后按同机制扩展。

### 当前版本
- 3.8（上个版本 3.7，+0.1）



### 修改文件
- server.js
- public/timeline.html（新建）
- public/lobby.html

### 修改原因
1. 📜 时光墙上线：
   - server：时光墙时间线（内存 + PERSIST_TIMELINE 正式落盘开关，最多保留 300 条）；整局真实结算时记录正式玩家的比赛（含分数/排名），正式玩家成就"新解锁/再次达成"时记录成就时刻；get_timeline 查询（最新在前）；
   - 新建 timeline.html：轻量列表——比赛条目显示"时间 + 谁游玩了【游戏】"+ ▸ 展开名次与分数；成就条目显示"时间 + 谁获得成就「名」"（按品质着色）；游客自动拦截；
   - 大厅"功能"区时光墙入口跳转真实页面。

### 当前版本
- 3.7（上个版本 3.6，+0.1）



### 修改文件
- server.js
- public/settings.html

### 修改原因
1. 主题配色收敛为单一"初始"灰色：server THEMES 仅保留 initial；设置页只剩一个灰色圆点并注明"专属 UI 素材到位后再扩充可选主题"。

### 当前版本
- 3.6（上个版本 3.5，+0.1）



### 修改文件
- server.js
- public/room.html
- public/yahtzee.html

### 修改原因
1. "游戏进行中房间体验"（对局中进房）：
   - server：room_update/syncRoomState 增加 gameStarted / gamePlayers；join_room 调整——对局进行中，本局玩家再次进房不入座也不进观战（前端给"返回游戏"），非本局玩家自动进观战；
   - room.html：新增"对局中视图"——游戏进行中时隐藏入座/准备/人数设置等开赛操作，显示"本局进行中"与入口按钮（本局玩家=返回游戏 / 非玩家=进入观战），座位与观众列表始终可见；
   - 补充 enterGame()：玩家/观战点击后跳回快艇游戏页。
2. 游戏页（yahtzee.html）顶部新增"返回大厅"（玩家与观战者都可用；对局中离开会先确认并 leave_room）。

### 当前版本
- 3.5（上个版本 3.4，+0.1）



### 修改文件
- public/room.html
- public/yahtzee.html
- public/achievements.html
- public/messages.html
- public/lobby.html

### 修改原因
1. "显示名"全站统一（你问的"做个变量"→ 采用 `dn(内部名)` 统一翻译函数）：
   - 服务器仍用内部名（玩家1~4）做逻辑与身份；前端每个页面 connect 后拉取一次 get_display_names，渲染名字处统一走 `dn()`（无昵称则显示原名）。
   - 覆盖：房间（房主/座位/观战）、游戏页（玩家条/计分表表头/轮到谁/结算排名/成就横幅/本局成就）、荣誉墙（成就记录玩家名）、留言板（留言者名/游客判定保持内部名）、大厅（顶部/状态卡/留言摘要，之前 v3.3 已做并补摘要）。
   - 逻辑比较（mySeat、currentPlayer、isAlreadySeated 等）仍用内部名，避免错乱。

### 当前版本
- 3.4（上个版本 3.3，+0.1）



### 修改文件
- server.js
- public/settings.html（新建）
- public/lobby.html

### 修改原因
1. ⚙️ 设置 / 用户档案第一版：
   - server：`data/users.json` 正式玩家档案（昵称/主题，落盘保留）；get_profile / update_profile / get_display_names 事件；昵称限 12 字、唯一性校验；预置主题 THEMES（initial/ocean/forest/violet/sunset，先保存，视觉随"专属 UI"阶段应用）；
   - 新建 settings.html（简洁风格：下划线式昵称输入 + 主题色块选择 + 保存）；游客/测试者提示无档案权限；
   - 大厅接入：顶部昵称与四人状态卡改用档案显示名（未设置昵称则显示原名）。
2. 大厅"设置"入口由"施工中"改为跳转 settings.html。

### 当前版本
- 3.3（上个版本 3.2，+0.1）



### 修改文件
- public/index.html

### 修改原因
1. 游客口令输入区精简：去掉输入框边框与"确认进入"按钮，改为一行透明的"下划线式"小输入（placeholder：输入游客口令，回车进入），回车提交，符合简洁 UI 规范。

### 当前版本
- 3.2（上个版本 3.1，+0.1）



### 修改文件
- server.js
- public/index.html
- public/connection.html

### 修改原因
1. 游客通道加口令（安全）：
   - server 新增 `GUEST_KEY = '12345'`（暂定，以后只改这里即可）；
   - guest_login 增加口令参数校验，错误返回"游客口令错误"；
   - index 登录页：点"游客登录"小蓝字后展开"输入游客口令 + 确认进入"（回车可提交）；
   - connection.html（连接测试工具）同步兼容（prompt 输入口令）。

### 当前版本
- 3.1（上个版本 3.0，+0.1）



### 修改文件
- public/index.html
- public/room.html

### 修改原因
1. 登录页去除白色卡片框：无边框、无阴影，只有居中的标题、输入框、登录按钮与游客小蓝字；
2. 房间页"返回大厅"改为彻底离开房间（emit leave_room：离座/取消观战并移出房间），不再只是"离开座位"；回大厅后由心跳自动恢复在线；
3. 人数提示文案：开不了局 →「少人？人数还不够（至少 2 人才能开局）」；未满员自动开局前 →「多人？人数还没满，马上开始！」（后文保持不变）。

### 当前版本
- 3.0（上个版本 2.9，+0.1）



### 修改文件
- public/index.html
- public/lobby.html
- development/good.md

### 修改原因
1. 登录页：游客入口去掉背包 emoji，改为"一行小蓝字（带下划线）"位于主按钮下方；
2. 大厅去"卡片盒子"化：四张玩家状态卡、游客按钮、留言摘要全部转为纯文本+细分隔符风格（去掉白底卡/边框/虚线盒）；窄屏字号同步收紧；
3. good.md 新增「UI 通用规范」：之后 UI 尽量不用卡片、少用装饰表情，文字链接式简洁风格。

### 当前版本
- 2.9（上个版本 2.8，+0.1）



### 修改文件
- public/lobby.html

### 修改原因
1. 玩家状态卡：只显示"在线 / 离线"（去掉离线时间的单行合并方案，时间展示留给"个人空间/用户档案"里程碑统一做）；
2. 游客视角的大厅留言摘要改为：显示"最近有留言的三个游客"，每人各显示其最新一条（按留言时间取最新三位）。

### 当前版本
- 2.8（上个版本 2.7，+0.1）



### 修改文件
- public/lobby.html
- public/messages.html
- public/achievements.html

### 修改原因
1. 大厅"最新留言"摘要升级：正式玩家视角显示每位正式玩家（玩家1~4）的最新一条留言（按玩家顺序排列、实时更新、无留言则不显示该行）；游客视角仍显示游客板最新一条。
2. 留言板：正式玩家切到「游客留言」区时隐藏输入框并提示"仅游客可以在游客留言区留言"（游客区游客仍可发）。
3. 荣誉墙的游戏切换标签改为与留言板一致的"蓝字+下划线"样式（去黑框）。
4. 玩家状态卡：离线时间合并为单行"离线 · MM/DD HH:MM"（去掉独立的 last-seen 行，超长省略号截断）。

### 当前版本
- 2.7（上个版本 2.6，+0.1）



### 修改文件
- public/messages.html
- public/lobby.html

### 修改原因
1. 修复留言"未识别到身份"：messages.html 是独立新页面/新连接，补充与其它页面一致的心跳续接（connect 立即 + 每 10 秒）。
2. 留言板按身份默认选中对应板（正式=玩家留言，游客=游客留言），切换标签改为蓝色文字+下划线样式（去掉黑框底）。
3. 大厅删除主页装饰表情：设置按钮去 ⚙️、在线状态去 🟢/⚫、游客列表去 🎒（保留功能性文字）。

### 当前版本
- 2.6（上个版本 2.5，+0.1）



### 修改文件
- server.js
- public/messages.html（新建）
- public/lobby.html

### 修改原因
1. 💬 留言板上线：
   - 服务端：留言数据内存存储（重启即清空，正式版可仿照 PERSIST 加落盘），每板最多保留 120 条；新增 get_board（返回玩家/游客两板）、post_board_message（游客→游客板、正式玩家/测试者→玩家板，最多 100 字，实时广播 board_new）。
   - 新建 messages.html：轻量风格；正式玩家可切换「玩家留言 / 游客留言」，游客只显示游客板；实时收发；用 textContent 防注入。
   - 大厅"留言板"区块接真：显示最新留言摘要（正式看玩家板、游客看游客板），board_new 实时更新；点击摘要或"查看全部"进入 messages.html。

### 当前版本
- 2.5（上个版本 2.4，+0.1）



### 修改文件
- server.js
- public/lobby.html

### 修改原因
1. 删除所有成就名的前置表情（🎲⭐🐢🔄🏠📊🤝🎰💀 等），成就名恢复纯文字（影响荣誉墙 / 游戏内成就横幅 / 结算汇总 / test-panel 列表，数据源均为 server ACHIEVEMENTS meta）；
2. 大厅顶栏：昵称移到最左边（去掉 👤 前缀），⚙️ 设置 与 退出 保持右侧一组。

### 当前版本
- 2.4（上个版本 2.3，+0.1）



### 修改文件
- public/test-panel.html

### 修改原因
1. 修复开发者助手"一键触发"提示"仅测试账号可使用"的问题：
   - 根因：test-panel 是新开页面/新连接，服务器不认识当前连接对应哪位玩家（缺少身份续接），test_trigger_achievement 查不到 socketToUser 映射；
   - 改动：test-panel 补上与其它页面一致的心跳（connect 立即 + 每 10 秒，isTest=true、inRoom=false），让服务器识别当前测试账号身份。
2. 说明：无需在页面写出 test1~test4 具体密钥；登录时输入任意 test1~test4 均可。

### 当前版本
- 2.3（上个版本 2.2，+0.1）



### 修改文件
- server.js
- public/achievements.html
- public/test-panel.html
- development/notes/cj/cj.md（存储/测试者规则同步）

### 修改原因
1. 荣誉墙页面调整：标题放最左、"返回大厅"放最右；新增"游戏筛选"按钮（快艇骰子 / 更多游戏=暂无成就占位，按 meta.game 过滤）。
2. 开发者助手（test-panel）一键触发成就真正打通：option 对齐服务器 ACHIEVEMENTS id，新增 test_trigger_achievement 事件（仅测试账号），触发写内存不落盘，并加"查看荣誉墙"按钮。
3. 存储规则收紧：正式玩家仅在 PERSIST_ACHIEVEMENTS=true 时写 data/achievements.json；测试账号**永远只存内存**（重启即刷新，同"最后上线时间"等内存态数据）；废弃 test-achievements.json（不读不写）。
4. get_achievements 返回 list（正式）+ testList（测试）；荣誉墙：测试账号登录时合并显示测试记录（带"测试"小标），正式玩家看不到测试数据。

### 当前版本
- 2.2（上个版本 2.1，+0.1）



### 修改文件
- server.js

### 修改原因
1. 按用户要求引入**成就持久化开关** `PERSIST_ACHIEVEMENTS`：
   - 开发/测试期 = false：成就只存内存，荣誉墙可显示、**重启即刷新**、不读写 data/；
   - 正式版上线时改为 true：自动恢复"读入 + 双文件写入"（正式/测试分文件逻辑保留，无需返工）。
2. 说明："最后上线时间"属于用户档案体系（data/users.json），尚未落盘，重启重置属预期，正式版做设置/用户档案里程碑时统一持久化。

### 当前版本
- 2.1（上个版本 2.0，+0.1）



### 修改文件
- server.js
- public/achievements.html（新建）
- public/lobby.html

### 修改原因
1. 🏅 荣誉墙正式上线（第一个从"施工中"变为可用的功能入口）：
   - 成就记录新增每次触发的 events 时间明细（兼容旧数据，无 events 时展开显示首/最近时间）；
   - server 新增 `get_achievements` 事件：返回正式玩家成就记录 + 成就元数据；
   - 新建 public/achievements.html：按 good.md 规则渲染——只显示有正式玩家触发的成就；按品质 传说→史诗→稀有→普通→隐藏 分组；同成就玩家按首次触发时间早者在前；默认显示"玩家 x次数 首触时间"，▸ 可展开每次触发时间明细；返回大厅入口；游客/未登录自动拦截。
   - 大厅"功能"区的荣誉墙链接改为跳转真实页面。

### 当前版本
- 2.0（上个版本 1.9，+0.1）



### 修改文件
- public/room.html

### 修改原因
1. 房间页彻底去除"花花绿绿 + 一堆表情"观感（上一版只加了 CSS 覆盖，用户反馈仍不够）：
   - 按钮全部改为统一中性浅色（白底灰字细边框，hover 变浅灰），仅"开始游戏"用深灰实心作唯一主操作；去掉五颜六色的 btn-primary/success/warning/outline 配色与阴影；
   - 移除按钮/座位/观战/返回/标题上所有装饰 emoji（🪑👀✅▶️🚪🏠⏳👀🎒← 等），按钮为纯文字；
   - 座位渲染：房主/自己改为小文字标签（房主=浅金、你=浅蓝），状态用纯文字"已准备/未准备"（就绪座位配极淡绿底）；
   - 页面标题去 emoji。

### 当前版本
- 1.9（上个版本 1.8，+0.1）



### 修改文件
- public/lobby.html
- public/room.html

### 修改原因
1. 大厅「功能」五个链接改为**一行等宽排列**（flex nowrap + flex:1），手机窄屏也保持一行（字号略缩）；
2. 房间页 room.html 套用大厅 v2.1 轻量风格：内容统一 max-width 620 居中、去除大阴影与标题 emoji（🏠）、座位卡改小而轻盈、设置/观战/按钮/返回链接改为同款小字浅色风。

### 当前版本
- 1.8（上个版本 1.7，+0.1）



### 修改文件
- public/lobby.html

### 修改原因
1. 主页排版 v2.1（用户反馈调整）：
   - 去掉深色顶部条与「🏰 我们的专属游戏室」大字，改为右上角浅色小行（昵称 / ⚙️设置 / 退出，均为文字/下划线样式）；
   - 去掉大卡片式分块，改为窄内容列 + 细分隔线的轻量布局；
   - 模块顺序：在线状态 → 比赛（竞技锦标赛 / 娱乐赛·骰子大乱斗）→ 开始游戏 → 功能（小字链接列表）→ 留言板（保持原样，位于最底部）；
   - 去除非留言板/设置模块的多余 emoji（游客按钮、快艇入口、节标题、功能链接均去图标化）；
   - 功能改为文字链接（小字可点），点击仍弹「🚧 施工中」。

### 当前版本
- 1.7（上个版本 1.6，+0.1）



### 修改文件
- development/good.md
- public/lobby.html

### 修改原因
1. good.md 新增「主页（大厅）与系统功能细化需求 v2.0」：设置（昵称/主题/专属UI）、荣誉墙、时光墙、个人空间、排行榜、留言板的详细展示规则 + 主页排版要求。
2. 大厅主页排版重构（第一批，仅布局与占位按钮）：
   - 顶部导航栏：Logo「🏰 我们的专属游戏室」+ 昵称 + ⚙️ 设置 + 🚪 退出；
   - 在线状态卡（四人同行）＋游客展开；
   - 新增「功能与服务」按钮组：荣誉墙 / 时光墙 / 个人空间 / 排行榜 / 留言板 / 默契空间 / 竞技锦标赛 / 骰子大乱斗——点击弹「🚧 施工中」toast，暂不跳转；
   - 留言板"最新留言"摘要占位卡；
   - 游客视角自动隐藏仅正式玩家可见的按钮（data-guest-hide：荣誉墙/时光墙/个人空间/默契空间/锦标赛）。

### 当前版本
- 1.6（上个版本 1.5，+0.1）



### 修改文件
- public/lobby.html

### 修改原因
1. 按用户决定：移除大厅的「⚡ 拍灯大作战」入口，大厅只保留快艇骰子入口（快艇骰子联机版宣告完成）。

### 当前版本
- 1.5（上个版本 1.4，+0.1）



### 修改文件
- public/lobby.html
- public/room.html
- public/yahtzee.html
- public/index.html

### 修改原因
1. 大厅四张角色卡改为**强制同一行**（flex nowrap + flex:1 伸缩，窄屏自动压缩），不再折行；
2. 房间四个座位同样强制同一行（flex nowrap + flex:1），窄屏下缩小内边距与字号；
3. 快艇计分总表**调窄**：容器 max-width 880→760、表格 min-width 560→440、字号与单元格内边距减小，横向滚动大幅缩短；
4. index 登录框加 max-width:92vw（手机小屏不溢出）。

### 当前版本
- 1.4（上个版本 1.3，+0.1）



### 修改文件
- server.js
- public/yahtzee.html

### 修改原因
1. 开发者工具支持"自定义本轮骰子"（定点测试即时成就）：
   - 服务器新增 `dev_set_dice` 事件（仅测试账号）：可指定玩家（默认当前行动玩家），把 5 颗骰子设为指定 1~6 点数，当作一次掷骰（rollCount+1、kept 重置、刷新预览、触发即时成就）。
   - 抽出公共函数 `afterYahtzeeRoll()`：真实掷骰与 dev_set_dice 共用同一套即时成就判定（Yahtzee！/一发入魂/？！艇艇），保证行为一致。
   - 开发者面板新增骰子区：5 个点数输入框 + 快捷预设（快艇/葫芦/三条/小顺）+ 玩家下拉；打开面板或状态更新时自动刷新玩家列表。
2. 掷骰即时成就判定逻辑从 roll 分支抽取为可复用函数，避免两处逻辑漂移。

### 当前版本
- 1.3（上个版本 1.2，+0.1）



### 修改文件
- server.js
- public/yahtzee.html
- development/notes/cj/cj.md（补充落地约定）
- development/notes/cj/cj1.md（标注判定时机）
- data/achievements.json + data/test-achievements.json（首次触发成就时自动创建）

### 修改原因
1. 实现集中式成就总管（照 cj.md）：`ACHIEVEMENTS` 元数据表、`recordAchievement`（正式→achievements.json / 测试账号→test-achievements.json 双文件）、`announceAchievement`（记录+本局去重播报+隐藏不实时）、`broadcastAchievementSummary`（结算汇总）。
2. 快艇对局结构扩展：每玩家 `yahtzeeBonus / yahtzeeCount / submitLog`；对局级 `comboMap / achievementsByPlayer / mock`。
3. 实现「重复快艇 +100」：已填快艇格后再投快艇，yahtzeeBonus += 100 计入总分。
4. 12 个成就触发点全部接入（即时：Yahtzee！/一发入魂/？！艇艇/龟速填分/重掷大师/上层建筑/葫芦兄弟；结算：250/300/认真的吗/同分异构/座无虚席）；dev 开发者工具生成的 mock 局不判定成就不落盘。
5. 前端 yahtzee.html：总分计算含 yahtzeeBonus，计分表加"重复快艇奖励"行；新增成就即时横幅（稀有+彩色边框）；结算面板显示"🏅 本局成就"汇总（谁达成）；新一局开始清空旧汇总。

### 当前版本
- 1.2（上个版本 1.1，+0.1）



### 修改文件
- public/index.html
- public/lobby.html
- public/yahtzee.html

### 修改原因
1. 修复 Bug A010「游客登录后也看到开发者工具」：
   - 根因：游客登录分支没有重置 sessionStorage 的 isTest，若同一标签页此前登录过测试账号，残留的 isTest=true 会让游客被当成测试账号。
   - 改动：
     a. index.html 游客登录时强制 `sessionStorage.setItem('isTest', 'false')`；
     b. lobby.html 开发者工具浮窗显示条件加 `isGuest !== 'true'`；
     c. yahtzee.html「🧪 直接结算」按钮初始化条件加 `isGuest !== 'true'`（游客一律不显示）。

### 当前版本
- 1.1（上个版本 1.0，+0.1）



### 修改文件
- public/room.html
- public/index.html

### 修改原因
1. room.html 新增网页内小提示（toast）组件，替代浏览器 alert / 静默无反应：
   - 非房主点"开始游戏" → 弹「🤨 这个房是你的吗？只有房主能开始游戏」（阻止）；
   - 人数不足 2 人点开始 → 弹「😅 等等我们的神偷大人！人数还不够」；
   - 有人未准备点开始 → 弹「😤 有玩家未准备 (#`O′)...」（阻止）；
   - ≥2 人但未满员点开始 → 弹「🤫 等等我们的神偷大人！人数还没满，马上开始！」（按用户选择：仅提醒不阻止，1.2 秒后自动开局）；
   - 把人数从多人切到更少（服务器拒绝时）→ 弹「多人？当前已有 X 人入座...」替代原 alert。
   - 开始按钮改为始终可点，由 startGame 内做本地校验并提示；latestRoom 缓存最近一次房间状态供校验。
2. index.html 登录页删除"密钥由管理员发放"提示行（用户要求：什么提示都不写）。

### 当前版本
- 1.0（上个版本 0.9，+0.1）



### 修改文件
- server.js
- public/index.html
- public/lobby.html
- public/light.html
- public/yahtzee.html（仅注释）

### 修改原因
1. 修复 Bug A008「玩家返回房间后同时显示在座位和观战席」：
   - 根因：join_room 先把"游戏进行中 / 座位已满"放在前面判断，已在座的玩家在满座（如 4/4）或上一局刚结束时会被判成观战，而他的座位仍在。
   - 改动：join_room 入座逻辑改为「先判断是否已在座」——已在座则保留座位并从观战名单移除；否则再按 游戏进行中/满座 → 观战、有空位 → 自动入座。
2. 修复安全缺陷 A009「前端页面出现密钥明文」：
   - 删除 index.html 登录页明示的密钥提示，改为「🔒 密钥由管理员单独发放」；
   - 删除 lobby.html / light.html 客户端 JS 中的"玩家名→密钥"映射表与重发 login 逻辑（首次登录只在 index.html 完成，刷新后的在线身份由 heartbeat 心跳自动续接）；
   - light.html 补上与其它页面一致的统一心跳；清理 yahtzee.html 注释中的密钥字样。

### 当前版本
- 0.9（上个版本 0.8，+0.1）



### 修改文件
- server.js
- public/index.html
- public/yahtzee.html

### 修改原因
1. 测试账号扩展为 4 个：VALID_KEYS 由单个 `test` 改为 `test1~test4`（对应 测试者1~4）；login 的 isTest 判断改为 `key.startsWith('test')`；新增 TEST_NAMES 常量供鉴权。
2. 新增开发者工具「直接结算」：服务端 `dev_finish_yahtzee` 事件（仅测试账号可调）——前端传入 [{name, total}]，服务器用 buildMockScores() 把总分摊成 13 格模拟计分卡，生成/覆盖一场 phase='finished' 的对局并广播，所有人立刻看到最终排名结算界面（无需打完 13 轮）。
3. yahtzee.html 右下角为测试账号显示「🧪 直接结算」浮动工具：可增删玩家行、填总分、一键结束；等待态也能用（无需先开局）。
4. index.html 登录页加测试密钥提示（test1 ~ test4）。

### 当前版本
- 0.8（上个版本 0.7，+0.1）



### 修改文件
- server.js
- public/yahtzee.html

### 修改原因
1. 修复 Bug A007「游戏结束后没有返回房间按钮、只显示自己的分、不显示冠军与排名」：
   - 新增结算结果面板（renderResultPanel）：按总分对玩家排序，同分同名次，冠军 🏆 高亮，自己的行浅蓝底，显示 🥇🥈🥉/名次 + 分数 + 「🚪 返回房间」按钮。
   - 新增 backToRoom()：先 emit `return_room` 让服务器清理本局，再跳回 /room.html?game=yahtzee（1.5 秒兜底跳转）。
   - 服务器新增 `return_room` 事件：清除结算清理定时器 → 删除 yahtzeeGames[roomId] → 复位所有座位 ready=false → broadcastRoom。
   - 新增全局 gameEndTimers{} 管理"结算后自动清理"定时器，start_game 与 return_room 都会先清旧定时器，防止上一局的定时器误删新开对局；兜底自动清理由 5 秒放宽到 60 秒（正常流程由玩家点返回立即清理）。

### 当前版本
- 0.7（上个版本 0.6，+0.1）



### 修改文件
- public/yahtzee.html（布局重构，纯前端，无服务端改动）

### 修改原因
1. 体验优化 1：计分卡由"个人卡 + 单对手切换"改为「合并计分总表」——行 = 13 个计分类别 + 小计/奖励/总分汇总行，列 = 每位玩家（最多 4 列），外层 overflow-x:auto 防挤压；当前行动玩家整列高亮（🎲），自己列浅蓝底区分。
2. 体验优化 2：新增「玩家实时状态条」（playerStrips）替代原 totalScores——每位玩家一张小卡（名字/行动标记/5 颗实时小骰子/总分），掷骰者一掷，广播一到，其他玩家与观战者都能实时看到他的骰子。
3. 体验优化 3：计分格子选中高亮——点选后格子变金色 .picked，再点同一格可取消；previewScores 以浅蓝 .pv 显示在当前玩家可点的格子里。
4. 移除的旧元素/函数：totalScores、playerTabs、viewOpponent、opponentArea、opponentScorecard、renderInitialScorecard 等；新增 renderPlayerStrips / renderMyDice / renderScoreTable / renderEmptyTable。

### 当前版本
- 0.6（上个版本 0.5，+0.1）



### 修改文件
- server.js
- public/yahtzee.html
- public/room.html

### 修改原因
1. 修复 Bug A005「快艇骰子显示'轮到你了'但无法掷骰子」：
   - 根因：服务器三处发送 game_state（broadcastYahtzeeState、get_game_state、join_room 尾部）的数据里都缺 playerOrder 字段，而前端 updateUI 用 gs.playerOrder.map 渲染总分区/玩家标签 → 抛 TypeError，updateUI 在显示状态文本后中断，掷骰/提交按钮的启用代码永远执行不到（按钮停留在等待态的 disabled）。
   - 改动：三处 game_state 数据都补 `playerOrder`；前端 updateUI 增加兜底 `const order = gs.playerOrder || Object.keys(gs.players)`。
2. 修复 Bug A006「已入座 3 人时房主仍可把人数改成 2」：
   - 根因：change_settings 没有任何下限校验，导致 maxPlayers 小于已入座人数（第 3 个玩家 UI 消失但仍占座位，且 start_game 仍会带他开局）。
   - 改动：服务端 change_settings 增加校验（2/3/4 且 maxPlayers >= 已入座人数，失败经 cb 返回错误信息）；前端 room.html 在失败时 alert 提示并把下拉框恢复为服务器实际人数（新增 serverMaxPlayers 变量，room_update 时同步）。

### 当前版本
- 0.5（上个版本 0.4，+0.1）



### 修改文件
- server.js

### 修改原因
1. 修复已知 Bug A004「进入快艇骰子页后一直'等待游戏开始'，无法开始」：
   - 根因：服务器 get_game_state 事件在游戏存在时只用回调 cb 返回数据，但前端 yahtzee.html 的 `socket.emit('get_game_state', roomId)` 没有传 cb，且页面只监听 game_state 事件 → 游戏状态永远收不到，gameState 恒为 null。
   - 改动：服务器 get_game_state 改为直接 `socket.emit('game_state', 数据)`（与 broadcastYahtzeeState 结构一致），保留 cb 兼容。

### 当前版本
- 0.4（上个版本 0.3，+0.1）

---

## 版本 0.3（2026-09-04）

### 修改文件
- server.js
- public/yahtzee.html
- public/room.html
- public/lobby.html

### 修改原因
1. 修复 Bug A003「玩家从房间页跳转到游戏页/刷新页面后被误判离线踢出房间，在线状态混乱」：
   - 根因：页面跳转/刷新会断开旧 socket、建立新 socket，但新连接不被服务器识别（不 login/不 join_room），旧连接的 disconnect 会把玩家移出 onlineUsers 并安排 30 秒后移除，且只有 yahtzee.html 有心跳、房间页与大厅页都没有。
   - server.js 改动：
     a. heartbeat 升级为"身份自动续接"：收到心跳时记录 名字↔新socket、恢复 onlineUsers、若 inRoom=true 则把 playerMap 指向新 socket 并 socket.join(房间) 且取消 leaveTimers；
     b. disconnect 增加防误删：若同名已被另一条活跃连接接管则直接 return，不删在线、不排队移除；
     c. removeOfflinePlayer 增加在线保险（force 缺省时 socket 还活着就跳过移除）；leave_room 主动退出改为 removeOfflinePlayer(room, name, true) 强制移除。
   - 前端改动：yahtzee.html / room.html / lobby.html 统一加心跳（connect 立即发一次 + 每 10 秒），携带 (playerName, isTest, inRoom) 三个参数；房间/游戏页 inRoom=true，大厅 inRoom=false。

### 当前版本
- 0.3（上个版本 0.2，+0.1）



### 修改文件
- public/yahtzee.html

### 修改原因
1. 修复已知 Bug A001「快艇骰子联机版初始不显示骰子和计分卡」：
   - 根因：页面加载时从未调用 updateUI()。updateUI() 只在收到 game_state、selectCategory、viewOpponent 时才触发，导致 gameState 为 null 时渲染初始界面的分支根本不会执行，游戏开始前页面只剩按钮。
   - 改动 1：在脚本末尾（`</script>` 前）新增一次 `updateUI()` 调用，让页面加载即渲染「等待游戏开始」界面。
   - 改动 2：在 updateUI() 的 `!gameState` 分支补充 rollBtn / submitBtn 禁用、rollInfo 清空，使等待状态的界面更一致。
2. 核实已知 Bug A000「新玩家进房后其他人看不到，无法入座/观战」的修复已存在于 server.js：
   - server.js → join_room 中已同时调用 `syncRoomState(room, playerName)` 与 `broadcastRoom(room)`，本次未改动 server.js，仅核实与登记。

### 关联错误编码
- A000：已修复（核实，非本次代码改动）
- A001：已修复（本次代码改动）

### 当前版本
- 0.2（上个版本 0.1，+0.1）
