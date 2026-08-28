'use strict';

const { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const crypto = require('crypto');

let mainWindow = null;
let isPinned = false;
let tray = null;
let isQuitting = false;

// 存储目录：开发时用项目 data/（Trae 沙箱友好），打包后用 userData
const STORAGE_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'storage')
  : path.join(__dirname, '..', 'data');
const NOTE_FILE = path.join(STORAGE_DIR, 'note.json');
const SETTINGS_FILE = path.join(STORAGE_DIR, 'settings.json');

// 图标资源(多尺寸 ico 供打包,256px png 供运行时 nativeImage)
const ICON_PATH_ICO = path.join(__dirname, 'icon.ico');
const ICON_PATH_PNG = path.join(__dirname, 'icon.png');

// Windows 任务栏图标关联(确保修改生效、避免缓存)
app.setAppUserModelId('com.eztxt.stickynote');

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
    await atomicWrite(NOTE_FILE, JSON.stringify(payload, null, 2), 'utf8');
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

/**
 * 原子写入文件：先写 .tmp 再 rename，避免 EPERM/文件锁/半写入
 * Windows 下 rename 本身是原子的，同磁盘上 O(1)
 */
async function atomicWrite(targetPath, content, encoding = 'utf8', retries = 5) {
  const tmpPath = targetPath + '.tmp';
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await fs.writeFile(tmpPath, content, encoding);
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      // EPERM/EBUSY 文件锁，等一下再试
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 80 * (i + 1)));
        continue;
      }
      // 尝试清理残留 .tmp
      try { await fs.unlink(tmpPath); } catch (_) {}
      throw err;
    }
  }
  throw lastErr;
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
    await atomicWrite(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
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
    icon: ICON_PATH_PNG,
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
  });

  // 窗口首次 show 后也跑一次贴边检测（应对上次关闭前就在边缘的情况）
  setTimeout(checkSnapDebounced, 400);

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
const SNAP_THRESHOLD = 35;      // 距边缘多少像素内触发贴边（增大 → 更强弹性）
const MINI_SIZE = 56;           // mini 窗尺寸（px）
const EDGE_MARGIN = 10;         // mini 球距离屏幕安全边距（px）
const UNFOLD_GAP = 4;           // 展开后主窗口与 mini 球之间的小间距（px）
let snapEdge = null;            // 当前 mini 球贴的屏幕边：'left' | 'right' | 'top' | 'bottom'
let snapMiniPos = null;         // mini 球当前屏幕坐标 {x, y}

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
  if (isSnapped) return;
  const wa = getNearestWorkArea();
  if (!wa) return;
  const b = mainWindow.getBounds();

  if (b.width < 200 || b.height < 200) return;

  const pos = findNearestEdgePos(wa, b, SNAP_THRESHOLD);
  if (!pos) return;

  savedBounds = { ...b };
  snapEdge = pos.edge;
  snapMiniPos = { x: pos.nx, y: pos.ny };
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
  if (edge === 'left')       { nx = wa.x + EDGE_MARGIN; }
  else if (edge === 'right') { nx = wa.x + wa.width - MINI_SIZE - EDGE_MARGIN; }
  else if (edge === 'top')   { ny = wa.y + EDGE_MARGIN; }
  else if (edge === 'bottom'){ ny = wa.y + wa.height - MINI_SIZE - EDGE_MARGIN; }
  return { edge, nx, ny };
}

/**
 * 把主窗口展开位置(基于贴边方向 + mini 球当前位置)夹在 workArea 内,保证完整可见。
 */
function clampToWorkArea(bounds, wa) {
  if (!wa) return bounds;
  const maxX = wa.x + wa.width - bounds.width;
  const maxY = wa.y + wa.height - bounds.height;
  return {
    ...bounds,
    x: Math.round(Math.max(wa.x, Math.min(bounds.x, maxX))),
    y: Math.round(Math.max(wa.y, Math.min(bounds.y, maxY)))
  };
}

/**
 * 执行缩小动作：先发 IPC 让渲染层隐藏 .app，再延迟缩窗（防 race 漏出）
 * 同时把 mini 球设为置顶(高于桌面其他窗口),退出 mini 态时恢复用户原置顶设置。
 */
function doSnapResize(nx, ny) {
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.webContents.send('pin-toggled', true); // 通知渲染层 pin 按钮高亮
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

/**
 * 主动缩小到 mini 小条（工具栏按钮触发）—— 总是贴最近的屏幕边缘
 */
function enterMini() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isSnapped) return;

  const b = mainWindow.getBounds();
  const wa = getNearestWorkArea();
  savedBounds = { ...b };

  let nx, ny, edge = null;
  if (wa) {
    const pos = findNearestEdgePos(wa, b, null);
    if (pos) { nx = pos.nx; ny = pos.ny; edge = pos.edge; }
    else {
      nx = Math.max(wa.x, Math.min(b.x + b.width - MINI_SIZE, wa.x + wa.width - MINI_SIZE));
      ny = Math.max(wa.y, Math.min(b.y + 8, wa.y + wa.height - MINI_SIZE));
    }
  } else {
    nx = b.x + b.width - MINI_SIZE;
    ny = b.y + 8;
  }

  snapEdge = edge || null;
  snapMiniPos = { x: nx, y: ny };
  isSnapped = true;
  doSnapResize(nx, ny);
}

/**
 * 退出 mini 态展开主窗口：
 *  1. 先取 mini 球当前真实 bounds(用户可能拖动过 mini 球,snapMiniPos 是过期快照)
 *  2. 根据 mini 球当前位置,动态判断最靠近哪条屏幕边
 *  3. 把主窗口放在 mini 球「反侧」,再夹在 workArea 内防越界
 *  4. 恢复用户原本的 isPinned 置顶状态(不是 mini 态那个强制置顶)
 */
function exitSnapped() {
  if (!isSnapped || !mainWindow) return;

  // 先取消 mini 态强制置顶(恢复用户原本的 isPinned 设置)
  applyPinState(); // 内部用 isPinned(用户设置)决定是否置顶

  const miniBounds = mainWindow.getBounds();
  const wa = getNearestWorkArea();

  const mainW = savedBounds.width;
  const mainH = savedBounds.height;
  let targetX = savedBounds.x;
  let targetY = savedBounds.y;

  // 动态判断 mini 球当前最靠近哪条屏幕边
  let edge = snapEdge; // 先用进入 mini 时的记录作默认
  if (wa) {
    const cx = miniBounds.x + MINI_SIZE / 2;
    const cy = miniBounds.y + MINI_SIZE / 2;
    const leftDist = cx - wa.x;
    const rightDist = (wa.x + wa.width) - cx;
    const topDist = cy - wa.y;
    const bottomDist = (wa.y + wa.height) - cy;
    let minDist = Infinity;
    [{ e: 'left', d: leftDist }, { e: 'right', d: rightDist },
     { e: 'top', d: topDist }, { e: 'bottom', d: bottomDist }].forEach(({ e, d }) => {
      if (d < minDist) { minDist = d; edge = e; }
    });
  }

  if (edge) {
    const m = { x: miniBounds.x, y: miniBounds.y }; // 用当前真实位置,不用旧快照
    switch (edge) {
      case 'left':   targetX = m.x + MINI_SIZE + UNFOLD_GAP;       targetY = m.y + MINI_SIZE / 2 - mainH / 2; break;
      case 'right':  targetX = m.x - mainW - UNFOLD_GAP;          targetY = m.y + MINI_SIZE / 2 - mainH / 2; break;
      case 'top':    targetX = m.x + MINI_SIZE / 2 - mainW / 2;   targetY = m.y + MINI_SIZE + UNFOLD_GAP;    break;
      case 'bottom': targetX = m.x + MINI_SIZE / 2 - mainW / 2;   targetY = m.y - mainH - UNFOLD_GAP;        break;
    }
    const clamped = clampToWorkArea({ x: targetX, y: targetY, width: mainW, height: mainH }, wa);
    targetX = clamped.x;
    targetY = clamped.y;
  }

  const targetBounds = { x: targetX, y: targetY, width: mainW, height: mainH };

  isSnapped = false;
  savedBounds = null;
  snapEdge = null;
  snapMiniPos = null;
  mainWindow.webContents.send('snap-state-changed', false);

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBounds(targetBounds);
  }, 60);
}

// ======= 托盘 =======

function createTray() {
  // 优先用多尺寸 ico(Windows 托盘最佳),回退到 png
  let icon = nativeImage.createFromPath(ICON_PATH_ICO);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(ICON_PATH_PNG);
  }
  if (icon.isEmpty()) {
    console.error('[tray] icon is empty, ico/png 均未找到');
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

  // JS 层拖动窗口（mini-bar 原生 drag region 移除后，用偏移量移动窗口）
  ipcMain.on('move-window', (_e, dx, dy) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    mainWindow.setBounds({ x: b.x + (dx || 0), y: b.y + (dy || 0) });
  });
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
