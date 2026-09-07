// 表情包浮窗 v2（默契/快艇/画猜/大厅共用）
(function () {
  if (sessionStorage.getItem('isGuest') === 'true') return;
  var STYLE = [
    '.emj-wrap{position:fixed;right:14px;bottom:86px;z-index:5000}',
    '.emj-btn{width:46px;height:46px;border-radius:50%;border:1px solid rgba(74,144,217,.5);background:rgba(74,144,217,.12);color:#2f6fb2;box-shadow:0 3px 12px rgba(31,45,61,.15);backdrop-filter:blur(8px);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:800;letter-spacing:.5px}',
    'body.dyn-pink .emj-btn{background:rgba(240,98,146,.13);color:#c73e79;border-color:rgba(240,98,146,.5)}',
    'body.dyn-green .emj-btn{background:rgba(111,158,99,.15);color:#4f8a45;border-color:rgba(111,158,99,.5)}',
    'body.dyn-gold .emj-btn{background:rgba(214,168,67,.15);color:#a8791b;border-color:rgba(214,168,67,.5)}',
    'body.dyn-red .emj-btn{background:rgba(166,64,58,.15);color:#8c332d;border-color:rgba(166,64,58,.5)}',
    '.emj-panel{position:fixed;right:14px;bottom:138px;z-index:5001;display:none;gap:8px;padding:10px 12px;border-radius:16px;border:1px solid rgba(74,144,217,.5);background:rgba(255,255,255,.6);backdrop-filter:blur(12px);box-shadow:0 6px 20px rgba(31,45,61,.16)}',
    '.emj-panel.on{display:flex}',
    'body.dyn-pink .emj-panel{border-color:rgba(240,98,146,.5)}body.dyn-green .emj-panel{border-color:rgba(111,158,99,.5)}body.dyn-gold .emj-panel{border-color:rgba(214,168,67,.5)}body.dyn-red .emj-panel{border-color:rgba(166,64,58,.5)}',
    '.emj-item{width:60px;height:60px;object-fit:contain;cursor:pointer;border-radius:8px;background:rgba(255,255,255,.2)}',
    '.emj-tip{font-size:.72rem;color:#9aa5b1;max-width:150px;text-align:center;line-height:1.5}',
    '.emj-burst{position:fixed;left:50%;top:36%;transform:translate(-50%,0);z-index:6000;pointer-events:none;opacity:0}',
    '.emj-burst.on{animation:emjpop 1.9s ease forwards}',
    '.emj-burst .emj-card{background:rgba(255,255,255,.45);backdrop-filter:blur(12px);border:1px solid rgba(74,144,217,.5);border-radius:18px;padding:12px;box-shadow:0 12px 34px rgba(31,45,61,.2)}',
    'body.dyn-pink .emj-burst .emj-card{border-color:rgba(240,98,146,.5)}body.dyn-green .emj-burst .emj-card{border-color:rgba(111,158,99,.5)}body.dyn-gold .emj-burst .emj-card{border-color:rgba(214,168,67,.5)}body.dyn-red .emj-burst .emj-card{border-color:rgba(166,64,58,.5)}',
    '.emj-burst img{width:min(40vw,220px);height:auto;border-radius:10px;display:block}',
    '.emj-burst .emj-who{text-align:center;font-size:.82rem;color:#2c3e50;font-weight:600;margin-top:6px}',
    '.emj-mini{position:fixed;left:10px;top:10px;z-index:5000;display:none;align-items:center;gap:3px;background:rgba(255,255,255,.68);border:1px solid rgba(74,144,217,.45);border-radius:14px;padding:5px 8px;backdrop-filter:blur(10px);box-shadow:0 4px 16px rgba(31,45,61,.14)}',
    '.emj-mini img{width:40px;height:40px;object-fit:contain;border-radius:7px;cursor:pointer;transition:transform .12s}',
    '.emj-mini img:hover{transform:scale(1.1)}',
    '.emj-mini .emj-tip{font-size:.72rem;color:#6b7a90;padding:4px 6px}',
    '.emj-alert{position:fixed;left:10px;top:64px;z-index:5000;display:none;align-items:center;gap:6px;background:rgba(255,255,255,.7);border:1px solid rgba(74,144,217,.45);border-radius:12px;padding:4px 10px 4px 5px;backdrop-filter:blur(10px);pointer-events:none;opacity:0;transition:opacity .3s}',
    '.emj-alert img{width:44px;height:44px;object-fit:contain;border-radius:7px}',
    '.emj-alert .emj-who{font-size:.72rem;color:#2c3e50;margin:0;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    'body.dyn-pink .emj-mini,body.dyn-pink .emj-alert{border-color:rgba(240,98,146,.5)}',
    'body.dyn-green .emj-mini,body.dyn-green .emj-alert{border-color:rgba(111,158,99,.5)}',
    'body.dyn-gold .emj-mini,body.dyn-gold .emj-alert{border-color:rgba(214,168,67,.5)}',
    'body.dyn-red .emj-mini,body.dyn-red .emj-alert{border-color:rgba(166,64,58,.5)}',
    '@keyframes emjpop{0%{opacity:0}10%{opacity:1}80%{opacity:1}100%{opacity:0}}'
  ].join('\n');
  var styleEl = document.createElement('style'); styleEl.textContent = STYLE; document.head.appendChild(styleEl);
  var items = [], mine = [], opened = false, dispMap = {};
  // 表情浮窗形态：0=右下大面板(ovo)  1=左上小角(=w=)  2=隐藏大表情(TAT)；长按小圆按钮循环
  var mode = Number(localStorage.getItem('emjMode') || 0); if (mode < 0 || mode > 2) mode = 0;
  var me = sessionStorage.getItem('playerName') || '';
  var wrap = document.createElement('div'); wrap.className = 'emj-wrap';
  var btn = document.createElement('div'); btn.className = 'emj-btn'; btn.textContent = 'ovo'; btn.title = '表情包：点击展开 · 长按 ovo/=w=/TAT 切换显示形态';
  var panel = document.createElement('div'); panel.className = 'emj-panel';
  var mini = document.createElement('div'); mini.className = 'emj-mini'; // =w= 形态：左上角常驻小托盘（可点发送）
  var alertEl = document.createElement('div'); alertEl.className = 'emj-alert'; // =w= 收到提醒小条
  var miniTimer = null;
  function applyMode() {
    btn.textContent = mode === 0 ? 'ovo' : (mode === 1 ? '=w=' : 'TAT');
    btn.style.opacity = mode === 2 ? '.5' : '1';
    if (opened && mode !== 0) { opened = false; }
    panel.classList.toggle('on', opened && mode === 0);
    burst.style.display = mode === 0 ? '' : 'none';
    if (mode === 1) {
      mini.style.display = 'flex';
      renderTray();
      alertEl.style.display = 'flex';
    } else {
      mini.style.display = 'none';
      alertEl.style.opacity = '0';
      setTimeout(function () { if (mode !== 1) alertEl.style.display = 'none'; }, 320);
    }
    localStorage.setItem('emjMode', String(mode));
  }
  function renderTray() {
    if (!mine.length) { mini.innerHTML = '<span class="emj-tip">去设置选 3 个表情</span>'; return; }
    mini.innerHTML = mine.map(function (id, i) {
      var it = items.find(function (x) { return x.id === id; });
      return it ? '<img class="emj-item" src="' + it.url + '" title="发送表情" onclick="window.__emjSend(' + i + ')">' : '';
    }).join('');
  }
  function showMini(url, who) {
    clearTimeout(miniTimer);
    if (!alertEl.firstChild) { alertEl.innerHTML = '<img src="' + url + '"><span class="emj-who">' + (who || '') + '</span>'; }
    else { alertEl.querySelector('img').src = url; alertEl.querySelector('.emj-who').textContent = who || ''; }
    alertEl.style.display = 'flex';
    requestAnimationFrame(function () { alertEl.style.opacity = '1'; });
    miniTimer = setTimeout(function () { alertEl.style.opacity = '0'; }, 3400);
  }
  btn.onclick = function () {
    if (btn._blockClick) { btn._blockClick = false; return; }
    if (mode !== 0) return;
    opened = !opened; renderPanel();
  };
  var holdTimer = null, holding = false;
  function holdStart(e) {
    if (e && e.cancelable) { try { e.preventDefault(); } catch (_) {} }
    holding = true;
    holdTimer = setTimeout(function () {
      if (!holding) return;
      btn._blockClick = true; // 长按切换后吞掉随后的 click，避免误开面板
      mode = (mode + 1) % 3; applyMode();
      holdTimer = null;
    }, 560);
  }
  function holdEnd() { holding = false; if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
  btn.addEventListener('pointerdown', holdStart);
  ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { btn.addEventListener(ev, holdEnd); });
  btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  wrap.appendChild(panel); wrap.appendChild(btn);
  var burst = document.createElement('div'); burst.className = 'emj-burst';
  document.body.appendChild(wrap); document.body.appendChild(burst); document.body.appendChild(mini); document.body.appendChild(alertEl);
  applyMode();
  function disp(n) { return dispMap[n] || n; }
  function renderPanel() {
    panel.classList.toggle('on', opened);
    if (!opened) return;
    if (!mine.length) { panel.innerHTML = '<div class="emj-tip">还没装配表情，去 <b>设置</b> 选 3 个吧</div>'; return; }
    panel.innerHTML = mine.map(function (id, i) {
      var it = items.find(function (x) { return x.id === id; });
      return it ? '<img class="emj-item" src="' + it.url + '" onclick="window.__emjSend(' + i + ')">' : '';
    }).join('');
  }
  window.__emjSend = function (i) {
    var id = mine[i]; if (!id) return;
    var it = items.find(function (x) { return x.id === id; }); if (!it) return;
    socket.emit('emoji_send', { id: it.id, url: it.url }, function (res) {
      if (!res || !res.success) renderPanel();
    });
    showBurst(it.url, disp(me));
  };
  var burstTimer = null;
  function showBurst(url, who) {
    if (mode === 2) return;             // TAT：完全不打扰
    if (mode === 1) { showMini(url, who); return; } // =w=：只左上角小角提示
    clearTimeout(burstTimer);
    burst.innerHTML = '<div class="emj-card"><img src="' + url + '"><div class="emj-who">' + (who || '') + '</div></div>';
    burst.style.transition = 'none';
    burst.style.opacity = '0';
    requestAnimationFrame(function () {
      burst.style.transition = 'opacity .22s ease';
      burst.style.opacity = '1';
    });
    burstTimer = setTimeout(function () {
      burst.style.transition = 'opacity .55s ease';
      burst.style.opacity = '0';
    }, 1350);
  }
  socket.on('emoji_burst', function (d) { if (d && d.url && d.from) showBurst(d.url, disp(d.from)); });
  socket.on('connect', function () {
    socket.emit('get_display_names', function (r) { if (r && r.success) dispMap = r.map; });
    if (/\/lobby/.test(location.pathname)) socket.emit('lobby_enter');
    setTimeout(function () { socket.emit('get_emoji', function (res) { if (res && res.success) { items = res.items || []; mine = (res.mine || []).slice(); renderPanel(); renderTray(); } }); }, 400);
  });
})();
