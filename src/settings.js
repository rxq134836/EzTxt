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
  const fontSizeSliderEl = $('#fontSizeSlider');
  const fontSizeValueEl = $('#fontSizeValue');
  const btnUploadBg = $('#btnUploadBg');
  const btnRemoveBg = $('#btnRemoveBg');
  const bgOpacitySlider = $('#bgOpacity');
  const bgFileInput = $('#bgFileInput');
  const shortcutListEl = $('#shortcutList');
  const winClose = $('#winClose');

  let settings = { theme: 'amber', bgImage: null, bgOpacity: 0.35, fontSize: 13, shortcuts: {} };
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
    { key: 'sage',       name: '草绿', accent: '#A68329', bg: '#F5F0D4', ink: '#3a2f14' }
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

  // ===== 背景图 =====
  function applyBgImage(dataURL) {
    if (dataURL) {
      settings.bgImage = dataURL;
    } else {
      settings.bgImage = null;
    }
  }

  function handleBgUpload() {
    bgFileInput.click();
  }

  function onBgFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataURL = reader.result;
      applyBgImage(dataURL);
      api.saveSettings({ bgImage: dataURL });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function handleBgRemove() {
    applyBgImage(null);
    api.saveSettings({ bgImage: null });
  }

  function onBgOpacityChange() {
    if (isLoadingSettings) return;
    const v = parseFloat(bgOpacitySlider.value);
    settings.bgOpacity = v;
    api.saveSettings({ bgOpacity: v });
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
      bgOpacitySlider.value = String(settings.bgOpacity);
      renderThemeSwatches();
      renderShortcutList();
    } catch (_) {
      renderThemeSwatches();
      renderShortcutList();
    } finally {
      isLoadingSettings = false;
    }
  }

  // ===== 事件 =====
  winClose.addEventListener('click', () => window.close());
  fontSizeSliderEl.addEventListener('input', onFontSizeChange);
  btnUploadBg.addEventListener('click', handleBgUpload);
  btnRemoveBg.addEventListener('click', handleBgRemove);
  bgFileInput.addEventListener('change', onBgFileSelected);
  bgOpacitySlider.addEventListener('input', onBgOpacityChange);

  loadSettingsState();
})();
