// 表情包浮窗（默契/快艇/画猜共用；正式玩家/测试号）
(function () {
  if (sessionStorage.getItem('isGuest') === 'true') return;
  var STYLE = '.emj-wrap{position:fixed;right:14px;bottom:86px;z-index:5000}.emj-btn{width:44px;height:44px;border-radius:50%;border:1px solid rgba(74,144,217,.5);background:rgba(255,255,255,.82);box-shadow:0 3px 12px rgba(31,45,61,.15);backdrop-filter:blur(8px);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;color:#6b7a90}.emj-panel{position:fixed;right:14px;bottom:136px;z-index:5001;display:none;flex-direction:column;gap:6px;padding:10px;border-radius:14px;border:1px solid rgba(74,144,217,.45);background:rgba(255,255,255,.86);backdrop-filter:blur(10px);box-shadow:0 6px 20px rgba(31,45,61,.16)}.emj-panel.on{display:flex}.emj-item{width:64px;height:64px;object-fit:contain;cursor:pointer;border-radius:8px}.emj-tip{font-size:.72rem;color:#9aa5b1;max-width:120px;text-align:center;line-height:1.5}.emj-burst{position:fixed;left:50%;top:38%;transform:translate(-50%,-30%) scale(.4);z-index:6000;pointer-events:none;opacity:0}.emj-burst.on{animation:emjpop 1.8s ease forwards}.emj-burst img{width:min(38vw,220px);height:auto;border-radius:12px;background:rgba(255,255,255,.88);padding:10px;box-shadow:0 10px 30px rgba(31,45,61,.25)}.emj-burst .emj-who{text-align:center;font-size:.82rem;color:#2c3e50;font-weight:600;margin-top:6px}@keyframes emjpop{0%{opacity:0;transform:translate(-50%,-30%) scale(.4)}12%{opacity:1;transform:translate(-50%,0) scale(1)}80%{opacity:1;transform:translate(-50%,0) scale(1)}100%{opacity:0;transform:translate(-50%,-20%) scale(.95)}}body.dyn-pink .emj-btn{border-color:rgba(240,98,146,.5)}body.dyn-green .emj-btn{border-color:rgba(111,158,99,.5)}body.dyn-gold .emj-btn{border-color:rgba(214,168,67,.5)}body.dyn-red .emj-btn{border-color:rgba(166,64,58,.5)}';
  var styleEl = document.createElement('style'); styleEl.textContent = STYLE; document.head.appendChild(styleEl);
  var items = [], mine = [], opened = false;
  var wrap = document.createElement('div'); wrap.className = 'emj-wrap';
  var btn = document.createElement('div'); btn.className = 'emj-btn'; btn.textContent = '💬';
  var panel = document.createElement('div'); panel.className = 'emj-panel';
  btn.onclick = function () { opened = !opened; render(); };
  wrap.appendChild(panel); wrap.appendChild(btn);
  var burst = document.createElement('div'); burst.className = 'emj-burst';
  document.body.appendChild(wrap); document.body.appendChild(burst);
  function render() {
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
      if (!res || !res.success) { render(); }
    });
    showBurst(it.url, '你');
  };
  function showBurst(url, who) {
    burst.innerHTML = '<img src="' + url + '"><div class="emj-who">' + (who || '') + '</div>';
    burst.classList.remove('on'); void burst.offsetWidth; burst.classList.add('on');
  }
  socket.on('emoji_burst', function (d) { if (d && d.url && d.from) showBurst(d.url, d.from); });
  socket.on('connect', load);
  function load() { socket.emit('get_emoji', function (res) { if (!res || !res.success) return; items = res.items || []; mine = (res.mine || []).slice(); render(); }); }
})();
