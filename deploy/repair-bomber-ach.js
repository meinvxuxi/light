#!/usr/bin/env node
// 整理旧版"描边大师 / 世一炸·5连击+"重复计数：
// 旧判定会让同一段连空在 8/9/10/11… 各记一次；新口径每段只算 1 次。
//
// 用法（服务器上，建议先 pm2 stop light）：
//   node deploy/repair-bomber-ach.js            # 所有玩家、count=1
//   node deploy/repair-bomber-ach.js 2          # 所有玩家、count=2
//   node deploy/repair-bomber-ach.js 玩家1      # 只处理 玩家1，count=1
//   node deploy/repair-bomber-ach.js 2 玩家1    # 只处理 玩家1，count=2
// 完成后：pm2 restart light
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const FILES = ['achievements.json', 'test-achievements.json'];

let targetCount = 1;
let playerFilter = '';
const args = process.argv.slice(2);
for (const a of args) {
  if (/^\d+$/.test(a)) targetCount = parseInt(a, 10);
  else playerFilter = a;
}
if (targetCount < 0) { console.error('count 不能为负'); process.exit(1); }

const targets = new Set(['bomber_edge', 'bomber_streak5']);
let changed = 0;
let touchedFile = false;

for (const file of FILES) {
  const fp = path.join(DATA, file);
  if (!fs.existsSync(fp)) continue;
  const list = JSON.parse(fs.readFileSync(fp, 'utf8'));
  let dirty = false;
  for (const r of list) {
    if (!targets.has(r.achievementId)) continue;
    if (playerFilter && r.playerName !== playerFilter) continue;
    if (r.count !== targetCount || (r.events || []).length > 1) dirty = true;
    r.count = targetCount;
    if (Array.isArray(r.events) && r.events.length > 1) r.events = [r.events[0]]; // 旧重复时间只留最早一次
    changed++;
  }
  if (dirty) {
    if (!touchedFile) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = path.join(DATA, `ach-backup-${ts}-${file}`);
      fs.copyFileSync(fp, bak);
      console.log('📦 已备份到', bak);
    }
    fs.writeFileSync(fp, JSON.stringify(list, null, 2), 'utf8');
    touchedFile = true;
    console.log(`✏️  已整理 ${file}`);
  }
}
console.log(`✅ 共处理 ${changed} 条记录（目标 count=${targetCount}${playerFilter ? '，仅玩家 ' + playerFilter : ''}）。`);
console.log('如果个别玩家确实有过“两段独立 8+ 连空”，请手动把该玩家对应记录 count 改回实际段数。');
