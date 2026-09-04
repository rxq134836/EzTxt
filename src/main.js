'use strict';

const { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { existsSync, readFileSync } = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
// 自动更新（electron-updater）：仅打包后生效（开发模式自动跳过）
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let isPinned = false;
let tray = null;
let isQuitting = false;
let settingsWindow = null;
let customThemeWindow = null;
// 主窗口 CSS 视口尺寸（渲染层上报 innerWidth/innerHeight，供设置窗口同步）
let lastMainWindowSize = null;
// 当前窗口材质（由设置页 set-window-material 更新；mini 态临时切 none，退出后恢复）
let currentMaterial = 'opaque';

// 存储目录：动态（可由设置页修改）；开发时默认项目 data/，打包后默认 userData/storage
let STORAGE_DIR = null;
function defaultStorageDir() { return app.isPackaged ? path.join(app.getPath('userData'), 'storage') : path.join(__dirname, '..', 'data'); }
function storageConfigPath() { return path.join(app.getPath('userData'), 'storage-location.json'); }
function initStorageDir() { const def = defaultStorageDir(); try { const raw = readFileSync(storageConfigPath(), 'utf8').replace(/^\uFEFF/, ''); const cfg = JSON.parse(raw); if (cfg && typeof cfg.dir === 'string' && cfg.dir) { STORAGE_DIR = cfg.dir; return; } } catch (_) {} STORAGE_DIR = def; }
function noteFile() { return path.join(STORAGE_DIR, 'note.json'); }
function settingsFile() { return path.join(STORAGE_DIR, 'settings.json'); }

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
      label: typeof it?.label === 'string' ? it.label : '',  // 分割线可选标题
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
        updatedAt: now,
        label: ''
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
  if (!existsSync(noteFile())) {
    const initial = { ...makeDefaultDoc(), updatedAt: new Date().toISOString() };
    await fs.writeFile(noteFile(), JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return null;
}

async function loadNote() {
  try {
    await ensureStorageFile();
    // 注意：去掉 UTF-8 BOM（PowerShell 的 Set-Content -Encoding UTF8 会写入 BOM）
    const raw = (await fs.readFile(noteFile(), 'utf8')).replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return migrateIfNeeded(data);
  } catch (err) {
    console.error('加载笔记失败：', err);
    return makeDefaultDoc();
  }
}

function saveNote(_, doc) {
  return enqueueWrite(async () => {
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
        label: typeof it?.label === 'string' ? it.label : '',  // 分割线可选标题
        _idx: idx
      }));

      const payload = { items: normalized, updatedAt: now };
      await atomicWrite(noteFile(), JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, updatedAt: now, count: normalized.length };
    } catch (err) {
      console.error('保存笔记失败：', err);
      return { ok: false, error: String(err) };
    }
  });
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

/**
 * 串行化「读→改→写」队列：
 * 滑杆/快捷键等会快速连续触发保存，若并发执行，多个写入共用同一个 .tmp 文件，
 * 相互截断覆盖会把 JSON 写坏（表现为 parse 报 "Unexpected non-whitespace character"）。
 * 队列保证同一时刻只有一个读写事务在跑。
 */
let fileWriteChain = Promise.resolve();
function enqueueWrite(fn) {
  const run = fileWriteChain.then(fn, fn);
  fileWriteChain = run.then(() => {}, () => {});
  return run;
}

const DEFAULT_SETTINGS = {
  theme: 'blue',          // 主题 key（'custom' = 自定义主题之一，配合 customThemeId）
  customThemeId: null,    // 激活的自定义主题 id（theme==='custom' 时有效）
  customTheme: null,      // 【旧字段】单个自定义主题，启动时自动迁移进 customThemes
  customThemes: [],       // 自定义主题列表（最多 5 个）{id, name, accent, bg, ink, dark}
  material: 'opaque',      // 窗口材质：opaque（经典不透明）/ translucent（半透明）/ acrylic（亚克力磨砂）
  acrylicBlur: 40,         // 亚克力磨砂强度（backdrop-filter 模糊半径 px，0~60）
  bgImage: null,          // 当前背景图 dataURL（渲染层压缩后存入）
  bgHistory: [],          // 最近上传的背景图列表（新→旧，最多 10 张，dataURL）
  bgOpacity: 0.35,        // 背景图不透明度（让卡片仍可读）
  fontSize: 13,           // 页面基础字体大小（px），设置页滑杆控制
  closeAction: 'tray',    // 主窗口关闭按钮行为：tray（缩小到托盘）/ quit（退出软件）
  windowSize: 'default',  // 主窗口尺寸预设（见 WINDOW_SIZES；'custom' 用 customWindowSize）
  customWindowSize: { width: 560, height: 620 }, // 自定义窗口尺寸（窗口比例 → 自定义）
  miniBallStyle: 'classic', // mini 球风格：classic（经典圆球）/ gif（动画）
  miniBallGif: 'remi',     // mini 球动画主题名（扫描 mini-gifs/ 目录自动发现）
  autoStart: false,         // 开机自启（Windows 登录时自动启动 EzTxt）
  // Markdown 编辑器快捷键（设置面板可开关 / 改绑）
  shortcuts: {
    bold:          { enabled: true, key: 'b', ctrl: true,  shift: false, alt: false },
    italic:        { enabled: true, key: 'i', ctrl: true,  shift: false, alt: false },
    strikethrough: { enabled: true, key: 'd', ctrl: true,  shift: false, alt: false },
    inlineCode:    { enabled: true, key: 'k', ctrl: true,  shift: false, alt: false },
    codeBlock:     { enabled: true, key: 'k', ctrl: true,  shift: true,  alt: false },
    orderedList:   { enabled: true, key: '[', ctrl: true,  shift: true,  alt: false },
    unorderedList: { enabled: true, key: ']', ctrl: true,  shift: true,  alt: false }
  }
};

// 主窗口尺寸预设（设置页「外观 → 窗口比例」选择）
const WINDOW_SIZES = {
  'default':        { width: 560, height: 620 },   // 默认（当前便签大小）
  'landscape-wide': { width: 820, height: 500 },   // 宽横屏
  'landscape':      { width: 640, height: 460 },   // 横屏
  'portrait-narrow':{ width: 420, height: 700 },   // 窄竖屏
  'portrait':       { width: 480, height: 760 }    // 长竖屏
};

/** 合并设置：shortcuts 逐项合并，保证老配置缺项时用默认值兜底 */
function mergeSettings(base, data) {
  const shortcuts = { ...(base.shortcuts || {}) };
  for (const [name, value] of Object.entries(data?.shortcuts || {})) {
    shortcuts[name] = { ...(shortcuts[name] || {}), ...value };
  }
  return {
    ...base,
    ...data,
    shortcuts
  };
}

async function loadSettings() {
  try {
    await ensureStorageDir();
    if (!existsSync(settingsFile())) {
      await fs.writeFile(settingsFile(), JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
      return { ...DEFAULT_SETTINGS };
    }
    const raw = (await fs.readFile(settingsFile(), 'utf8')).replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    const merged = mergeSettings(DEFAULT_SETTINGS, data);
    return migrateCustomTheme(merged);
  } catch (err) {
    console.error('加载设置失败：', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/** 旧版单自定义主题（theme==='custom' + customTheme）迁移为 customThemes 列表第一项 */
function migrateCustomTheme(s) {
  const hasList = Array.isArray(s.customThemes) && s.customThemes.length > 0;
  if (!hasList && s.customTheme && typeof s.customTheme === 'object') {
    const id = 'ct-' + crypto.randomBytes(4).toString('hex');
    s.customThemes = [{ id, name: '自定义 1', ...s.customTheme }];
    s.customThemeId = id;
  }
  if (!Array.isArray(s.customThemes)) s.customThemes = [];
  // 激活的自定义主题被删/不存在时回退默认主题
  if (s.theme === 'custom' && !s.customThemes.find((t) => t.id === s.customThemeId)) {
    s.theme = 'blue';
    s.customThemeId = null;
  }
  return s;
}

/** 同步开机自启状态到操作系统（Windows 写注册表 HKCU\...\Run） */
function syncAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
  } catch (err) {
    console.error('设置开机自启失败：', err);
  }
}

function saveSettings(_, patch) {
  return enqueueWrite(async () => {
    try {
      await ensureStorageDir();
      const current = await loadSettings();
      const merged = mergeSettings(current, patch);
      await atomicWrite(settingsFile(), JSON.stringify(merged, null, 2), 'utf8');
      // 开机自启变更 → 同步到系统
      if (patch && typeof patch.autoStart === 'boolean') {
        syncAutoStart(patch.autoStart);
      }
      // 通知所有窗口重新加载设置（主题/字号/快捷键即时生效；自定义主题保存后设置窗口同步刷新）
      const { BrowserWindow } = require('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('settings-changed');
      }
      return { ok: true, settings: merged };
    } catch (err) {
      console.error('保存设置失败：', err);
      return { ok: false, error: String(err) };
    }
  });
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

  // 主窗口尺寸变化时通知设置窗口（自定义尺寸弹窗实时同步数值）。
  // 用渲染层上报的 CSS 视口尺寸（innerWidth/innerHeight）最准确；
  // 兜底用 getContentSize()（内容区，不含边框，比 getSize 更贴近视口）。
  mainWindow.on('resize', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    if (lastMainWindowSize) {
      settingsWindow.webContents.send('window-resized', lastMainWindowSize);
      return;
    }
    const [w, h] = mainWindow.getContentSize();
    settingsWindow.webContents.send('window-resized', { width: w, height: h });
  });

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

/**
 * 独立的设置窗口（可拖动、可缩放，与主窗口分离）。
 * 单例：已打开则聚焦复用。
 */
// 打开自定义主题编辑器窗口（左 demo 实时预览 / 右 3 色 + 明暗 + 名称面板）
// editId 为空 = 新建；传 id = 编辑已有自定义主题
function openCustomThemeWindow(editId = null) {
  if (customThemeWindow && !customThemeWindow.isDestroyed()) {
    // 单例复用：切换编辑目标时重载页面（携带 query）
    customThemeWindow.loadFile(path.join(__dirname, 'custom-theme.html'), {
      query: editId ? { id: editId } : {}
    });
    customThemeWindow.show();
    customThemeWindow.focus();
    return;
  }
  const winOptions = {
    width: 660,
    height: 540,
    minWidth: 580,
    minHeight: 470,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    show: false,
    title: 'EzTxt 自定义主题',
    icon: ICON_PATH_PNG,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  };
  customThemeWindow = new BrowserWindow(winOptions);
  customThemeWindow.loadFile(path.join(__dirname, 'custom-theme.html'), {
    query: editId ? { id: editId } : {}
  });
  customThemeWindow.once('ready-to-show', () => {
    customThemeWindow.show();
  });
  customThemeWindow.on('closed', () => {
    customThemeWindow = null;
  });
  customThemeWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 440,
    height: 620,
    minWidth: 380,
    minHeight: 460,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    show: false,
    title: 'EzTxt 设置',
    icon: ICON_PATH_PNG,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
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
  doSnapResize(pos.nx, pos.ny, pos.edge);
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
 * 平滑动画窗口 bounds（主进程无 rAF，用 setTimeout 模拟 60fps；easeOutCubic 缓动，
 * 与界面 --ease-out 的观感一致 —— 起步快、收尾缓）。
 * @param {object} from 起始 bounds {x,y,width,height}
 * @param {object} to 目标 bounds
 * @param {number} [duration] 毫秒，默认 200
 * @param {Function} [onDone] 动画完成回调
 */
function animateWindowBounds(from, to, duration = 200, onDone = null) {
  if (!mainWindow || mainWindow.isDestroyed()) { if (onDone) onDone(); return; }
  const start = Date.now();
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const step = () => {
    if (!mainWindow || mainWindow.isDestroyed()) { if (onDone) onDone(); return; }
    const t = Math.min(1, (Date.now() - start) / duration);
    const e = easeOut(t);
    mainWindow.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.round(from.width + (to.width - from.width) * e),
      height: Math.round(from.height + (to.height - from.height) * e)
    });
    if (t < 1) {
      setTimeout(step, 16);
    } else if (onDone) {
      onDone();
    }
  };
  step();
}

// ======= 全局键盘监听（mini 球动画 gif 打字检测） =======
// 用 PowerShell 轮询 GetAsyncKeyState，捕获 mini 态下其他应用的打字活动。
// 检测到按键 → IPC 发送 'typing-activity' → 渲染层 onEditorTyping()
// 进程常驻（app ready 启动，quit 停止），用 forwardTyping 标志控制是否转发，
// 避免 Add-Type 每次进 mini 重新编译（首次编译需数秒）。
let keyMonitorProc = null;
let keyMonitorRestartTimer = null;
let forwardTyping = false; // 是否转发打字事件（仅 mini + gif 模式时 true）

function startKeyMonitor() {
  if (keyMonitorProc) return;
  // 只检查打字相关键码（0x08-0x5A：Backspace~Z，83 个），减少 P/Invoke 调用量
  const psScript = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class K{[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int v);}
"@
$prev=New-Object bool[] 256
while($true){
  $np=$false
  for($i=8;$i -le 90;$i++){
    $now=([K]::GetAsyncKeyState($i) -band 0x8000) -ne 0
    if($now -and -not $prev[$i]){$np=$true}
    $prev[$i]=$now
  }
  if($np){[Console]::Out.WriteLine("1");[Console]::Out.Flush()}
  Start-Sleep -Milliseconds 20
}`.trim();
  try {
    keyMonitorProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      windowsHide: true,
    });
    // 逐行解析 stdout（避免多个按键事件合并成一次 data 回调）
    const readline = require('readline');
    const rl = readline.createInterface({ input: keyMonitorProc.stdout });
    rl.on('line', () => {
      if (forwardTyping && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('typing-activity');
      }
    });
    // 进程意外退出 → 3 秒后自动重启
    keyMonitorProc.on('error', () => { keyMonitorProc = null; scheduleRestart(); });
    keyMonitorProc.on('exit', () => { keyMonitorProc = null; scheduleRestart(); });
  } catch (_) { keyMonitorProc = null; scheduleRestart(); }
}

function scheduleRestart() {
  if (keyMonitorRestartTimer) return;
  keyMonitorRestartTimer = setTimeout(() => {
    keyMonitorRestartTimer = null;
    if (!app.isQuitting) startKeyMonitor();
  }, 3000);
}

function setTypingForward(enabled) {
  forwardTyping = enabled;
}

function stopKeyMonitor() {
  if (keyMonitorRestartTimer) { clearTimeout(keyMonitorRestartTimer); keyMonitorRestartTimer = null; }
  if (!keyMonitorProc) return;
  try { keyMonitorProc.kill(); } catch (_) {}
  keyMonitorProc = null;
}

/**
 * 执行缩小动作：先发 IPC 让渲染层隐藏 .app，再平滑缩窗（防 race 漏出）
 * 同时把 mini 球设为置顶(高于桌面其他窗口),退出 mini 态时恢复用户原置顶设置。
 */
function doSnapResize(nx, ny, edge = null) {
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // mini 态任务栏不显示 EzTxt，只保留托盘图标
  mainWindow.setSkipTaskbar(true);
  mainWindow.webContents.send('pin-toggled', true); // 通知渲染层 pin 按钮高亮
  mainWindow.webContents.send('snap-state-changed', true, edge || null);
  // mini 态切掉系统材质：避免亚克力磨砂铺满整个 56px 窗口矩形，球外露空白
  try { mainWindow.setBackgroundMaterial('none'); } catch (_) {}
  const from = mainWindow.getBounds();
  const to = { x: Math.round(nx), y: Math.round(ny), width: MINI_SIZE, height: MINI_SIZE };
  animateWindowBounds(from, to, 180);
  // mini 态开启打字事件转发（PowerShell 进程常驻，仅切换标志）
  setTypingForward(true);
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
  doSnapResize(nx, ny, edge || null);
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
  // 退出 mini：停止打字事件转发
  setTypingForward(false);

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
  // 退出 mini：任务栏图标恢复
  mainWindow.setSkipTaskbar(false);
  // 带 edge 通知渲染层：从贴近 mini 球的角展开（左→左下、右→右下…）
  mainWindow.webContents.send('snap-state-changed', false, edge || null);

  // 平滑展开：从 mini 球位置动画到目标位置（期间保持置顶，动画结束后恢复用户置顶设置）
  animateWindowBounds(miniBounds, targetBounds, 200, () => {
    // 退出 mini：恢复用户选择的窗口材质（亚克力 / 半透明）
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setBackgroundMaterial(currentMaterial === 'acrylic' ? 'acrylic' : 'none');
    } catch (_) {}
    applyPinState(); // 内部用 isPinned(用户设置)决定是否置顶
  });
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

  // 查询系统实际的开机自启状态（以注册表为准，防止与设置文件不一致）
  ipcMain.handle('get-auto-start', () => {
    try {
      return !!app.getLoginItemSettings().openAtLogin;
    } catch (_) {
      return false;
    }
  });

  // 扫描 mini-gifs/ 目录，发现所有可用动画主题
  // 命名规范：{主题名}-{序号}.gif（闲时轮换）、{主题名}-slow.gif、{主题名}-fast.gif
  // 返回 [{ name, idle: [gif1, gif2, ...], slow, fast, thumb }]
  ipcMain.handle('scan-gif-themes', async () => {
    try {
      const dir = path.join(__dirname, 'mini-gifs');
      if (!existsSync(dir)) return [];
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.gif'));
      const themes = {}; // { 主题名: { idle: [], slow: null, fast: null } }
      for (const file of files) {
        const base = file.slice(0, -4); // 去掉 .gif
        const lastDash = base.lastIndexOf('-');
        if (lastDash === -1) continue;
        const themeName = base.slice(0, lastDash);
        const suffix = base.slice(lastDash + 1);
        if (!themeName) continue;
        if (!themes[themeName]) themes[themeName] = { idle: [], slow: null, fast: null };
        if (suffix === 'slow') {
          themes[themeName].slow = file;
        } else if (suffix === 'fast') {
          themes[themeName].fast = file;
        } else if (/^\d+$/.test(suffix)) {
          themes[themeName].idle.push({ file, index: parseInt(suffix, 10) });
        }
      }
      return Object.entries(themes)
        .map(([name, t]) => ({
          name,
          idle: t.idle.sort((a, b) => a.index - b.index).map((x) => x.file),
          slow: t.slow,
          fast: t.fast,
          thumb: t.idle.length > 0 ? t.idle[0].file : null,
        }))
        .filter((t) => t.idle.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error('扫描 GIF 主题失败：', err);
      return [];
    }
  });

  // 打开独立的设置窗口
  ipcMain.on('open-settings', () => openSettingsWindow());
  ipcMain.on('open-custom-theme', (_e, editId) => openCustomThemeWindow(editId || null));

  // 窗口材质（经典 / 半透明 / 亚克力）—— 系统级亚克力（Windows 11 22H2+）；
  // 透明窗口上 DWM 不渲染 backdrop material（Electron #48031），以 CSS 磨砂效果为主
  ipcMain.on('set-window-material', (_e, material) => {
    currentMaterial = ['opaque', 'translucent', 'acrylic'].includes(material) ? material : 'opaque';
    if (isSnapped) return; // mini 态保持 none（只有球可见），退出时由 exitSnapped 恢复
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setBackgroundMaterial(currentMaterial === 'acrylic' ? 'acrylic' : 'none');
    } catch (_) { /* 系统不支持时忽略（如 Windows 10） */ }
  });

  // mini 态鼠标穿透：透明窗口矩形会拦截点击（球周围透明边缘挡住下层软件），
  // 通过 setIgnoreMouseEvents 让球外区域点击穿透；forward 保留 mousemove，
  // 渲染层据此在鼠标移入球时恢复捕获（球可点击）。
  ipcMain.on('set-ignore-mouse', (_e, ignore) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setIgnoreMouseEvents(!!ignore, ignore ? { forward: true } : undefined);
    } catch (_) {}
  });

  // ===== 自动更新（GitHub Releases） =====
  ipcMain.handle('update-check', (_e, notifyUpToDate) => checkForUpdates(!!notifyUpToDate));
  ipcMain.handle('update-install', () => installUpdate());
  // 当前应用版本（设置页「软件更新」显示）
  ipcMain.handle('get-app-version', () => app.getVersion());
  // 更新状态广播给渲染层（主窗口 / 设置窗口）
  ipcMain.on('update-listen', (e) => {
    // 客户端注册监听后立即回一条当前状态（无状态则忽略）
    if (e.sender) e.sender.send('update-status', { state: 'listening' });
  });

  // 主窗口尺寸预设（设置页「外观 → 窗口比例」）
  ipcMain.on('set-window-size', (_e, key, size) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isSnapped) return; // mini 态不调整
    let w = null;
    let h = null;
    if (key === 'custom' && size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
      w = Math.round(size.width);
      h = Math.round(size.height);
    } else {
      const preset = WINDOW_SIZES[key] || WINDOW_SIZES['default'];
      w = preset.width;
      h = preset.height;
    }
    w = Math.max(380, w);
    h = Math.max(380, h);
    mainWindow.setSize(w, h);
  });

  // 查询主窗口当前尺寸（自定义尺寸弹窗打开时用）——优先渲染层上报的 CSS 视口尺寸
  ipcMain.handle('get-window-size', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { width: 560, height: 620 };
    if (lastMainWindowSize) return { ...lastMainWindowSize };
    const [w, h] = mainWindow.getContentSize();
    return { width: w, height: h };
  });

  // 主窗口渲染层上报 CSS 视口尺寸（innerWidth/innerHeight，最准确），
  // 存储并转发给设置窗口（自定义尺寸弹窗实时同步）
  ipcMain.on('report-window-size', (_e, size) => {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    lastMainWindowSize = { width: Math.round(size.width), height: Math.round(size.height) };
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('window-resized', lastMainWindowSize);
    }
  });

  // ===== 数据保存位置 =====
  ipcMain.handle('storage-get-info', () => ({
    dir: STORAGE_DIR,
    defaultDir: defaultStorageDir(),
    noteFile: noteFile(),
    settingsFile: settingsFile(),
    isDefault: STORAGE_DIR === defaultStorageDir()
  }));
  ipcMain.handle('storage-choose-dir', async () => {
    const result = await dialog.showOpenDialog(settingsWindow, {
      title: '选择数据保存目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, dir: result.filePaths[0] };
  });
  // 在资源管理器中打开当前存储位置
  ipcMain.handle('storage-open-dir', async () => {
    try {
      await fs.mkdir(STORAGE_DIR, { recursive: true });
      const err = await shell.openPath(STORAGE_DIR);
      return { ok: !err, error: err || null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle('storage-set-dir', async (_e, dir) => {
    try {
      if (!dir || typeof dir !== 'string') return { ok: false, error: '无效路径' };
      const target = path.resolve(dir);
      await fs.mkdir(target, { recursive: true });
      // 新目录无数据时，从旧目录复制现有数据（避免更换位置导致数据丢失）
      const srcNote = path.join(STORAGE_DIR, 'note.json');
      const dstNote = path.join(target, 'note.json');
      if (existsSync(srcNote) && !existsSync(dstNote)) {
        await fs.copyFile(srcNote, dstNote);
      }
      const srcSettings = path.join(STORAGE_DIR, 'settings.json');
      const dstSettings = path.join(target, 'settings.json');
      if (existsSync(srcSettings) && !existsSync(dstSettings)) {
        await fs.copyFile(srcSettings, dstSettings);
      }
      STORAGE_DIR = target;
      await fs.writeFile(storageConfigPath(), JSON.stringify({ dir: target }, null, 2), 'utf8');
      // 通知主窗口重新加载新位置的数据
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('storage-changed');
      }
      return { ok: true, dir: target };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

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

  // 真正退出软件（关闭按钮弹窗「关闭软件」）
  ipcMain.on('window-quit', () => {
    isQuitting = true;
    app.quit();
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
    let nx = b.x + (dx || 0);
    let ny = b.y + (dy || 0);
    if (isSnapped) {
      // mini 球拖动时夹在 workArea 内，四周留 EDGE_MARGIN(10px) 安全边距，防止拖出屏幕
      const wa = getNearestWorkArea();
      if (wa) {
        nx = Math.max(wa.x + EDGE_MARGIN, Math.min(nx, wa.x + wa.width - MINI_SIZE - EDGE_MARGIN));
        ny = Math.max(wa.y + EDGE_MARGIN, Math.min(ny, wa.y + wa.height - MINI_SIZE - EDGE_MARGIN));
      }
    }
    mainWindow.setBounds({ x: Math.round(nx), y: Math.round(ny) });
  });
}

// ======= 自动更新（GitHub Releases） =======
// electron-updater 仅在生产打包后生效；开发模式（npm start）自动跳过，避免报错。
let updateChecking = false; // 避免重复检查

/** 把更新状态广播给所有窗口（主窗口 / 设置窗口） */
function broadcastUpdate(payload) {
  const targets = [mainWindow, settingsWindow].filter((w) => w && !w.isDestroyed());
  for (const w of targets) w.webContents.send('update-status', payload);
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true; // 发现新版自动下载（下载完再询问安装）

  autoUpdater.on('checking-for-update', () => {
    broadcastUpdate({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    broadcastUpdate({ state: 'available', version: info && info.version });
  });
  autoUpdater.on('update-not-available', () => {
    broadcastUpdate({ state: 'up-to-date' });
  });
  autoUpdater.on('download-progress', (p) => {
    broadcastUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    broadcastUpdate({ state: 'downloaded', version: info && info.version });
  });
  autoUpdater.on('error', (err) => {
    console.error('[updater] 错误：', err && err.message);
    broadcastUpdate({ state: 'error', message: err && err.message });
  });
}

/** 触发检查更新（供启动 / 设置窗口按钮调用） */
async function checkForUpdates(notifyUpToDate) {
  if (updateChecking) return { ok: false, reason: 'checking' };
  if (!app.isPackaged) {
    // 开发模式：electron-updater 需要打包后的 app-update.yml，直接跳过
    if (notifyUpToDate) broadcastUpdate({ state: 'dev-mode' });
    return { ok: false, reason: 'dev-mode' };
  }
  updateChecking = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    updateChecking = false;
    return { ok: true, updateInfo: result && result.updateInfo };
  } catch (err) {
    updateChecking = false;
    console.error('[updater] 检查失败：', err && err.message);
    return { ok: false, error: err && err.message };
  }
}

/** 下载完成后安装并重启（先保存再退出） */
function installUpdate() {
  if (!app.isPackaged) return { ok: false, reason: 'dev-mode' };
  isQuitting = true;
  autoUpdater.quitAndInstall();
  return { ok: true };
}

app.whenReady().then(() => {
  initStorageDir();
  registerIpc();
  createWindow();
  createTray();
  setupAutoUpdater();
  // 启动全局键盘监听进程（常驻；Add-Type 首次编译需数秒，提前启动避免 mini 时才编译）
  startKeyMonitor();

  // 同步开机自启设置到系统（默认关闭；设置开启时写入注册表）
  loadSettings().then((s) => syncAutoStart(!!s.autoStart)).catch(() => {});

  // 启动后延迟几秒再检查更新，避免拖慢首次启动
  setTimeout(() => {
    checkForUpdates(false);
  }, 5000);

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
  stopKeyMonitor();
});
