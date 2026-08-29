'use strict';

/**
 * EzTxt 独立设置窗口 —— 渲染进程逻辑
 * 功能：外观（主题 / 字体大小 / 背景图）+ 编辑器快捷键（开关 / 改绑）。
 * 所有修改通过 api.saveSettings 持久化；主进程会广播 settings-changed，
 * 主窗口即时重新加载应用（无需本窗口额外通知）。
 */
(function () {
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);

  const themeSwatches = $('#themeSwatches');
  const materialOptionsEl = $('#materialOptions');
  const closeActionOptionsEl = $('#closeActionOptions');
  const windowSizeOptionsEl = $('#windowSizeOptions');
  const bgOpacityBlock = $('#bgOpacityBlock');
  const acrylicBlurBlock = $('#acrylicBlurBlock');
  const acrylicBlurSlider = $('#acrylicBlur');
  const acrylicBlurValueEl = $('#acrylicBlurValue');
  const fontSizeSliderEl = $('#fontSizeSlider');
  const fontSizeValueEl = $('#fontSizeValue');
  const btnUploadBg = $('#btnUploadBg');
  const btnRemoveBg = $('#btnRemoveBg');
  const bgOpacitySlider = $('#bgOpacity');
  const bgOpacityValueEl = $('#bgOpacityValue');
  const bgFileInput = $('#bgFileInput');
  const shortcutListEl = $('#shortcutList');
  const winClose = $('#winClose');

  let settings = { theme: 'amber', material: 'opaque', acrylicBlur: 40, bgImage: null, bgOpacity: 0.35, fontSize: 13, closeAction: 'tray', windowSize: 'default', customWindowSize: { width: 560, height: 620 }, shortcuts: {} };
  let isLoadingSettings = false;
  let capturingShortcut = null;

  // ===== 主题 =====
  const THEMES = [
    { key: 'amber',      name: '琥珀', accent: '#e0a82e', bg: '#FAF5E1', ink: '#4a3f24' },
    { key: 'blue',       name: '深蓝', accent: '#2B5275', bg: '#FFFBBD', ink: '#1a2a3a' },
    { key: 'olive',      name: '墨绿', accent: '#4D5E30', bg: '#F5F0D4', ink: '#2a3319' },
    { key: 'terracotta', name: '砖红', accent: '#D16647', bg: '#F5EAD4', ink: '#3d2a1a' },
    { key: 'gold',       name: '棕金', accent: '#BCA052', bg: '#F5EAD4', ink: '#4A3C2B' },
    { key: 'rose',       name: '酒红', accent: '#954B44', bg: '#F5E5E0', ink: '#3a1f1b' },
    { key: 'sage',       name: '草绿', accent: '#A68329', bg: '#F5F0D4', ink: '#3a2f14' },
    { key: 'night',      name: '纯黑', accent: '#E8B84B', bg: '#16161A', ink: '#F0F0F2' },
    { key: 'paper',      name: '纯白', accent: '#2B5275', bg: '#FFFFFF', ink: '#1A1A1A' }
  ];

  function applyTheme(key) {
    if (!THEMES.find((t) => t.key === key)) key = 'amber';
    document.body.dataset.theme = key;
    settings.theme = key;
    renderThemeSwatches();
    api.saveSettings({ theme: key });
  }

  function renderThemeSwatches() {
    themeSwatches.innerHTML = '';
    for (const t of THEMES) {
      const btn = document.createElement('button');
      btn.className = 'theme-swatch' + (t.key === settings.theme ? ' is-active' : '');
      btn.type = 'button';
      btn.title = t.name;
      btn.style.background = t.bg;
      btn.innerHTML = `<span class="swatch-accent" style="background:${t.accent}"></span>`;
      btn.addEventListener('click', () => applyTheme(t.key));
      themeSwatches.appendChild(btn);
    }
  }

  // ===== 材质（经典 / 半透明 / 亚克力） =====
  // 亚克力暂时隐藏（UI 不可选）；旧配置若残留 acrylic，加载时回退为半透明
  const MATERIALS = ['opaque', 'translucent'];
  const HIDDEN_MATERIALS = ['acrylic'];

  /** 设置窗口自身立即套用材质样式（磨砂观感跟随主窗口） */
  function applyMaterial(material) {
    let val = MATERIALS.includes(material) ? material : 'opaque';
    if (HIDDEN_MATERIALS.includes(material)) val = 'translucent'; // 隐藏材质回退
    settings.material = val;
    document.body.dataset.material = val;
    renderMaterialOptions();
    updateBgOpacityVisibility();
    updateAcrylicBlurVisibility();
  }

  function renderMaterialOptions() {
    materialOptionsEl.querySelectorAll('.material-btn').forEach((btn) => {
      const active = btn.dataset.material === settings.material;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  /** 透明度滑杆只对半透明材质有意义（控制窗口/背景的浓淡）；经典不透明、亚克力磨砂都隐藏 */
  function updateBgOpacityVisibility() {
    bgOpacityBlock.classList.toggle('hidden', settings.material !== 'translucent');
  }

  /** 磨砂感滑杆只在亚克力材质下出现 */
  function updateAcrylicBlurVisibility() {
    acrylicBlurBlock.classList.toggle('hidden', settings.material !== 'acrylic');
  }

  function onMaterialSelect(material) {
    if (material === settings.material) return;
    applyMaterial(material);
    api.saveSettings({ material: settings.material });
  }

  // ===== 关闭按钮行为（缩小到托盘 / 退出软件） =====
  function applyCloseAction(action) {
    const val = action === 'quit' ? 'quit' : 'tray';
    settings.closeAction = val;
    renderCloseActionOptions();
  }

  function renderCloseActionOptions() {
    closeActionOptionsEl.querySelectorAll('.material-btn').forEach((btn) => {
      const active = btn.dataset.close === settings.closeAction;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function onCloseActionSelect(action) {
    if (action === settings.closeAction) return;
    applyCloseAction(action);
    api.saveSettings({ closeAction: settings.closeAction });
  }

  // ===== 主窗口尺寸预设（外观 → 窗口比例） =====
  const WINDOW_SIZE_KEYS = ['default', 'landscape-wide', 'landscape', 'portrait-narrow', 'portrait', 'custom'];

  function applyWindowSize(key) {
    const val = WINDOW_SIZE_KEYS.includes(key) ? key : 'default';
    settings.windowSize = val;
    renderWindowSizeOptions();
  }

  function renderWindowSizeOptions() {
    windowSizeOptionsEl.querySelectorAll('.window-size-btn').forEach((btn) => {
      const active = btn.dataset.size === settings.windowSize;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function onWindowSizeSelect(key) {
    // 自定义：无论当前是否已是自定义，点击都重新弹出弹窗
    if (key === 'custom') { openCustomSizeDialog(); return; }
    if (key === settings.windowSize) return;
    applyWindowSize(key);
    api.saveSettings({ windowSize: settings.windowSize });
    if (api.setWindowSize) api.setWindowSize(key);
  }

  // ---- 自定义尺寸弹窗（输入宽高） ----
  const customSizeMask = $('#customSizeMask');
  const customSizeWidthEl = $('#customSizeWidth');
  const customSizeHeightEl = $('#customSizeHeight');
  const btnCustomSizeSave = $('#btnCustomSizeSave');
  const btnCustomSizeCancel = $('#btnCustomSizeCancel');

  const CUSTOM_MIN = 380;   // 与主进程 minWidth/minHeight 一致

  /** 仅保证最小值（同步主窗口真实尺寸 / 保存时不截断上限） */
  function ensureMin(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(CUSTOM_MIN, n) : CUSTOM_MIN;
  }

  function openCustomSizeDialog() {
    customSizeMask.classList.remove('hidden');
    // 初始数值：跟随主窗口当前尺寸（实时）——显示真实视口，不截断上限
    if (api.getWindowSize) {
      api.getWindowSize().then((size) => {
        if (size && !customSizeMask.classList.contains('hidden')) {
          customSizeWidthEl.value = String(ensureMin(size.width));
          customSizeHeightEl.value = String(ensureMin(size.height));
        }
      }).catch(() => {});
    }
    customSizeWidthEl.focus();
    customSizeWidthEl.select();
  }

  /** 主窗口尺寸变化 → 弹窗数值实时跟随（仅弹窗打开时更新输入框，显示真实值） */
  function onMainWindowResized(size) {
    if (!size || customSizeMask.classList.contains('hidden')) return;
    customSizeWidthEl.value = String(ensureMin(size.width));
    customSizeHeightEl.value = String(ensureMin(size.height));
  }

  function closeCustomSizeDialog() {
    customSizeMask.classList.add('hidden');
    renderWindowSizeOptions(); // 关闭后回显原选择
  }

  function saveCustomSize() {
    // 与主进程一致：只钳最小 380，不设硬上限（主进程 setSize 受屏幕限制自然处理）
    const width = ensureMin(customSizeWidthEl.value);
    const height = ensureMin(customSizeHeightEl.value);
    customSizeWidthEl.value = String(width);
    customSizeHeightEl.value = String(height);
    settings.windowSize = 'custom';
    settings.customWindowSize = { width, height };
    closeCustomSizeDialog();
    renderWindowSizeOptions();
    api.saveSettings({ windowSize: 'custom', customWindowSize: { width, height } });
    if (api.setWindowSize) api.setWindowSize('custom', { width, height });
  }

  // ===== 亚克力磨砂强度 =====
  function applyAcrylicBlur(value) {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(60, Math.round(value))) : 40;
    settings.acrylicBlur = v;
    acrylicBlurSlider.value = String(v);
    acrylicBlurValueEl.textContent = String(v);
    document.documentElement.style.setProperty('--acrylic-blur', v + 'px');
  }

  // 拖动高频触发 → 防抖保存
  let acrylicBlurTimer = null;
  function onAcrylicBlurChange() {
    if (isLoadingSettings) return;
    const v = parseFloat(acrylicBlurSlider.value);
    applyAcrylicBlur(v);
    clearTimeout(acrylicBlurTimer);
    acrylicBlurTimer = setTimeout(() => api.saveSettings({ acrylicBlur: v }), 150);
  }

  // ===== 字体大小 =====
  function applyFontSize(size) {
    const v = Number.isFinite(size) ? size : 13;
    settings.fontSize = v;
    document.documentElement.style.setProperty('--font-size', v + 'px');
    fontSizeValueEl.textContent = v + 'px';
    fontSizeSliderEl.value = String(v);
  }

  function onFontSizeChange() {
    if (isLoadingSettings) return;
    const v = parseFloat(fontSizeSliderEl.value);
    applyFontSize(v);
    api.saveSettings({ fontSize: v });
  }

  // ===== 背景图（含最近上传历史，最多 10 张） =====
  const BG_HISTORY_MAX = 10;
  const bgHistoryEl = $('#bgHistory');
  const btnManageBg = $('#btnManageBg');
  const btnDeleteBg = $('#btnDeleteBg');
  const confirmMask = $('#confirmMask');
  const confirmText = $('#confirmText');
  const btnConfirmOk = $('#btnConfirmOk');
  const btnConfirmCancel = $('#btnConfirmCancel');
  const btnChangeStorage = $('#btnChangeStorage');
  const btnOpenStorage = $('#btnOpenStorage');
  const storageDirEl = $('#storageDir');
  const storageNoteFileEl = $('#storageNoteFile');
  const storageSettingsFileEl = $('#storageSettingsFile');
  const storageHintEl = $('#storageHint');

  let bgManageMode = false;      // 历史列表管理模式（批量选择删除）
  let bgSelected = new Set();    // 选中的背景图 dataURL
  const bgManageActions = $('#bgManageActions');
  const btnBgCancel = $('#btnBgCancel');

  function applyBgImage(dataURL) {
    if (dataURL) {
      settings.bgImage = dataURL;
    } else {
      settings.bgImage = null;
    }
  }

  /**
   * 读取图片并压缩为 dataURL（最长边 ≤1600px，JPEG 0.85）。
   * 压缩后再入历史，避免 10 张原图把 settings.json 撑爆。
   */
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const MAX = 1600;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            const scale = MAX / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function handleBgUpload() {
    bgFileInput.click();
  }

  async function onBgFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataURL = await fileToDataURL(file);
      // 新图放到最前；去重；超过 10 张丢弃最旧的（FIFO）
      const history = [dataURL, ...(settings.bgHistory || []).filter((u) => u !== dataURL)]
        .slice(0, BG_HISTORY_MAX);
      settings.bgHistory = history;
      applyBgImage(dataURL);
      renderBgHistory();
      api.saveSettings({ bgImage: dataURL, bgHistory: history });
    } catch (err) {
      console.error('背景图处理失败：', err);
    }
    e.target.value = '';
  }

  function handleBgRemove() {
    applyBgImage(null);
    api.saveSettings({ bgImage: null });
  }

  /** 渲染最近上传缩略图；正常模式点击切换，管理模式点击多选 */
  function renderBgHistory() {
    const list = settings.bgHistory || [];
    bgHistoryEl.innerHTML = '';
    if (list.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'bg-history-hint';
      hint.textContent = '暂无历史背景，上传后会显示在这里';
      bgHistoryEl.appendChild(hint);
      updateBgManageUI();
      return;
    }
    for (const url of list) {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'bg-thumb' + (url === settings.bgImage ? ' is-active' : '');
      thumb.dataset.url = url;
      thumb.title = url === settings.bgImage ? '当前背景' : '点击切换为此背景';
      thumb.style.backgroundImage = `url(${url})`;
      thumb.addEventListener('click', () => {
        if (bgManageMode) {
          toggleBgSelect(url);
          return;
        }
        if (url === settings.bgImage) return;
        applyBgImage(url);
        renderBgHistory();
        api.saveSettings({ bgImage: url });
      });
      bgHistoryEl.appendChild(thumb);
    }
    updateBgManageUI();
  }

  /** 管理模式：切换选中 */
  function toggleBgSelect(url) {
    if (bgSelected.has(url)) bgSelected.delete(url);
    else bgSelected.add(url);
    updateBgManageUI();
  }

  /** 刷新管理模式 UI：删除按钮可见/计数 + 缩略图选中样式 */
  function updateBgManageUI() {
    const n = bgSelected.size;
    btnDeleteBg.classList.toggle('hidden', n === 0);
    btnDeleteBg.textContent = `删除选中 (${n})`;
    bgHistoryEl.querySelectorAll('.bg-thumb').forEach((t) => {
      t.classList.toggle('is-selected', bgSelected.has(t.dataset.url));
    });
  }

  function toggleBgManageMode() {
    bgManageMode = !bgManageMode;
    bgSelected.clear();
    bgHistoryEl.classList.toggle('is-managing', bgManageMode);
    btnManageBg.classList.toggle('is-active', bgManageMode);
    bgManageActions.classList.toggle('hidden', !bgManageMode);
    updateBgManageUI();
  }

  function openBgDeleteConfirm() {
    const n = bgSelected.size;
    if (n === 0) return;
    confirmText.textContent = `确定要删除选中的 ${n} 张背景图吗？删除后无法恢复。`;
    confirmMask.classList.remove('hidden');
    btnConfirmOk.focus();
  }

  function closeBgConfirm() {
    confirmMask.classList.add('hidden');
  }

  /** 确认删除选中的历史背景；当前背景被删则移除背景 */
  function doBgDelete() {
    const urls = [...bgSelected];
    closeBgConfirm();
    settings.bgHistory = (settings.bgHistory || []).filter((u) => !urls.includes(u));
    if (settings.bgImage && urls.includes(settings.bgImage)) {
      settings.bgImage = null;
    }
    if (bgManageMode) toggleBgManageMode();
    renderBgHistory();
    api.saveSettings({ bgImage: settings.bgImage, bgHistory: settings.bgHistory });
  }

  // 透明度滑杆拖动会高频触发 input → 防抖后再保存（主进程写入队列兜底防并发损坏）
  let bgOpacityTimer = null;
  function onBgOpacityChange() {
    if (isLoadingSettings) return;
    const v = parseFloat(bgOpacitySlider.value);
    settings.bgOpacity = v;
    bgOpacityValueEl.textContent = v.toFixed(2);
    clearTimeout(bgOpacityTimer);
    bgOpacityTimer = setTimeout(() => api.saveSettings({ bgOpacity: v }), 150);
  }

  // ===== 快捷键 =====
  const DEFAULT_SHORTCUTS = {
    bold:          { enabled: true, key: 'b', ctrl: true,  shift: false, alt: false, label: '加粗' },
    italic:        { enabled: true, key: 'i', ctrl: true,  shift: false, alt: false, label: '斜体' },
    inlineCode:    { enabled: true, key: 'k', ctrl: true,  shift: false, alt: false, label: '行内代码' },
    codeBlock:     { enabled: true, key: 'k', ctrl: true,  shift: true,  alt: false, label: '代码块' },
    orderedList:   { enabled: true, key: '[', ctrl: true,  shift: true,  alt: false, label: '有序列表' },
    unorderedList: { enabled: true, key: ']', ctrl: true,  shift: true,  alt: false, label: '无序列表' }
  };

  function formatCombo(c) {
    if (!c || !c.key) return '未绑定';
    const parts = [];
    if (c.ctrl) parts.push('Ctrl');
    if (c.alt) parts.push('Alt');
    if (c.shift) parts.push('Shift');
    const k = String(c.key);
    parts.push(k.length === 1 ? k.toUpperCase() : k);
    return parts.join('+');
  }

  function shortcutsPayload() {
    const out = {};
    for (const [name, def] of Object.entries(DEFAULT_SHORTCUTS)) {
      const s = settings.shortcuts[name] || def;
      out[name] = { enabled: !!s.enabled, key: s.key || '', ctrl: !!s.ctrl, shift: !!s.shift, alt: !!s.alt };
    }
    return out;
  }

  function saveShortcuts() {
    api.saveSettings({ shortcuts: shortcutsPayload() });
  }

  function renderShortcutList() {
    shortcutListEl.innerHTML = '';
    for (const [name, def] of Object.entries(DEFAULT_SHORTCUTS)) {
      const s = settings.shortcuts[name] || def;
      const row = document.createElement('div');
      row.className = 'shortcut-row' + (s.enabled === false ? ' disabled' : '');

      const label = document.createElement('span');
      label.className = 'shortcut-label';
      label.textContent = def.label;

      const sw = document.createElement('label');
      sw.className = 'switch';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = s.enabled !== false;
      input.title = '启用 / 停用';
      const slider = document.createElement('span');
      slider.className = 'slider';
      sw.appendChild(input);
      sw.appendChild(slider);
      input.addEventListener('change', () => {
        settings.shortcuts[name] = { ...(settings.shortcuts[name] || def), enabled: input.checked };
        saveShortcuts();
        row.classList.toggle('disabled', !input.checked);
      });

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'shortcut-key' + (!s.key ? ' unbound' : '');
      badge.textContent = s.key ? formatCombo(s) : '未绑定';
      badge.title = '点击重新绑定';
      badge.addEventListener('click', () => beginShortcutCapture(name, badge));

      row.appendChild(label);
      row.appendChild(sw);
      row.appendChild(badge);
      shortcutListEl.appendChild(row);
    }
  }

  function beginShortcutCapture(name, badge) {
    capturingShortcut = name;
    document.querySelectorAll('.shortcut-key').forEach((el) => el.classList.remove('capturing'));
    badge.classList.add('capturing');
    badge.textContent = '按下组合键…';
    document.addEventListener('keydown', onShortcutCaptureKeydown, true);
  }

  function endShortcutCapture() {
    if (!capturingShortcut) return;
    capturingShortcut = null;
    document.removeEventListener('keydown', onShortcutCaptureKeydown, true);
    renderShortcutList();
  }

  function onShortcutCaptureKeydown(e) {
    if (!capturingShortcut) return;
    e.preventDefault();
    e.stopPropagation();
    const name = capturingShortcut;
    if (e.key === 'Escape') { endShortcutCapture(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      settings.shortcuts[name] = { enabled: false, key: '', ctrl: false, shift: false, alt: false };
      endShortcutCapture();
      saveShortcuts();
      return;
    }
    const hasMod = e.ctrlKey || e.metaKey || e.altKey;
    const isFn = /^F\d{1,2}$/i.test(e.key);
    if (!hasMod && !isFn) {
      const badge = shortcutListEl.querySelector('.shortcut-key.capturing');
      if (badge) badge.textContent = '需要 Ctrl/Alt 组合';
      return;
    }
    settings.shortcuts[name] = {
      enabled: true,
      key: e.key,
      ctrl: !!(e.ctrlKey || e.metaKey),
      shift: !!e.shiftKey,
      alt: !!e.altKey
    };
    endShortcutCapture();
    saveShortcuts();
  }

  // ===== 加载 =====
  async function loadSettingsState() {
    try {
      isLoadingSettings = true;
      const s = await api.loadSettings();
      Object.assign(settings, s);
      settings.shortcuts = settings.shortcuts || {};
      for (const [name, def] of Object.entries(DEFAULT_SHORTCUTS)) {
        settings.shortcuts[name] = { ...def, ...(settings.shortcuts[name] || {}) };
      }
      document.body.dataset.theme = settings.theme;
      applyFontSize(settings.fontSize);
      // 亚克力已隐藏：旧配置残留 acrylic 时回退为半透明并持久化，避免下次仍生效
      if (HIDDEN_MATERIALS.includes(settings.material)) {
        settings.material = 'translucent';
        api.saveSettings({ material: 'translucent' });
      }
      applyMaterial(settings.material);   // 材质（含透明度/磨砂感设置显隐）
      applyAcrylicBlur(settings.acrylicBlur); // 磨砂强度（仅亚克力生效）
      applyCloseAction(settings.closeAction); // 关闭按钮行为
      applyWindowSize(settings.windowSize);   // 窗口比例预设
      bgOpacitySlider.value = String(settings.bgOpacity);
      bgOpacityValueEl.textContent = Number(settings.bgOpacity).toFixed(2);
      // 历史兼容：老配置只有 bgImage 没有 bgHistory → 用当前图初始化
      if (!Array.isArray(settings.bgHistory) || settings.bgHistory.length === 0) {
        settings.bgHistory = settings.bgImage ? [settings.bgImage] : [];
      }
      renderThemeSwatches();
      renderShortcutList();
      renderBgHistory();
    } catch (_) {
      renderThemeSwatches();
      renderShortcutList();
    } finally {
      isLoadingSettings = false;
    }
  }

  // ===== 数据保存位置 =====
  async function refreshStorageInfo() {
    try {
      const info = await api.getStorageInfo();
      storageDirEl.textContent = info.dir || '—';
      storageNoteFileEl.textContent = info.noteFile || '—';
      storageSettingsFileEl.textContent = info.settingsFile || '—';
      storageHintEl.textContent = info.isDefault
        ? '当前使用默认存储位置。'
        : '当前使用自定义存储位置。';
    } catch (_) {
      storageHintEl.textContent = '读取存储信息失败。';
    }
  }

  async function onChangeStorage() {
    try {
      const chosen = await api.chooseStorageDir();
      if (chosen.canceled || !chosen.dir) return;
      const res = await api.setStorageDir(chosen.dir);
      if (res && res.ok) {
        storageHintEl.textContent = '存储位置已更新。';
        await refreshStorageInfo();
      } else {
        storageHintEl.textContent = '修改失败：' + (res && res.error ? res.error : '未知错误');
      }
    } catch (err) {
      storageHintEl.textContent = '修改失败：' + (err && err.message ? err.message : String(err));
    }
  }

  async function onOpenStorage() {
    try {
      const res = await api.openStorageDir();
      if (res && !res.ok) storageHintEl.textContent = '打开失败：' + (res.error || '');
    } catch (_) {}
  }

  // ===== 事件 =====
  winClose.addEventListener('click', () => window.close());
  materialOptionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.material-btn');
    if (btn && btn.dataset.material) onMaterialSelect(btn.dataset.material);
  });
  closeActionOptionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.material-btn');
    if (btn && btn.dataset.close) onCloseActionSelect(btn.dataset.close);
  });
  windowSizeOptionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.window-size-btn');
    if (btn && btn.dataset.size) onWindowSizeSelect(btn.dataset.size);
  });
  acrylicBlurSlider.addEventListener('input', onAcrylicBlurChange);
  fontSizeSliderEl.addEventListener('input', onFontSizeChange);
  btnUploadBg.addEventListener('click', handleBgUpload);
  btnRemoveBg.addEventListener('click', handleBgRemove);
  bgFileInput.addEventListener('change', onBgFileSelected);
  bgOpacitySlider.addEventListener('input', onBgOpacityChange);
  btnChangeStorage.addEventListener('click', onChangeStorage);
  btnOpenStorage.addEventListener('click', onOpenStorage);

  // 背景历史批量管理
  btnManageBg.addEventListener('click', toggleBgManageMode);
  btnBgCancel.addEventListener('click', toggleBgManageMode);
  btnDeleteBg.addEventListener('click', openBgDeleteConfirm);
  btnConfirmOk.addEventListener('click', doBgDelete);
  btnConfirmCancel.addEventListener('click', closeBgConfirm);
  confirmMask.addEventListener('click', (e) => {
    if (e.target === confirmMask) closeBgConfirm();
  });

  // 自定义窗口尺寸：输入宽高
  btnCustomSizeSave.addEventListener('click', saveCustomSize);
  btnCustomSizeCancel.addEventListener('click', closeCustomSizeDialog);
  customSizeMask.addEventListener('click', (e) => {
    if (e.target === customSizeMask) closeCustomSizeDialog();
  });
  // 回车键在输入框内触发保存
  customSizeWidthEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCustomSize(); }
  });
  customSizeHeightEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCustomSize(); }
  });

  // Esc：关闭自定义尺寸弹窗 → 关闭确认框 → 退出背景管理模式
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!customSizeMask.classList.contains('hidden')) {
      closeCustomSizeDialog();
    } else if (!confirmMask.classList.contains('hidden')) {
      closeBgConfirm();
    } else if (bgManageMode) {
      toggleBgManageMode();
    }
  });

  // 主窗口尺寸变化 → 自定义弹窗数值实时同步
  if (api.onWindowResized) {
    api.onWindowResized(onMainWindowResized);
  }

  loadSettingsState();
  refreshStorageInfo();
})();
