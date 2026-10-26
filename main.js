/*
 * 梅花幼儿园复盘部 · 桌面版主进程
 * ---------------------------------------------------------------------------
 * 为什么要有这一步：站点是纯静态的，但大量用到 `fetch()` 读 JSON 和相对路径
 * （`assets/...`）。直接 `loadFile()` 走 file:// 会被 CORS 卡死（fetch 全红、
 * 整页空白），所以这里起一个**只监听 127.0.0.1 的静态服务**，
 * 主窗口加载 http://127.0.0.1:<port>/index.html。
 *
 * 启动编排（用户要求「像视频那样」）：
 *   1. 先建主窗口并**立刻显示**（深色底，标题栏就是应用本身的样子）
 *   2. 在它的**内容区**位置盖一个无边框 splash 窗口（尺寸/位置和内容区完全一致），
 *      这样开机动画看起来就是「应用窗口里的画面」，而不是另一块屏
 *   3. splash 里跑三段动画（品牌 → 启动进度 → 界面骨架渐显）
 *   4. 动画结束 **且** 页面加载完 → 把 splash 窗口 opacity 从 1 淡到 0（真·交叉淡化），
 *      底下已经是渲染好的真界面 —— 就是视频2 那种「渐变型产生内容」
 *   5. splash 只盖在上面，任务栏里只有主窗口，切走再切回来也不会多一个窗
 */
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const isDev = process.argv.includes('--dev');
/* 自检：`electron . --shot` 会截开机动画和主窗口各一张到 shot-*.png 然后退出 */
const SHOT = process.argv.includes('--shot');

/* ---------------- 崩溃日志 ---------------- */
function logFile() {
  try { return path.join(app.getPath('userData'), 'startup.log'); }
  catch (e) { return null; }
}
function logLine(s) {
  const line = '[' + new Date().toISOString() + '] ' + s + '\r\n';
  // 写两份：userData（正式位置）+ 程序目录（.bat / 用户可以直接看）
  [logFile(), path.join(__dirname, '启动日志.txt')].forEach((f) => {
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // 超过 256KB 就重开一份：这文件是排障用的，不需要留一辈子
      try {
        if (fs.statSync(f).size > 262144) fs.renameSync(f, f + '.old');
      } catch (e) {}
      fs.appendFileSync(f, line);
    } catch (e) {}
  });
  if (isDev) console.log('[cs2]', s);
}
logLine('---- 启动 argv=' + process.argv.slice(1).join(' '));

/* ---------------- 软件渲染兜底 ---------------- */
/*
 * 虚拟机 / 远程桌面 / 驱动异常的机器上，Chromium 的 GPU 进程一起来就 0xC0000005 崩，
 * 然后直接 FATAL 退出 —— 用户看到的就是「双击没反应」。这里两道保险：
 *   ① 崩过一次就写进 boot-state.json，以后这台机器直接走软件渲染；
 *   ② 运行中崩了，带 --soft-gpu 自动重启一次。
 */
function stateFile() {
  try { return path.join(app.getPath('userData'), 'boot-state.json'); }
  catch (e) { return path.join(__dirname, '.boot-state.json'); }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch (e) { return {}; }
}
function writeState(patch) {
  try {
    const next = Object.assign(readState(), patch);
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(next));
  } catch (e) {}
}
const SOFT = process.argv.includes('--soft-gpu') || !!process.env.CS2_SOFT_GPU;
const bootState = readState();
if (SOFT || bootState.preferSoft) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  logLine('软件渲染模式已启用' + (bootState.preferSoft && !SOFT ? '（记住的偏好）' : ''));
}
let relaunched = false;
app.on('child-process-gone', (e, d) => {
  logLine('子进程退出 type=' + d.type + ' reason=' + d.reason + ' exitCode=' + d.exitCode);
  if (relaunched) return;
  if (d.type === 'GPU' || d.reason === 'crashed' || d.reason === 'abnormal-exit') {
    relaunched = true;
    writeState({ preferSoft: true });
    logLine('GPU 进程崩溃 → 用软件渲染重启一次');
    app.relaunch({ args: process.argv.slice(1).concat(['--soft-gpu']) });
    app.exit(0);
  }
});
process.on('uncaughtException', (err) => {
  logLine('未捕获异常: ' + (err && err.stack || err));
});

/* ---------------- 检查更新 ----------------
 * 版本清单放在站点上（/cs2/app/latest.json），主进程用 https 拉 —— 不走页面的 fetch，
 * 省得被 CORS 拦（127.0.0.1 页面 → pages.dev 是跨域）。
 * 用 CS2_UPDATE_URL 可以在本地测别的地址。
 */
const UPDATE_URL = process.env.CS2_UPDATE_URL || 'https://xiaochun-benzi.pages.dev/cs2/app/latest.json';

function httpsGetJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(url, { timeout: timeoutMs || 6000, headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('清单不是合法 JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

/* 1.2.3 / v1.2.3 都能比，只看数字段 */
function cmpVer(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron
  }));

  ipcMain.handle('app:check-update', async () => {
    const cur = app.getVersion();
    try {
      const m = await httpsGetJSON(UPDATE_URL);
      const latest = String(m.version || m.latest || cur);
      return {
        ok: true,
        current: cur,
        latest,
        url: m.url || '',
        notes: Array.isArray(m.notes) ? m.notes.slice(0, 3) : [],
        newer: cmpVer(latest, cur) > 0
      };
    } catch (e) {
      logLine('检查更新失败: ' + (e && e.message));
      return { ok: false, current: cur, latest: cur, error: (e && e.message) || '网络不通' };
    }
  });

  ipcMain.handle('app:open-logs', () => {
    const f = logFile();
    try { if (f) shell.showItemInFolder(f); } catch (e) {}
    return true;
  });

  ipcMain.handle('app:open-url', (e, url) => {
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url);
    return true;
  });
}

/* ---------------- 本地静态服务 ---------------- */
function resolveSiteRoot() {
  /*
   * 顺序：环境变量 → 随包带的 site/ → 开发机上的仓库。
   * ⚠️ CS2_SITE 放在最前面是有意的：装机版带的是**快照**，站点更新后要么重装、
   *    要么把 CS2_SITE 指向实时仓库（改代码时特别有用）。
   */
  const env = process.env.CS2_SITE;
  if (env && fs.existsSync(path.join(env, 'index.html'))) return env;
  const bundled = path.join(__dirname, 'site');
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled;
  const guess = 'J:\\工作空间\\cs2-tactics';
  if (fs.existsSync(path.join(guess, 'index.html'))) return guess;
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.dem': 'application/octet-stream',
  '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8'
};

let server = null;
let siteRoot = null;

function startServer(root) {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let rel;
      try { rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]); }
      catch (e) { res.writeHead(400); res.end('bad url'); return; }
      if (rel === '/' || rel === '') rel = '/index.html';
      let file = path.normalize(path.join(root, rel));
      if (!file.startsWith(path.normalize(root))) { res.writeHead(403); res.end('forbidden'); return; }
      fs.stat(file, (err, st) => {
        if (!err && st.isDirectory()) file = path.join(file, 'index.html');
        fs.readFile(file, (e, buf) => {
          if (e) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 ' + rel);
            return;
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(buf);
        });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/* ---------------- 窗口 ---------------- */
let splashWin = null;
let mainWin = null;
let splashDone = false;
let pageReady = false;
let bootAt = 0;
let origin = '';
let mainHomeUrl = '';

// 开机进度下限：品牌页本身要亮 900ms，收尾 1.1s，太快反而像闪屏
const MIN_SPLASH = 1500;

/*
 * 真实开机进度：每一步都对应主进程真的做完了一件事，推给 splash 画进度条，
 * 同时用 Windows 任务栏的进度条（setProgressBar）在后台也有反馈 ——
 * 这是系统给窗口按钮画的那条绿色/彩色进度，和下载文件时看到的一样。
 */
let lastBootPct = 0;
function sendBoot(step) {
  // 补发的旧步骤直接丢掉，别让日志和任务栏来回跳
  if ((step.pct || 0) < lastBootPct) return;
  lastBootPct = step.pct || 0;
  try {
    if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(Math.min(1, (step.pct || 0) / 100));
  } catch (e) {}
  try {
    if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('boot:step', step);
  } catch (e) {}
  logLine('进度 ' + step.pct + '% · ' + (step.label || ''));
}
function clearTaskbarProgress() {
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(-1); } catch (e) {}
}

/* splash 淡出：整窗 opacity 1→0，底下真界面同时已经在那儿了 */
function fadeOutSplash(done) {
  if (!splashWin || splashWin.isDestroyed()) { if (done) done(); return; }
  try { splashWin.webContents.send('boot:fadeout'); } catch (e) {}
  let v = 1;
  const timer = setInterval(() => {
    v -= 0.07;
    if (v <= 0) {
      clearInterval(timer);
      if (splashWin && !splashWin.isDestroyed()) { splashWin.destroy(); splashWin = null; }
      if (done) done();
      return;
    }
    try { splashWin.setOpacity(v); }
    catch (e) {
      // 不支持窗口透明度就干脆利落地关掉，别留个半透明糊在那儿
      clearInterval(timer);
      if (splashWin && !splashWin.isDestroyed()) { splashWin.destroy(); splashWin = null; }
      if (done) done();
    }
  }, 34);
  // 兜底：1.2 秒后一定有结果
  setTimeout(() => {
    if (splashWin && !splashWin.isDestroyed()) { splashWin.destroy(); splashWin = null; }
    if (done) done();
  }, 1200);
}

let revealed = false;
function tryReveal() {
  // ⚠️ boot:done 和 6 秒兜底都会调进来；不挡住会出现「两次 fadeOutSplash」→
  // 两个 setInterval 同时改 opacity，窗口抖一下
  if (revealed) return;
  if (!splashDone || !pageReady) return;
  revealed = true;
  const wait = Math.max(0, MIN_SPLASH - (Date.now() - bootAt));
  setTimeout(() => {
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.show();
    mainWin.focus();
    logLine('主窗口已显示，开始淡出开机动画');
    fadeOutSplash(() => { clearTaskbarProgress(); logLine('启动完成'); });
    if (SHOT) {
      setTimeout(async () => {
        try {
          const img = await mainWin.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, 'shot-main.png'), img.toPNG());
          console.log('[shot] shot-main.png');
        } catch (e) { console.error('[shot] main 失败', e); }
        app.quit();
      }, 900);
    }
  }, wait);
}

/* 开机期间主窗口被拖动/缩放时，把 splash 重新贴合它的内容区 */
function syncSplashBounds() {
  if (!splashWin || splashWin.isDestroyed() || !mainWin || mainWin.isDestroyed()) return;
  try {
    const b = mainWin.getContentBounds();
    if (b && b.width && b.height) splashWin.setBounds(b);
  } catch (e) {}
}

function createSplash() {
  /*
   * 关键：splash 的位置和大小 = 主窗口的**内容区**（getContentBounds 是屏幕坐标），
   * 盖上去正好补满标题栏以下那一块，看起来就是「应用窗口里的画面」，
   * 淡出的时候也没有任何位移。
   */
  let b = null;
  try { b = mainWin.getContentBounds(); } catch (e) {}
  if (!b || !b.width || !b.height) {
    try {
      const wb = mainWin.getBounds();
      b = { x: wb.x, y: wb.y + 32, width: wb.width, height: wb.height - 32 };
    } catch (e) { b = { x: 0, y: 0, width: 1600, height: 950 }; }
  }
  logLine('splash 内容区 ' + b.width + '×' + b.height + ' @' + b.x + ',' + b.y);

  splashWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,        // 任务栏里只留主窗口
    alwaysOnTop: true,
    show: true,
    backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  splashWin.setMenuBarVisibility(false);
  splashWin.loadFile(path.join(__dirname, 'splash.html'));
  logLine('splash 窗口已创建');
  // 第一条 18% 往往比 splash 的脚本更早发出（那时页面还没加载），这里补发一次；
  // splash 那边是「只进不退」的，补发不会把进度拉回去
  splashWin.webContents.once('did-finish-load', () => {
    sendBoot({ pct: 18, label: '本地服务就绪', en: 'server up' });
  });

  ipcMain.once('boot:done', () => {
    splashDone = true;
    logLine('收到 boot:done');
    tryReveal();
  });
  // 兜底：preload 挂了 / 动画卡住时，6 秒后强制放行
  setTimeout(() => {
    if (!splashDone) {
      splashDone = true;
      logLine('6 秒内没收到 boot:done，强制显示主窗口');
      tryReveal();
    }
  }, 6000);

  if (SHOT) {
    const grab = (name, delay) => setTimeout(async () => {
      try {
        if (!splashWin || splashWin.isDestroyed()) return;
        const img = await splashWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, name), img.toPNG());
        console.log('[shot] ' + name);
      } catch (e) {}
    }, delay);
    grab('shot-splash.png', 1200);    // ① 品牌页
    grab('shot-splash2.png', 3000);   // ② 进度段
    grab('shot-splash3.png', 4700);   // ③ 骨架渐显
  }
}

function createMain(port) {
  let bounds = { width: 1600, height: 950 };
  try {
    const f = path.join(app.getPath('userData'), 'window.json');
    if (fs.existsSync(f)) {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (s && s.width > 800 && s.height > 500) bounds = s;
    }
  } catch (e) {}
  // 夹回可见区域：换过显示器 / 拔掉外接屏之后，上次的位置可能整块在屏幕外
  try {
    const { screen } = require('electron');
    const area = screen.getDisplayMatching({
      x: bounds.x || 0, y: bounds.y || 0,
      width: bounds.width, height: bounds.height
    }).workArea;
    if (typeof bounds.x === 'number') {
      const m = 80;   // 至少要露出 80px，别让标题栏完全够不着
      bounds.x = Math.min(Math.max(bounds.x, area.x - bounds.width + m), area.x + area.width - m);
      bounds.y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - m);
    }
    if (bounds.width > area.width) bounds.width = area.width;
    if (bounds.height > area.height) bounds.height = area.height;
  } catch (e) {}

  mainWin = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1180,
    minHeight: 720,
    show: true,                        // 先显示：标题栏就是应用的样子，splash 只盖内容区
    backgroundColor: '#0a0e13',
    autoHideMenuBar: true,
    title: '梅花幼儿园复盘部',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),   // 设置面板 / 检查更新注入在这
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);

  origin = `http://127.0.0.1:${port}`;
  mainHomeUrl = origin + '/index.html';   // 打开先看主页（用户要求）
  // ⚠️ 真正的 loadURL 放在 createSplash 之后（见 whenReady）：
  //    先加载的话 did-start-loading 会比 splash 更早触发，32% 那一步就丢了
  logLine('主窗口待加载 ' + mainHomeUrl);

  mainWin.webContents.on('did-start-loading', () => {
    sendBoot({ pct: 32, label: '开始加载页面', en: 'navigate' });
  });
  mainWin.webContents.on('dom-ready', () => {
    sendBoot({ pct: 56, label: '解析页面结构', en: 'dom ready' });
  });
  mainWin.webContents.once('did-finish-load', () => {
    pageReady = true;
    logLine('页面加载完成');
    sendBoot({ pct: 74, label: '资源加载完成', en: 'assets' });
    // 字体 + 两帧：等首屏真的画出来，再推进到 90%
    mainWin.webContents.executeJavaScript(
      'document.fonts.ready.then(function(){return new Promise(function(r){' +
      'requestAnimationFrame(function(){requestAnimationFrame(r);});});}).then(function(){return 1;})'
    ).then(() => {
      sendBoot({ pct: 90, label: '首屏绘制', en: 'first paint' });
      // 停一帧让 90% 真的画出来，然后放行收尾
      setTimeout(() => { sendBoot({ pct: 100, label: '就绪', en: 'ready' }); }, 220);
    }).catch(() => {
      sendBoot({ pct: 90, label: '首屏绘制', en: 'first paint' });
      setTimeout(() => { sendBoot({ pct: 100, label: '就绪', en: 'ready' }); }, 220);
    });
    tryReveal();
  });
  mainWin.webContents.on('did-fail-load', (e, code, desc, url) => {
    logLine('加载失败 ' + code + ' ' + desc + ' ' + url);
    dialog.showErrorBox('加载失败', `无法加载本地站点（${code} ${desc}）\n${siteRoot}`);
  });
  mainWin.webContents.on('render-process-gone', (e, d) => {
    logLine('渲染进程退出 reason=' + (d && d.reason) + ' exitCode=' + (d && d.exitCode));
  });

  // F12 / F5：本地调试
  mainWin.webContents.on('before-input-event', (evt, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') mainWin.webContents.toggleDevTools();
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) mainWin.webContents.reload();
  });

  /*
   * 站外链接一律丢给系统浏览器。
   * 新窗口（target=_blank）走 setWindowOpenHandler；普通 <a href="https://...">
   * 走 will-navigate —— 不然点一个 Liquipedia 链接会把应用本身导航走，
   * 用户在应用里再也回不到战报页。
   */
  const isLocal = (u) => u.startsWith(origin);
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isLocal(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWin.webContents.on('will-navigate', (evt, url) => {
    if (/^https?:/i.test(url) && !isLocal(url)) {
      evt.preventDefault();
      shell.openExternal(url);
    }
  });

  // 开机期间用户点了关闭：别把 splash 留成孤儿窗
  mainWin.on('closed', () => {
    mainWin = null;
    if (splashWin && !splashWin.isDestroyed()) { splashWin.destroy(); splashWin = null; }
  });
  mainWin.on('move', () => { if (!revealed) syncSplashBounds(); });
  mainWin.on('resize', () => { if (!revealed) syncSplashBounds(); });
  mainWin.on('close', () => {
    try {
      if (mainWin && !mainWin.isDestroyed() && !mainWin.isMaximized()) {
        fs.writeFileSync(
          path.join(app.getPath('userData'), 'window.json'),
          JSON.stringify(mainWin.getBounds())
        );
      }
    } catch (e) {}
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(async () => {
    bootAt = Date.now();
    siteRoot = resolveSiteRoot();
    if (!siteRoot) {
      dialog.showErrorBox('找不到站点文件',
        '没有找到 index.html。\n\n开发模式：把 CS2_SITE 环境变量指向 cs2-tactics 仓库。\n打包模式：把静态站拷到应用目录下的 site/。');
      app.quit();
      return;
    }
    app.setAppUserModelId('com.xiaochun.cs2.replay');
    registerIpc();
    logLine('站点根目录 ' + siteRoot);
    try {
      const port = await startServer(siteRoot);
      createMain(port);       // 先建主窗口（内容区位置要拿来放 splash）
      createSplash();
      sendBoot({ pct: 18, label: '本地服务就绪', en: 'server up' });
      // splash 就位之后再开始加载页面：进度条能完整走到 32% → 56% → 74% → 90%
      mainWin.loadURL(mainHomeUrl);
      logLine('主窗口开始加载 ' + mainHomeUrl);
      if (isDev) console.log('[cs2] site =', siteRoot, ' port =', port);
    } catch (err) {
      dialog.showErrorBox('本地服务启动失败', String(err && err.message || err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (server) { try { server.close(); } catch (e) {} }
    app.quit();
  });
}
