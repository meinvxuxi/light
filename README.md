# 🏰 light（线上玩法服务器）

快艇骰子 / 画猜接龙 / 默契空间 / 留言板 / 个人空间 · 单文件 Node 服务。

## 上线三步走

需要一台能跑 Node.js ≥ 18 的公网服务器（或内网穿透）。

```bash
# 1. 拉代码（首次）
git clone https://github.com/meinvxuxi/light.git
cd light

# 2. 一键安装 + 启动（已写好全部环境变量：成就/时光墙/默契落盘）
bash deploy/deploy.sh

# 3. 验证
curl http://127.0.0.1:3000/healthz   # → {"ok":true,...}
curl -I http://127.0.0.1:3000/       # → 200
```

推荐先全局装 `pm2`（`npm i -g pm2`），这样脚本会用 pm2 守护并开机自启（`pm2 startup`）。

## 常用命令

| 操作 | 命令 |
|---|---|
| 看日志 | `pm2 logs light` |
| 重启 | `pm2 restart light` |
| 直接跑（调试） | `PERSIST_ACHIEVEMENTS=true PERSIST_TIMELINE=true PERSIST_SYNC=true node server.js` |
| 换端口 | 设环境变量 `PORT`（默认 3000） |

## 用 Nginx 反代（可选，推荐）

把 `3000` 暴露给公网时用 Nginx 反代 + 域名更稳，配置要点：

```nginx
server {
  listen 80;
  server_name 你的域名或IP;
  client_max_body_size 2m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # Socket.IO 必须
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

HTTPS 用 certbot 一键签发即可。安全提示：首次开放后建议换掉游客口令 `GUEST_KEY`（server.js 顶部）和正式玩家钥匙逻辑。

## 数据与隐私

- 正式数据（成就/时光墙/默契/用户档案）默认写 `data/`，`.gitignore` 已排除，不入库；
- 测试账号数据永远只存内存，重启即清空；
- 页面静态资源在开发模式强制 no-cache；正式部署建议自己套一层 CDN/缓存策略。

## 目录速览

- `server.js` 全部服务端逻辑（房间/成就/排行/时光墙/留言）
- `public/` 各页面（lobby/profile/yahtzee/drawing/pair/timeline/leaderboard/messages…）
- `development/notes/` 设计文档（成就体系 `cj`、计划 `dateplan.md`）
- `deploy/` 上线脚本与 pm2 配置
