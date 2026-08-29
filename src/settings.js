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
  const bgOpacityBlock = $('#bgOpacityBlock');
  const fontSizeSliderEl = $('#fontSizeSlider');
  const fontSizeValueEl = $('#fontSizeValue');
  const btnUploadBg = $('#btnUploadBg');
  const btnRemoveBg = $('#btnRemoveBg');
  const bgOpacitySlider = $('#bgOpacity');
  const bgOpacityValueEl = $('#bgOpacityValue');
  const bgFileInput = $('#bgFileInput');
  const shortcutListEl = $('#shortcutList');
  const winClose = $('#winClose');

  let settings = { theme: 'amber', material: 'translucent', bgImage: null, bgOpacity: 0.35, fontSize: 13, shortcuts: {} };
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

  // ===== 材质（半透明 / 亚克力） =====
  /** 设置窗口自身立即套用材质样式（磨砂观感跟随主窗口） */
  function applyMaterial(material) {
    const val = material === 'acrylic' ? 'acrylic' : 'translucent';
    settings.material = val;
    document.body.dataset.material = val;
    renderMaterialOptions();
    updateBgOpacityVisibility();
  }

  function renderMaterialOptions() {
    materialOptionsEl.querySelectorAll('.material-btn').forEach((btn) => {
      const active = btn.dataset.material === settings.material;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  /** 亚克力模式下透明度滑杆无意义（磨砂观感由材质本身决定）→ 隐藏 */
  function updateBgOpacityVisibility() {
    bgOpacityBlock.classList.toggle('hidden', settings.material === 'acrylic');
  }

  function onMaterialSelect(material) {
    if (material === settings.material) return;
    applyMaterial(material);
    api.saveSettings({ material: settings.material });
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
      applyMaterial(settings.material);   // 材质（含透明度设置显隐）
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

  // Esc：关闭确认框 → 退出背景管理模式
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!confirmMask.classList.contains('hidden')) {
      closeBgConfirm();
    } else if (bgManageMode) {
      toggleBgManageMode();
    }
  });

  loadSettingsState();
  refreshStorageInfo();
})();
