#!/usr/bin/env bash
# light 一键上线脚本（在服务器仓库目录内执行；需要 Node.js >= 18）
# 用法：bash deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo '==> 1/4 拉取最新代码'
if [ -d .git ]; then
  git pull --ff-only
fi

echo '==> 2/4 安装依赖（按 package-lock 锁定版本）'
npm ci --omit=dev

echo '==> 3/4 准备数据目录（成就/时光墙/默契落盘用）'
mkdir -p data

if command -v pm2 >/dev/null 2>&1; then
  echo '==> 4/4 使用 pm2 启动并守护'
  pm2 start deploy/ecosystem.config.js
  pm2 save
else
  echo '==> 4/4 未安装 pm2，改用 nohup 前台常驻（建议生产装 pm2: npm i -g pm2）'
  export PERSIST_ACHIEVEMENTS=true PERSIST_TIMELINE=true PERSIST_SYNC=true
  nohup node server.js > data/server.log 2>&1 &
  echo "PID: $!"
fi

sleep 1
echo ''
echo '健康检查:'
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" || echo '⚠️ 健康检查未通过，请看日志: data/server.log'
echo ''
echo '✅ 上线完成。公网地址由你的域名/Nginx 或防火墙放行决定。'