'use strict';

const { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

let mainWindow = null;
let isPinned = false;
let tray = null;
let isQuitting = false;

const STORAGE_DIR = path.join(app.getPath('userData'), 'storage');
const NOTE_FILE = path.join(STORAGE_DIR, 'note.json');
const SETTINGS_FILE = path.join(STORAGE_DIR, 'settings.json');

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function makeDefaultItems() {
  // 新安装默认空列表（用户自己添加任务）
  return [];
}

function makeDefaultDoc() {
  return {
    items: makeDefaultItems(),
    updatedAt: null
  };
}

/**
 * 向后兼容迁移：旧格式 { title, content } → 新格式 { items: [...] }
 */
function migrateIfNeeded(data) {
  if (Array.isArray(data?.items)) {
    // 已经是新格式 —— 补充缺失字段
    const now = new Date().toISOString();
    data.items = data.items.map((it, idx) => ({
      id: typeof it?.id === 'string' && it.id ? it.id : uid(),
      title: typeof it?.title === 'string' ? it.title : '',
      done: !!it?.done,
      note: typeof it?.note === 'string' ? it.note : '',
      expanded: !!it?.expanded,
      createdAt: typeof it?.createdAt === 'string' ? it.createdAt : now,
      updatedAt: typeof it?.updatedAt === 'string' ? it.updatedAt : now,
      _idx: idx
    }));
    return data;
  }

  // 旧格式 / 非法数据 → 迁移或重建
  if (data && typeof data === 'object' && ('title' in data || 'content' in data)) {
    const now = new Date().toISOString();
    const migrated = {
      items: [{
        id: uid(),
        title: typeof data.title === 'string' ? data.title || '迁移的旧便签' : '迁移的旧便签',
        done: false,
        note: typeof data.content === 'string' ? data.content : '',
        expanded: false,
        createdAt: now,
        updatedAt: now
      }],
      updatedAt: data.updatedAt || now,
      migratedFrom: 'old-format'
    };
    return migrated;
  }

  return makeDefaultDoc();
}

async function ensureStorageFile() {
  if (!existsSync(STORAGE_DIR)) {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  }
  if (!existsSync(NOTE_FILE)) {
    const initial = { ...makeDefaultDoc(), updatedAt: new Date().toISOString() };
    await fs.writeFile(NOTE_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return null;
}

async function loadNote() {
  try {
    await ensureStorageFile();
    // 注意：去掉 UTF-8 BOM（PowerShell 的 Set-Content -Encoding UTF8 会写入 BOM）
    const raw = (await fs.readFile(NOTE_FILE, 'utf8')).replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return migrateIfNeeded(data);
  } catch (err) {
    console.error('加载笔记失败：', err);
    return makeDefaultDoc();
  }
}

async function saveNote(_, doc) {
  try {
    if (!existsSync(STORAGE_DIR)) {
      await fs.mkdir(STORAGE_DIR, { recursive: true });
    }
    const items = Array.isArray(doc?.items) ? doc.items : [];
    const now = new Date().toISOString();

    // 规范化 + 兜底
    const normalized = items.map((it, idx) => ({
      id: typeof it?.id === 'string' && it.id ? it.id : uid(),
      title: typeof it?.title === 'string' ? it.title : '',
      done: !!it?.done,
      note: typeof it?.note === 'string' ? it.note : '',
      expanded: !!it?.expanded,
      createdAt: typeof it?.createdAt === 'string' ? it.createdAt : now,
      updatedAt: typeof it?.updatedAt === 'string' ? it.updatedAt : now,
      _idx: idx
    }));

    const payload = { items: normalized, updatedAt: now };
    await fs.writeFile(NOTE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, updatedAt: now, count: normalized.length };
  } catch (err) {
    console.error('保存笔记失败：', err);
    return { ok: false, error: String(err) };
  }
}

async function ensureStorageDir() {
  if (!existsSync(STORAGE_DIR)) {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  }
}

const DEFAULT_SETTINGS = {
  theme: 'blue',          // 主题 key
  bgImage: null,          // dataURL 或 null（背景图由渲染层 FileReader 读成 base64 直接存）
  bgOpacity: 0.35         // 背景图不透明度（让卡片仍可读）
};

async function loadSettings() {
  try {
    await ensureStorageDir();
    if (!existsSync(SETTINGS_FILE)) {
      await fs.writeFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
      return { ...DEFAULT_SETTINGS };
    }
    const raw = (await fs.readFile(SETTINGS_FILE, 'utf8')).replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...data };
  } catch (err) {
    console.error('加载设置失败：', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(_, patch) {
  try {
    await ensureStorageDir();
    const current = await loadSettings();
    const merged = { ...current, ...patch };
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return { ok: true, settings: merged };
  } catch (err) {
    console.error('保存设置失败：', err);
    return { ok: false, error: String(err) };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 620,
    minWidth: 380,
    minHeight: 380,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    show: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    title: 'EzTxt 便签',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 窗口首次 show 后也跑一次贴边检测（应对上次关闭前就在边缘的情况）
    setTimeout(checkSnapDebounced, 400);
  });

  mainWindow.on('moved', checkSnapDebounced);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function applyPinState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(isPinned, 'screen-saver');
  mainWindow.webContents.send('pin-toggled', isPinned);
}

function togglePin() {
  isPinned = !isPinned;
  applyPinState();
}

// ======= 贴边吸附 =======
let isSnapped = false;          // 当前是否在 mini 贴边态
let savedBounds = null;         // 贴边前保存的窗口原尺寸
let snapDebounce = null;
const SNAP_THRESHOLD = 12;      // 距边缘多少像素内触发贴边
const MINI_SIZE = 56;           // mini 窗尺寸（px）

function getNearestWorkArea() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    return display.workArea;
  } catch (_) {
    return null;
  }
}

function checkSnap() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isSnapped) return; // 已经在 mini 态，不再重复贴边
  const wa = getNearestWorkArea();
  if (!wa) return;
  const b = mainWindow.getBounds();

  // 只有正常尺寸的窗口才检测（避免 mini 态误触）
  if (b.width < 200 || b.height < 200) return;

  // 只在窗口距离边缘 < SNAP_THRESHOLD 时才触发（拖到边缘的自然吸附）
  const pos = findNearestEdgePos(wa, b, SNAP_THRESHOLD);
  if (!pos) return;

  savedBounds = { ...b };
  isSnapped = true;
  doSnapResize(pos.nx, pos.ny);
}

/**
 * 找窗口中心附近最近的屏幕边缘，返回 mini 条应停靠的坐标 {nx, ny}
 * @param {object} wa workArea
 * @param {object} b 当前窗口 bounds
 * @param {number} [distThreshold] 可选：只在距边缘此像素内才触发（null 则总是贴）
 * @returns {object|null} {edge, nx, ny} 或 null
 */
function findNearestEdgePos(wa, b, distThreshold = null) {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const leftDist = cx - wa.x;
  const rightDist = (wa.x + wa.width) - cx;
  const topDist = cy - wa.y;
  const bottomDist = (wa.y + wa.height) - cy;

  let edge = null;
  let minDist = Infinity;
  const candidates = [
    { edge: 'left',   dist: leftDist   },
    { edge: 'right',  dist: rightDist  },
    { edge: 'top',    dist: topDist    },
    { edge: 'bottom', dist: bottomDist }
  ];
  for (const c of candidates) {
    if (distThreshold != null && c.dist > distThreshold) continue;
    if (c.dist < minDist) { minDist = c.dist; edge = c.edge; }
  }
  if (!edge) return null;

  let nx = b.x, ny = b.y;
  if (edge === 'left')       { nx = wa.x; }
  else if (edge === 'right') { nx = wa.x + wa.width - MINI_SIZE; }
  else if (edge === 'top')   { ny = wa.y; }
  else if (edge === 'bottom'){ ny = wa.y + wa.height - MINI_SIZE; }
  return { edge, nx, ny };
}

/**
 * 执行缩小动作：先发 IPC 让渲染层隐藏 .app，再延迟缩窗（防 race 漏出）
 */
function doSnapResize(nx, ny) {
  mainWindow.webContents.send('snap-state-changed', true);
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBounds({ x: Math.round(nx), y: Math.round(ny), width: MINI_SIZE, height: MINI_SIZE });
  }, 80);
}

function checkSnapDebounced() {
  if (snapDebounce) clearTimeout(snapDebounce);
  snapDebounce = setTimeout(checkSnap, 250);
}

function exitSnapped() {
  if (!isSnapped || !mainWindow) return;
  const targetBounds = savedBounds;
  isSnapped = false;
  savedBounds = null;
  mainWindow.webContents.send('snap-state-changed', false);
  // 先通知渲染层恢复 UI，再放大窗口（反向 race）
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (targetBounds) {
      mainWindow.setBounds(targetBounds);
    }
  }, 60);
}

/**
 * 主动缩小到 mini 小条（工具栏按钮触发）—— 总是贴最近的屏幕边缘
 */
function enterMini() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isSnapped) return;

  const b = mainWindow.getBounds();
  const wa = getNearestWorkArea();
  savedBounds = { ...b };

  let nx, ny;
  if (wa) {
    // 总是贴最近边缘（按钮用户明确要贴边）
    const pos = findNearestEdgePos(wa, b, null);
    if (pos) { nx = pos.nx; ny = pos.ny; }
    else {
      nx = Math.max(wa.x, Math.min(b.x + b.width - MINI_SIZE, wa.x + wa.width - MINI_SIZE));
      ny = Math.max(wa.y, Math.min(b.y + 8, wa.y + wa.height - MINI_SIZE));
    }
  } else {
    nx = b.x + b.width - MINI_SIZE;
    ny = b.y + 8;
  }

  isSnapped = true;
  doSnapResize(nx, ny);
}

// ======= 托盘 =======

/**
 * 生成纯色圆形 tray 图标（避免依赖外部 .ico 文件）
 * 输出 16×16 的 PNG Buffer
 */
function generateTrayIcon() {
  const SIZE = 16;
  // 画一个圆形（antialias 简易版：圆形内不透明，外透明）
  const cx = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 0.5;
  const pixels = Buffer.alloc(SIZE * SIZE * 4); // RGBA
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * SIZE + x) * 4;
      if (dist <= r) {
        // 圆形内：琥珀 accent 色 #D16647
        pixels[idx]     = 0xD1;
        pixels[idx + 1] = 0x66;
        pixels[idx + 2] = 0x47;
        pixels[idx + 3] = 0xFF;
      } else {
        pixels[idx]     = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      }
    }
  }
  return encodePng(SIZE, SIZE, pixels);
}

/**
 * 极简 PNG 编码器：只支持 RGBA 原始像素 → PNG Buffer
 * 扫描线前加 filter byte 0（None），然后整个 deflate 压缩
 */
function encodePng(w, h, rgba) {
  const { crc32 } = require('zlib');
  function crc(buf) { return require('zlib').crc32(buf) >>> 0; }

  // 构造 raw image data（每行前加 filter=0）
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter byte
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const compressed = zlib.deflateSync(raw);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function createTray() {
  const iconBuf = generateTrayIcon();
  const icon = nativeImage.createFromBuffer(iconBuf);
  if (icon.isEmpty()) {
    console.error('[tray] icon is empty! PNG encoder may be broken, buffer size:', iconBuf.length);
  }
  tray = new Tray(icon);
  tray.setToolTip('EzTxt 便签');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (!mainWindow) { createWindow(); return; }
        mainWindow.show();
        mainWindow.focus();
      }
    },
    { type: 'separator' },
    {
      label: '退出 EzTxt',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
    if (!mainWindow) { createWindow(); return; }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function registerIpc() {
  ipcMain.handle('load-note', loadNote);
  ipcMain.handle('save-note', saveNote);
  ipcMain.handle('load-settings', loadSettings);
  ipcMain.handle('save-settings', saveSettings);

  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.on('window-close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isQuitting) {
      mainWindow.close();
    } else {
      // 默认缩到托盘而非直接关闭
      mainWindow.hide();
    }
  });

  ipcMain.on('window-toggle-pin', () => {
    togglePin();
  });

  ipcMain.handle('window-get-pin-state', () => isPinned);

  // Mini 态恢复（渲染层点击 miniBar 触发）
  ipcMain.on('exit-mini', () => exitSnapped());

  // 主动缩小到 mini 小条（工具栏按钮触发）
  ipcMain.on('enter-mini', () => enterMini());
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      if (!tray) createTray();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  // 只要托盘还在，就不真正退出（窗口可能隐藏在托盘里）
  if (tray) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});
