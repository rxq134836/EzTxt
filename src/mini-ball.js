/**
 * mini 球独立窗口渲染层（mini-ball.html 专用）。
 * 仅在「系统毛玻璃（实验）」模式下由主进程创建此窗口：
 * 主窗口为非透明系统亚克力窗口时无法原位缩成球，故把球拆到独立透明窗口。
 * 交互与主窗口内的 legacy mini 球保持一致：
 *   - 单击展开（exitMini）；拖动跟手（moveWindow）
 *   - 球外区域点击穿透（setIgnoreMouse + forward mousemove）
 *   - GIF 动画球：闲时轮换 / 打字状态切换（typing-activity）
 *   - 待办计数实时跟随（note-changed）
 */
(function () {
  'use strict';
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);
  const miniBar = $('#miniBar');
  const miniCount = $('#miniCount');

  const settings = {
    theme: 'amber',
    customThemeId: null,
    customThemes: [],
    miniBallStyle: 'classic',
    miniBallGif: 'remi'
  };

  let miniGifThemes = [];
  let miniGifIndex = 0;

  // ===== 主题 =====
  function applyTheme() {
    const key = settings.theme;
    if (key === 'custom') {
      const item = (settings.customThemes || []).find((t) => t.id === settings.customThemeId);
      if (item) {
        api.applyCustomThemeVars(item);
        document.body.dataset.theme = 'custom';
        return;
      }
      api.clearCustomThemeVars();
      document.body.dataset.theme = 'amber';
      return;
    }
    api.clearCustomThemeVars();
    document.body.dataset.theme = key || 'amber';
  }

  // ===== GIF 动画球（与 renderer.js 同一套命名规范与轮换逻辑） =====
  function isMiniGifActive() {
    return settings.miniBallStyle === 'gif';
  }
  function currentGifTheme() {
    const name = settings.miniBallGif || 'remi';
    return miniGifThemes.find((t) => t.name === name) || miniGifThemes[0] || null;
  }
  async function loadGifThemes() {
    try {
      if (api.scanGifThemes) miniGifThemes = await api.scanGifThemes();
    } catch (_) {
      miniGifThemes = [];
    }
  }
  function miniGifUrl(name) {
    const theme = currentGifTheme();
    if (theme && theme.basePath) return theme.basePath + name;
    return './mini-gifs/' + name;
  }
  function applyMiniGif() {
    if (!isMiniGifActive()) {
      miniBar.classList.remove('is-gif');
      miniBar.style.backgroundImage = '';
      return;
    }
    const theme = currentGifTheme();
    if (!theme || !theme.idle || theme.idle.length === 0) {
      miniBar.classList.remove('is-gif');
      miniBar.style.backgroundImage = '';
      return;
    }
    miniBar.classList.add('is-gif');
    if (currentTypingGif) {
      miniBar.style.backgroundImage = `url(${miniGifUrl(currentTypingGif)})`;
    } else {
      const gif = theme.idle[miniGifIndex % theme.idle.length];
      miniGifIndex = (miniGifIndex + 1) % theme.idle.length;
      miniBar.style.backgroundImage = `url(${miniGifUrl(gif)})`;
    }
  }

  // ===== 打字状态 GIF（慢→slow / 快且持续→fast / 暂停 2s 恢复轮换） =====
  const TYPE_PAUSE_REVERT_MS = 2000;
  const TYPE_FAST_INTERVAL = 250;
  const TYPE_SLOW_INTERVAL = 450;
  const TYPE_SUSTAINED_MS = 1500;
  const TYPE_WINDOW_SIZE = 15;

  let typeKeystrokes = [];
  let typingGifTimer = null;
  let currentTypingGif = null;

  function setTypingGif(gif) {
    if (currentTypingGif === gif) return;
    currentTypingGif = gif;
    if (isMiniGifActive()) {
      miniBar.style.backgroundImage = `url(${miniGifUrl(gif)})`;
    }
  }
  function revertTypingGif() {
    currentTypingGif = null;
    typeKeystrokes = [];
    if (isMiniGifActive()) {
      const theme = currentGifTheme();
      if (theme && theme.idle && theme.idle.length > 0) {
        const gif = theme.idle[miniGifIndex % theme.idle.length];
        miniGifIndex = (miniGifIndex + 1) % theme.idle.length;
        miniBar.style.backgroundImage = `url(${miniGifUrl(gif)})`;
      }
    }
  }
  function onTypingActivity() {
    if (!isMiniGifActive()) return;
    const theme = currentGifTheme();
    if (!theme) return;
    const now = Date.now();
    typeKeystrokes.push(now);
    if (typeKeystrokes.length > TYPE_WINDOW_SIZE) typeKeystrokes.shift();
    clearTimeout(typingGifTimer);
    if (typeKeystrokes.length >= 3) {
      const span = typeKeystrokes[typeKeystrokes.length - 1] - typeKeystrokes[0];
      const avgInterval = span / (typeKeystrokes.length - 1);
      if (avgInterval < TYPE_FAST_INTERVAL && span > TYPE_SUSTAINED_MS) {
        if (theme.fast) setTypingGif(theme.fast);
      } else if (avgInterval > TYPE_SLOW_INTERVAL) {
        if (theme.slow) setTypingGif(theme.slow);
      }
    }
    typingGifTimer = setTimeout(revertTypingGif, TYPE_PAUSE_REVERT_MS);
  }

  // ===== 待办计数 =====
  async function updateCount() {
    try {
      const doc = await api.loadNote();
      const items = Array.isArray(doc && doc.items) ? doc.items : [];
      const pending = items.filter((it) => it.title !== '__DIVIDER__' && !it.done).length;
      miniCount.textContent = String(pending);
    } catch (_) { /* 保持原值 */ }
  }

  // ===== 设置 / 主题刷新（settings-changed 广播时） =====
  let refreshing = false;
  async function refreshSettings() {
    if (refreshing) return;
    refreshing = true;
    try {
      const s = await api.loadSettings();
      if (s) Object.assign(settings, s);
      applyTheme();
      await loadGifThemes();
      applyMiniGif();
      await updateCount();
    } catch (_) {
    } finally {
      refreshing = false;
    }
  }

  // ===== 鼠标穿透（球外穿透、移入球恢复捕获，圆形用中心距判断） =====
  let ignoreHover = false;
  function updateMouseIgnore(e) {
    const r = miniBar.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const radius = r.width / 2;
    const inside = Math.hypot(e.clientX - cx, e.clientY - cy) <= radius;
    if (inside !== ignoreHover) {
      ignoreHover = inside;
      if (api.setIgnoreMouse) api.setIgnoreMouse(!inside);
    }
  }
  document.addEventListener('mousemove', updateMouseIgnore);

  // ===== 点击 vs 拖动（与主窗口 legacy mini 球同一套阈值） =====
  let downStart = null;      // { screenX, screenY, lastScreenX, lastScreenY, time }
  let isDragging = false;
  const CLICK_DIST_THRESHOLD = 5;
  const CLICK_TIME_THRESHOLD = 250;

  miniBar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    downStart = {
      screenX: e.screenX, screenY: e.screenY,
      lastScreenX: e.screenX, lastScreenY: e.screenY,
      time: Date.now()
    };
    isDragging = false;
    try { miniBar.setPointerCapture(e.pointerId); } catch (_) {}
  });

  miniBar.addEventListener('pointermove', (e) => {
    if (!downStart) return;
    const s = downStart;
    const totalDx = e.screenX - s.screenX;
    const totalDy = e.screenY - s.screenY;
    const dist = Math.hypot(totalDx, totalDy);
    if (!isDragging && dist > CLICK_DIST_THRESHOLD) {
      isDragging = true;
      miniBar.classList.add('is-dragging');
    }
    if (isDragging) {
      api.moveWindow(e.screenX - s.lastScreenX, e.screenY - s.lastScreenY);
      s.lastScreenX = e.screenX;
      s.lastScreenY = e.screenY;
    }
  });

  miniBar.addEventListener('pointerup', (e) => {
    if (!downStart) return;
    const s = downStart;
    const downMs = Date.now() - s.time;
    const totalDx = e.screenX - s.screenX;
    const totalDy = e.screenY - s.screenY;
    const dist = Math.hypot(totalDx, totalDy);
    miniBar.classList.remove('is-dragging');
    try { miniBar.releasePointerCapture(e.pointerId); } catch (_) {}
    const wasClick = !isDragging && dist < CLICK_DIST_THRESHOLD && downMs < CLICK_TIME_THRESHOLD;
    downStart = null;
    isDragging = false;
    if (wasClick && api.exitMini) api.exitMini();
  });

  miniBar.addEventListener('pointercancel', () => {
    miniBar.classList.remove('is-dragging');
    downStart = null;
    isDragging = false;
  });

  // ===== IPC 监听 =====
  if (api.onMiniShow) {
    api.onMiniShow(() => {
      // 每次弹出球时同步计数与 gif（窗口可能已隐藏很久）
      updateCount();
      applyMiniGif();
    });
  }
  if (api.onNoteChanged) api.onNoteChanged(updateCount);
  if (api.onSettingsChanged) api.onSettingsChanged(refreshSettings);
  if (api.onTypingActivity) api.onTypingActivity(onTypingActivity);

  // 初始化：默认穿透（球外可点击下层软件），随后加载设置与主题
  if (api.setIgnoreMouse) api.setIgnoreMouse(true);
  refreshSettings();
})();
