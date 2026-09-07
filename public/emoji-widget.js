// 表情包浮窗 v2（默契/快艇/画猜/大厅共用）
(function () {
  if (sessionStorage.getItem('isGuest') === 'true') return;
  var STYLE = [
    '.emj-wrap{position:fixed;left:14px;bottom:86px;z-index:5000}',
    '.emj-btn{width:46px;height:46px;border-radius:50%;border:1px solid rgba(74,144,217,.5);background:rgba(74,144,217,.12);color:#2f6fb2;box-shadow:0 3px 12px rgba(31,45,61,.15);backdrop-filter:blur(8px);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:800;letter-spacing:.5px}',
    'body.dyn-pink .emj-btn{background:rgba(240,98,146,.13);color:#c73e79;border-color:rgba(240,98,146,.5)}',
    'body.dyn-green .emj-btn{background:rgba(111,158,99,.15);color:#4f8a45;border-color:rgba(111,158,99,.5)}',
    'body.dyn-gold .emj-btn{background:rgba(214,168,67,.15);color:#a8791b;border-color:rgba(214,168,67,.5)}',
    'body.dyn-red .emj-btn{background:rgba(166,64,58,.15);color:#8c332d;border-color:rgba(166,64,58,.5)}',
    '.emj-panel{position:fixed;left:14px;bottom:138px;z-index:5001;display:none;gap:8px;padding:10px 12px;border-radius:16px;border:1px solid rgba(74,144,217,.5);background:rgba(255,255,255,.82);backdrop-filter:blur(12px);box-shadow:0 6px 20px rgba(31,45,61,.16)}',
    '.emj-panel.on{display:flex}',
    'body.dyn-pink .emj-panel{border-color:rgba(240,98,146,.5)}body.dyn-green .emj-panel{border-color:rgba(111,158,99,.5)}body.dyn-gold .emj-panel{border-color:rgba(214,168,67,.5)}body.dyn-red .emj-panel{border-color:rgba(166,64,58,.5)}',
    '.emj-item{width:60px;height:60px;object-fit:contain;cursor:pointer;border-radius:8px;background:rgba(255,255,255,.6)}',
    '.emj-tip{font-size:.72rem;color:#9aa5b1;max-width:150px;text-align:center;line-height:1.5}',
    '.emj-burst{position:fixed;left:50%;top:36%;transform:translate(-50%,-30%) scale(.4);z-index:6000;pointer-events:none;opacity:0}',
    '.emj-burst.on{animation:emjpop 1.9s ease forwards}',
    '.emj-burst .emj-card{background:rgba(255,255,255,.82);backdrop-filter:blur(12px);border:1px solid rgba(74,144,217,.5);border-radius:18px;padding:12px;box-shadow:0 12px 34px rgba(31,45,61,.2)}',
    'body.dyn-pink .emj-burst .emj-card{border-color:rgba(240,98,146,.5)}body.dyn-green .emj-burst .emj-card{border-color:rgba(111,158,99,.5)}body.dyn-gold .emj-burst .emj-card{border-color:rgba(214,168,67,.5)}body.dyn-red .emj-burst .emj-card{border-color:rgba(166,64,58,.5)}',
    '.emj-burst img{width:min(40vw,220px);height:auto;border-radius:10px;display:block}',
    '.emj-burst .emj-who{text-align:center;font-size:.82rem;color:#2c3e50;font-weight:600;margin-top:6px}',
    '@keyframes emjpop{0%{opacity:0;transform:translate(-50%,-30%) scale(.4)}12%{opacity:1;transform:translate(-50%,0) scale(1)}78%{opacity:1}100%{opacity:0;transform:translate(-50%,-18%) scale(.96)}}'
  ].join('\n');
  var styleEl = document.createElement('style'); styleEl.textContent = STYLE; document.head.appendChild(styleEl);
  var items = [], mine = [], opened = false, dispMap = {};
  var me = sessionStorage.getItem('playerName') || '';
  var wrap = document.createElement('div'); wrap.className = 'emj-wrap';
  var btn = document.createElement('div'); btn.className = 'emj-btn'; btn.textContent = 'ovo'; btn.title = '表情包';
  var panel = document.createElement('div'); panel.className = 'emj-panel';
  btn.onclick = function () { opened = !opened; renderPanel(); };
  wrap.appendChild(panel); wrap.appendChild(btn);
  var burst = document.createElement('div'); burst.className = 'emj-burst';
  document.body.appendChild(wrap); document.body.appendChild(burst);
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
  function showBurst(url, who) {
    burst.innerHTML = '<div class="emj-card"><img src="' + url + '"><div class="emj-who">' + (who || '') + '</div></div>';
    burst.classList.remove('on'); void burst.offsetWidth; burst.classList.add('on');
  }
  socket.on('emoji_burst', function (d) { if (d && d.url && d.from) showBurst(d.url, disp(d.from)); });
  socket.on('connect', function () {
    socket.emit('get_display_names', function (r) { if (r && r.success) dispMap = r.map; });
    if (/\/lobby/.test(location.pathname)) socket.emit('lobby_enter');
    setTimeout(function () { socket.emit('get_emoji', function (res) { if (res && res.success) { items = res.items || []; mine = (res.mine || []).slice(); renderPanel(); } }); }, 400);
  });
})();
