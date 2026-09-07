#!/usr/bin/env bash
# light 服务器一键安全更新：备份 data → 拉代码 → 装依赖 → 重启
# 用法（服务器上，推荐用 root 身份）：
#   sudo bash deploy/update.sh
# 可选环境变量：
#   BACKUP_DIR  备份目录（默认 /root/backup）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "⚠️ 当前非 root。建议改用：sudo bash deploy/update.sh"
  echo "   （如果代码不在 root 家目录，请先 cd 到实际项目目录再执行）"
fi

# ① 备份 data（只读打包，不影响线上数据；文件名带时间）
BACKUP_DIR="${BACKUP_DIR:-/root/backup}"
mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
if [ -d data ]; then
  tar czf "$BACKUP_DIR/before-update-$TS.tgz" data/
  echo "✅ 已备份 data/ → $BACKUP_DIR/before-update-$TS.tgz"
  ls -lh "$BACKUP_DIR/before-update-$TS.tgz"
else
  echo "ℹ️ 当前目录没有 data/，跳过备份（确认你 cd 到了项目目录）"
fi

# ② 拉最新代码（若有本地改动会停下，避免冲突）
if [ -d .git ]; then
  echo "==> git pull"
  git pull --ff-only
else
  echo "⚠️ 当前目录不是 git 仓库，跳过 git pull（请确认更新方式）"
fi

# ③ 按 lock 文件装依赖
echo "==> npm ci"
npm ci --omit=dev

# ④ 重启 pm2 服务（存在 light 就 restart，否则按配置启动）
echo "==> 重启服务"
if command -v pm2 >/dev/null 2>&1; then
  if pm2 id light >/dev/null 2>&1 && [ -n "$(pm2 id light | tr -d '[] ')" ]; then
    pm2 restart light
  else
    pm2 start deploy/ecosystem.config.js
  fi
  pm2 save
else
  export NODE_ENV=production PERSIST_ACHIEVEMENTS=true PERSIST_TIMELINE=true PERSIST_SYNC=true PERSIST_BOARD=true
  pkill -f 'node server.js' || true
  nohup node server.js > data/server.log 2>&1 &
  echo "PID: $!"
fi

sleep 2
echo ""
echo "健康检查："
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" && echo " ✅ 服务正常" || echo "⚠️ 健康检查未通过，看日志：tail -n 30 data/server.log"
echo "✅ 更新完成。旧数据保留在 data/，浏览器打开站点即可验证。"
