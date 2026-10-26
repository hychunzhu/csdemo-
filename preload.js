/*
 * 桌面版在页面里注入的「应用外壳」：一个齿轮按钮 + 一个玻璃设置面板。
 * ---------------------------------------------------------------------------
 * 为什么注入而不是改站点：站点还要挂在网页上用，页面里不该出现「检查更新」
 * 这种只对桌面版有意义的入口。preload 只在 Electron 里跑，所以注入的东西
 * 天然只属于应用。
 *
 * ⚠️ contextIsolation 开着：这里能碰 DOM，但页面脚本碰不到我们暴露的 API。
 */
const { contextBridge, ipcRenderer } = require('electron');

/* ---------------- 给 splash 用 ---------------- */
contextBridge.exposeInMainWorld('boot', {
  onStep: (fn) => ipcRenderer.on('boot:step', (e, s) => fn(s)),
  done: () => ipcRenderer.send('boot:done'),
  onFadeOut: (fn) => ipcRenderer.on('boot:fadeout', () => fn())
});

/* ---------------- 给主界面用 ----------------
 * ⚠️ 这里必须留一个**本地引用**：contextBridge 暴露出去的对象属于页面的主世界，
 *    preload 自己的 `window` 是隔离世界，读 `window.appShell` 拿到的是 undefined
 *    —— 第一版就是这么踩的（面板点「检查更新」直接 TypeError）。
 */
const api = {
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  openUrl: (url) => ipcRenderer.invoke('app:open-url', url)
};
contextBridge.exposeInMainWorld('appShell', api);

/* ---------------- 注入设置面板 ---------------- */
const CSS = `
/* 桌面版里不需要「桌面版」这个入口（用户：「桌面端应用里怎么还有个桌面版」） */
.nav-links a[data-page="download"]{display:none !important}
.appx-gear{
  display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;border-radius:9px;margin-left:6px;cursor:pointer;
  border:1px solid var(--border-soft);background:rgba(var(--w-a),.04);
  color:var(--muted);transition:border-color .2s ease,color .2s ease,background .2s ease,transform .3s ease;
}
.appx-gear:hover{border-color:rgba(255,159,26,.45);color:var(--accent);background:rgba(255,159,26,.08);transform:rotate(28deg)}
.appx-gear svg{width:16px;height:16px;display:block}
.appx-gear .dot{position:absolute;margin:-16px 0 0 14px;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);display:none}
.appx-gear.has-new .dot{display:block}

.appx-panel{
  position:fixed;z-index:9999;top:64px;right:26px;width:286px;
  border-radius:14px;padding:12px 12px 10px;
  background:rgba(18,25,34,.72);
  -webkit-backdrop-filter:blur(22px) saturate(1.5);backdrop-filter:blur(22px) saturate(1.5);
  border:1px solid rgba(var(--w-a),.12);
  box-shadow:inset 0 1px 0 rgba(var(--w-a),.10),0 24px 50px -24px rgba(0,0,0,.95);
  color:var(--text);font-size:13px;
  opacity:0;transform:translateY(-6px) scale(.985);pointer-events:none;
  transition:opacity .18s ease,transform .18s cubic-bezier(.22,.61,.36,1);
}
html.light body .appx-panel{background:rgba(255,253,249,.86);border-color:rgba(92,74,48,.16)}
.appx-panel.on{opacity:1;transform:none;pointer-events:auto}
.appx-hd{display:flex;align-items:center;gap:8px;padding:2px 4px 10px;border-bottom:1px solid rgba(var(--w-a),.08);margin-bottom:8px}
.appx-hd b{font-size:13.5px;font-weight:700}
.appx-hd span{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--faint)}
.appx-row{
  display:flex;align-items:center;gap:9px;padding:8px 8px;border-radius:9px;cursor:pointer;
  color:var(--muted);transition:background .16s ease,color .16s ease;
}
.appx-row:hover{background:rgba(var(--w-a),.07);color:var(--text)}
.appx-row i{font-style:normal;width:18px;text-align:center;opacity:.85}
.appx-row em{margin-left:auto;font-style:normal;font-family:var(--mono);font-size:11px;color:var(--faint)}
.appx-note{padding:8px 8px 2px;font-size:11.5px;color:var(--faint);line-height:1.55;display:none}
.appx-note.on{display:block}
.appx-note a{color:var(--accent);cursor:pointer;text-decoration:underline}
`;

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

async function initShell() {
  /*
   * ⚠️ splash 窗口也挂着这个 preload，但它没有站点的 `.nav`，
   * 不挡住的话齿轮会被 append 到 body 中央，开机画面上多出一个孤零零的图标。
   */
  if (!document.querySelector('.nav')) return;
  let info = { version: '1.0.0' };
  try { info = await api.info(); } catch (e) {}

  // 站点的导航在每一页都有；没有就退回 body（比如以后加了纯页面）
  const host = document.querySelector('.nav-links') || document.querySelector('.nav') || document.body;

  const gear = el('button', 'appx-gear');
  gear.type = 'button';
  gear.title = '设置 / 检查更新';
  gear.setAttribute('aria-label', '设置');
  gear.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="3.2"/>' +
    '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>' +
    '</svg><i class="dot"></i>';
  host.appendChild(gear);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = el('div', 'appx-panel');
  panel.innerHTML =
    '<div class="appx-hd"><b>复盘终端</b><span>v' + info.version + '</span></div>' +
    '<div class="appx-row" data-act="update"><i>⟳</i>检查更新<em data-ver>—</em></div>' +
    '<div class="appx-row" data-act="theme"><i>◐</i>切换日夜主题</div>' +
    '<div class="appx-row" data-act="logs"><i>▤</i>打开日志文件夹</div>' +
    '<div class="appx-row" data-act="about"><i>ⓘ</i>关于<em>CS2 复盘终端</em></div>' +
    '<div class="appx-note" data-note></div>';
  document.body.appendChild(panel);

  const note = panel.querySelector('[data-note]');
  const verEl = panel.querySelector('[data-ver]');
  function say(html) {
    note.innerHTML = html;
    note.classList.toggle('on', !!html);
  }

  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('on');
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('on')) return;
    if (panel.contains(e.target) || gear.contains(e.target)) return;
    panel.classList.remove('on');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.classList.remove('on');
  });

  panel.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-act]');
    if (!row) return;
    const act = row.getAttribute('data-act');

    if (act === 'update') {
      verEl.textContent = '检查中';
      say('');
      const r = await api.checkUpdate();
      verEl.textContent = 'v' + (r.latest || info.version);
      if (!r.ok) {
        say('检查失败：' + (r.error || '网络不通') + '<br>（离线也能正常用，不影响解析）');
      } else if (r.newer) {
        gear.classList.add('has-new');
        say('发现新版本 <b>v' + r.latest + '</b>' +
            (r.notes && r.notes.length ? '<br>' + r.notes.join('<br>') : '') +
            (r.url ? '<br><a data-dl="' + r.url + '">去下载 →</a>' : ''));
      } else {
        gear.classList.remove('has-new');
        say('已经是最新版本（v' + info.version + '）');
      }
      return;
    }

    if (act === 'theme') {
      const btn = document.getElementById('togTheme');
      if (btn) btn.click();
      else {
        const light = document.documentElement.classList.toggle('light');
        try { localStorage.setItem('cs2.theme', light ? 'light' : 'dark'); } catch (err) {}
      }
      return;
    }

    if (act === 'logs') { api.openLogs(); return; }

    if (act === 'about') {
      say('CS2 复盘终端 v' + info.version + '<br>本地解析 .dem，数据不出这台机器。' +
          '<br>快捷键：F12 开发者工具 · F5 刷新');
    }
  });

  // 面板里的下载链接交给系统浏览器
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('[data-dl]');
    if (!a) return;
    api.openUrl(a.getAttribute('data-dl'));
  });

  // 开机后静默查一次：有新版本就在齿轮上点个橙点，不打断任何操作
  setTimeout(async () => {
    try {
      const r = await api.checkUpdate();
      if (r && r.ok && r.newer) {
        gear.classList.add('has-new');
        verEl.textContent = 'v' + r.latest;
      }
    } catch (e) {}
  }, 6000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initShell);
} else {
  initShell();
}
