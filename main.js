// StandAppodoro: every 30 minutes the laptop becomes unusable until you have been hands-off for 30 seconds.
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, powerMonitor, desktopCapturer, nativeImage, Notification } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const FAST = process.argv.includes('--fast'); // dev mode: a "minute" is one second
const BREAK_NOW = process.argv.includes('--break-now'); // dev mode: start a break 3 s after launch
const MIN = FAST ? 1 : 60;
const CFG = {
  workSec: 30 * MIN,          // work interval
  warnSec: FAST ? 12 : 60,    // warning before the break
  breakSec: 30,               // hands-off seconds required to end the break
  growSec: 6,                 // vortex reaches full size after this many seconds
  escHoldSec: 10,             // hold Esc this long to escape a break
  postponeMaxMin: 15,         // total postpone budget per cycle
  postponeOptions: [5, 10, 15],
  escapeGraceMin: 15,         // next break comes this soon after an escape
  idleResetSec: FAST ? 3600 : 5 * 60, // being away this long counts as a break (disabled in --fast)
};

const S = {
  phase: 'work',              // work | warning | break
  deadline: 0,
  postponed: 0,
  breakStart: 0,
  handsOff: 0,
  lastTick: Date.now(),
  paused: false,
  pauseRemaining: 0,
  escHeld: false,             // holding Esc is not "touching"
};

let tray = null;
let trayWin = null;         // hidden offscreen page that paints the tray icon
let lastIcon = '';
let warnWin = null;
let overlays = [];
let cursorWin = null;
let lastTrayText = '';

const PRELOAD = path.join(__dirname, 'preload.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (win, ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// Windows refuses to give the foreground to a background process, and the taskbar only hides for the
// foreground fullscreen window. The classic workaround: tap Alt, then SetForegroundWindow.
function forceForeground(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);'; ` +
    `[W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero); [W.U]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true }, (err) => { if (err) console.error('forceForeground failed', err.message); });
}

// ---------- phases ----------

function startWork(seconds) {
  console.log(`[${new Date().toLocaleTimeString()}] work for ${seconds}s`);
  S.phase = 'work';
  S.deadline = Date.now() + seconds * 1000;
  rebuildMenu();
}

function startWarning() {
  if (S.phase === 'warning') return;
  console.log(`[${new Date().toLocaleTimeString()}] warning`);
  S.phase = 'warning';
  S.deadline = Date.now() + CFG.warnSec * 1000;
  const cursor = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(cursor);
  const W = 340, H = 360, M = 24;
  warnWin = new BrowserWindow({
    width: W, height: H,
    x: d.workArea.x + d.workArea.width - W - M,
    y: d.workArea.y + M,
    frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    focusable: false, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  warnWin.setAlwaysOnTop(true, 'screen-saver');
  warnWin.loadFile('warning.html');
  warnWin.once('ready-to-show', () => warnWin.showInactive());
  warnWin.on('closed', () => { warnWin = null; });
  rebuildMenu();
}

function closeWarning() {
  if (warnWin && !warnWin.isDestroyed()) warnWin.destroy();
  warnWin = null;
}

async function startBreak() {
  if (S.phase === 'break') return;
  console.log(`[${new Date().toLocaleTimeString()}] break`);
  S.phase = 'break';
  S.breakStart = Date.now();
  S.handsOff = 0;
  S.escHeld = false;
  closeWarning();
  await sleep(150); // let the warning tile disappear before the screenshot

  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  let sources = [];
  try {
    const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
    const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
  } catch (e) {
    console.error('screen capture failed', e);
  }

  displays.forEach((d, i) => {
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[i];
    const image = src && !src.thumbnail.isEmpty() ? src.thumbnail.toDataURL() : null;
    const b = d.bounds;
    const inside = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, show: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, alwaysOnTop: true,
      backgroundColor: '#14171d',
      webPreferences: { preload: PRELOAD, contextIsolation: true },
    });
    // Not a fullscreen window on purpose: a frameless topmost window covering the display bounds
    // is what sits above the Windows taskbar; fullscreen + topmost lets the taskbar show through.
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on('close', (e) => { if (S.phase === 'break') e.preventDefault(); });
    win.loadFile('overlay.html');
    win.webContents.on('did-finish-load', () => {
      send(win, 'init', {
        image,
        cursor: inside ? { x: cursor.x - b.x, y: cursor.y - b.y } : null,
        cfg: { breakSec: CFG.breakSec, growSec: CFG.growSec, escHoldSec: CFG.escHoldSec },
      });
      win.show();
      if (inside) { win.focus(); forceForeground(win); }
    });
    overlays.push(win);
    if (inside) cursorWin = win;
  });
  if (!cursorWin && overlays[0]) cursorWin = overlays[0];
  rebuildMenu();
}

function endBreak(reason) {
  console.log(`[${new Date().toLocaleTimeString()}] break ended: ${reason}`);
  const next = reason === 'escaped' ? CFG.escapeGraceMin * MIN : CFG.workSec;
  S.phase = 'work';
  for (const w of overlays) if (!w.isDestroyed()) w.destroy();
  overlays = [];
  cursorWin = null;
  S.postponed = 0;
  startWork(next);
}

function postpone(minutes) {
  if (S.phase !== 'warning') return;
  if (!CFG.postponeOptions.includes(minutes)) return;
  if (S.postponed + minutes > CFG.postponeMaxMin) return;
  S.postponed += minutes;
  closeWarning();
  startWork(minutes * MIN);
}

// ---------- tick ----------

function tick() {
  const now = Date.now();
  const dt = Math.min(1, (now - S.lastTick) / 1000);
  S.lastTick = now;
  const idle = powerMonitor.getSystemIdleTime();

  if (S.phase === 'work') {
    if (S.paused) {
      S.deadline = now + S.pauseRemaining;
    } else {
      if (idle >= CFG.idleResetSec) S.deadline = now + CFG.workSec * 1000; // already away: restart the clock
      if (now >= S.deadline) startWarning();
    }
  } else if (S.phase === 'warning') {
    const remaining = Math.max(0, (S.deadline - now) / 1000);
    send(warnWin, 'state', {
      remaining, total: CFG.warnSec,
      budget: CFG.postponeMaxMin - S.postponed,
      options: CFG.postponeOptions,
    });
    if (remaining <= 0) startBreak();
  } else if (S.phase === 'break') {
    const touching = idle < 1 && !S.escHeld;
    if (touching) S.handsOff = 0; else S.handsOff += dt;
    const elapsed = (now - S.breakStart) / 1000;
    const remaining = Math.max(0, CFG.breakSec - S.handsOff);
    for (const w of overlays) send(w, 'state', { elapsed, remaining, touching });
    if (Math.floor(elapsed * 5) % 5 === 0) {           // once a second: stay above the taskbar and keep keyboard focus
      for (const w of overlays) if (!w.isDestroyed()) { w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); }
      if (cursorWin && !cursorWin.isDestroyed() && !cursorWin.isFocused()) {
        cursorWin.focus();
        const sec = Math.round(elapsed);
        if (sec === 2 || sec === 5) forceForeground(cursorWin); // retry early on; it injects a key tap, so not every second
      }
    }
    if (remaining <= 0 && elapsed > 1) endBreak('done');
  }
  updateTray(now);
}

// ---------- tray ----------

function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min` : `${s} s`;
}

function statusText(now) {
  if (S.phase === 'break') return 'Break in progress';
  if (S.phase === 'warning') return `Break in ${fmt(S.deadline - now)}`;
  if (S.paused) return 'Paused';
  return `Next break in ${fmt(S.deadline - now)}`;
}

function updateTray(now) {
  if (!tray) return;
  const text = statusText(now);
  if (text !== lastTrayText) {
    lastTrayText = text;
    tray.setToolTip(`StandAppodoro: ${text}`);
    rebuildMenu(text);
  }
  // icon: ring = share of the work interval left, number = minutes left (seconds during the warning)
  let icon;
  if (S.phase === 'break') icon = { phase: 'break', fraction: 1, text: '' };
  else if (S.phase === 'warning') icon = { phase: 'warning', fraction: (S.deadline - now) / (CFG.warnSec * 1000), text: String(Math.max(0, Math.ceil((S.deadline - now) / 1000))) };
  else {
    const left = Math.max(0, S.deadline - now);
    const unit = Math.max(1, Math.ceil(left / (MIN * 1000)));
    icon = { phase: S.paused ? 'paused' : 'work', fraction: left / (CFG.workSec * 1000), text: S.paused ? 'II' : String(unit) };
  }
  const key = JSON.stringify(icon);
  if (key !== lastIcon) { lastIcon = key; send(trayWin, 'state', icon); }
}

function createTrayPainter() {
  trayWin = new BrowserWindow({
    width: 32, height: 32, show: false, transparent: true, frame: false, skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, offscreen: true },
  });
  trayWin.webContents.setFrameRate(4);
  trayWin.webContents.on('paint', (_e, _dirty, image) => {
    if (!tray || image.isEmpty()) return;
    tray.setImage(image);
    if (process.env.STANDUP_TRAY_DUMP) require('fs').writeFileSync(process.env.STANDUP_TRAY_DUMP, image.toPNG()); // debug: save the icon
  });
  trayWin.loadFile('tray.html');
}

function rebuildMenu(text) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: text || statusText(Date.now()), enabled: false },
    { type: 'separator' },
    { label: 'Break now', enabled: S.phase === 'work', click: () => startBreak() },
    {
      label: S.paused ? 'Resume' : 'Pause',
      enabled: S.phase === 'work',
      click: () => {
        if (S.paused) { S.paused = false; S.deadline = Date.now() + S.pauseRemaining; }
        else { S.paused = true; S.pauseRemaining = Math.max(0, S.deadline - Date.now()); }
        lastTrayText = '';
      },
    },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { S.phase = 'quit'; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------- app ----------

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  app.setAppUserModelId('dev.sirio.standappodoro');
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));
  tray.on('click', () => tray.popUpContextMenu());
  createTrayPainter();
  ipcMain.on('ready', (e) => { if (trayWin && e.sender === trayWin.webContents) { lastIcon = ''; updateTray(Date.now()); } });
  if (Notification.isSupported()) {
    new Notification({ title: 'StandAppodoro is running', body: `Next break in ${CFG.workSec / MIN} minutes. The ring in the tray counts down.`, silent: true }).show();
  }

  ipcMain.on('postpone', (_e, minutes) => postpone(Number(minutes)));
  ipcMain.on('escape', () => { if (S.phase === 'break') endBreak('escaped'); });
  ipcMain.on('esc-hold', (_e, held) => { S.escHeld = !!held; });

  powerMonitor.on('suspend', () => {
    closeWarning();
    if (S.phase === 'break') { S.phase = 'work'; for (const w of overlays) if (!w.isDestroyed()) w.destroy(); overlays = []; cursorWin = null; }
    startWork(CFG.workSec);
  });

  startWork(CFG.workSec);
  setInterval(tick, 200);
  if (FAST) console.log('StandAppodoro running in --fast mode: 1 "minute" = 1 second');
  if (BREAK_NOW) setTimeout(startBreak, 3000);
});

app.on('window-all-closed', () => { /* stay in the tray */ });
