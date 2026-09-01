/**
 * EzTxt 自定义主题编辑器
 * 左侧 demo 实时预览，右侧名称（必填）+ 3 色（强调/背景/文字）+ 明暗开关。
 * 预览只改 demo（不落盘、不动主窗口）；「保存」写入 settings.customThemes 并广播生效。
 * 模式：query 无 id = 新建；有 id = 编辑已有主题（额外显示「删除」按钮）。
 */
(function () {
  'use strict';

  const DEFAULT_CUSTOM = { accent: '#e0a82e', bg: '#FAF5E1', ink: '#4a3f24', dark: false };

  // 快捷预设（accent / bg / ink / dark 一组）
  const PRESETS = [
    { accent: '#e0a82e', bg: '#FAF5E1', ink: '#4a3f24', dark: false }, // 琥珀
    { accent: '#7BA7D8', bg: '#F1F5FA', ink: '#2E4A66', dark: false }, // 深蓝
    { accent: '#66997A', bg: '#EFF5F0', ink: '#2E4A3A', dark: false }, // 墨绿
    { accent: '#C97B6B', bg: '#F9F1EE', ink: '#5A3A32', dark: false }, // 砖红
    { accent: '#9A7BB5', bg: '#F5F1F8', ink: '#46325C', dark: false }, // 紫藤
    { accent: '#D89A9A', bg: '#F8F0F0', ink: '#66393F', dark: false }, // 酒红
    { accent: '#7BA05B', bg: '#F2F6EC', ink: '#3A4A2E', dark: false }, // 草绿
    { accent: '#E8B4B8', bg: '#FDF4F4', ink: '#6B3A42', dark: false }, // 樱粉
    { accent: '#D9A05B', bg: '#FBF2E6', ink: '#5C4632', dark: false }, // 杏橙
    { accent: '#6BA3B5', bg: '#EEF5F7', ink: '#2E4850', dark: false }, // 青碧
    { accent: '#A3A3C2', bg: '#F2F2F7', ink: '#3C3C55', dark: false }, // 暮紫灰
    { accent: '#4CC2A0', bg: '#0F1613', ink: '#D7E5DF', dark: true }   // 暗夜薄荷
  ];

  // ===== 编辑目标 =====
  const urlParams = new URLSearchParams(window.location.search);
  const editId = urlParams.get('id') || null; // null = 新建

  const state = { name: '', ...DEFAULT_CUSTOM };
  const demoApp = document.getElementById('demoApp');
  const demoStage = document.querySelector('.demo-stage'); // mini 球所在舞台（变量同样注入）

  // ===== DOM 引用 =====
  const $ = (id) => document.getElementById(id);
  const nameInput = $('themeName');
  const nameError = $('nameError');
  const deleteBtn = $('deleteBtn');
  const saveBtn = $('saveBtn');
  const inputs = {
    accent: { color: $('accentColor'), hex: $('accentHex') },
    bg: { color: $('bgColor'), hex: $('bgHex') },
    ink: { color: $('inkColor'), hex: $('inkHex') }
  };
  const darkSwitch = $('darkSwitch');

  // ===== demo 应用（只动 demo 舞台 + 主容器，不动主窗口） =====
  function applyDemo() {
    // 注入到整个舞台：mini 球(.demo-mini)在 demo-app 外部，同样要吃到变量
    window.api.applyCustomThemeVars(state, demoStage);
    for (const key of Object.keys(inputs)) {
      inputs[key].color.value = state[key].toLowerCase();
      inputs[key].hex.value = state[key].toUpperCase();
    }
    darkSwitch.checked = state.dark;
  }

  // ===== 名称校验反馈 =====
  function setNameError(show) {
    nameInput.classList.toggle('error', show);
    nameError.classList.toggle('show', show);
  }
  nameInput.addEventListener('input', () => setNameError(false));

  // ===== 颜色输入绑定 =====
  for (const key of Object.keys(inputs)) {
    inputs[key].color.addEventListener('input', () => {
      state[key] = inputs[key].color.value.toUpperCase();
      applyDemo();
    });
    inputs[key].hex.addEventListener('change', () => {
      const v = inputs[key].hex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        state[key] = v.toUpperCase();
        applyDemo();
      } else {
        inputs[key].hex.value = state[key].toUpperCase(); // 非法回显
      }
    });
  }
  darkSwitch.addEventListener('change', () => {
    state.dark = darkSwitch.checked;
    applyDemo();
  });

  // ===== 预设色板 =====
  const presetsBox = $('presets');
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `强调 ${p.accent} · 背景 ${p.bg}`;
    btn.style.background = `linear-gradient(135deg, ${p.bg} 0 55%, ${p.accent} 55% 100%)`;
    btn.addEventListener('click', () => {
      Object.assign(state, p);
      applyDemo();
    });
    presetsBox.appendChild(btn);
  }

  // ===== 底部按钮 =====
  $('resetBtn').addEventListener('click', () => {
    const keepName = state.name;
    Object.assign(state, DEFAULT_CUSTOM, { name: keepName });
    applyDemo();
  });

  $('cancelBtn').addEventListener('click', () => window.close());
  $('closeBtn').addEventListener('click', () => window.close());

  // 删除（仅编辑模式显示）
  deleteBtn.addEventListener('click', async () => {
    try {
      const s = await window.api.loadSettings();
      const list = (s.customThemes || []).filter((t) => t.id !== editId);
      const patch = { customThemes: list };
      // 删除的是激活主题 → 回退默认预置主题
      if (s.theme === 'custom' && s.customThemeId === editId) {
        patch.theme = 'blue';
        patch.customThemeId = null;
      }
      await window.api.saveSettings(patch);
      window.close();
    } catch (err) {
      console.error('删除自定义主题失败：', err);
    }
  });

  // 保存（名称必填校验）
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      setNameError(true);
      nameInput.focus();
      return;
    }
    try {
      const s = await window.api.loadSettings();
      const list = Array.isArray(s.customThemes) ? [...s.customThemes] : [];
      const item = {
        id: editId || 'ct-' + Math.random().toString(16).slice(2, 10),
        name,
        accent: state.accent,
        bg: state.bg,
        ink: state.ink,
        dark: state.dark
      };
      const idx = list.findIndex((t) => t.id === item.id);
      if (idx >= 0) list[idx] = item;
      else list.push(item);
      // 编辑旧激活项或新建 → 激活该自定义主题
      const isActive = s.theme === 'custom' && s.customThemeId === item.id;
      const shouldActivate = !editId || isActive;
      await window.api.saveSettings({
        customThemes: list,
        ...(shouldActivate ? { theme: 'custom', customThemeId: item.id } : {})
      });
      window.close();
    } catch (err) {
      console.error('保存自定义主题失败：', err);
    }
  });

  // ===== 初始化 =====
  (async function init() {
    try {
      const s = await window.api.loadSettings();
      if (editId) {
        // 编辑模式：载入对应项，显示删除按钮
        const item = (s.customThemes || []).find((t) => t.id === editId);
        if (item) {
          state.name = item.name || '';
          state.accent = item.accent || DEFAULT_CUSTOM.accent;
          state.bg = item.bg || DEFAULT_CUSTOM.bg;
          state.ink = item.ink || DEFAULT_CUSTOM.ink;
          state.dark = !!item.dark;
        }
        deleteBtn.style.display = '';
        saveBtn.textContent = '保存修改';
      } else {
        // 新建模式：预设默认沿用上次任一自定义主题的风格（无则琥珀默认）
        const last = (s.customThemes || [])[s.customThemes.length - 1];
        if (last) {
          state.accent = last.accent || DEFAULT_CUSTOM.accent;
          state.bg = last.bg || DEFAULT_CUSTOM.bg;
          state.ink = last.ink || DEFAULT_CUSTOM.ink;
          state.dark = !!last.dark;
        }
      }
    } catch (err) {
      console.error('读取自定义主题失败：', err);
    }
    nameInput.value = state.name;
    applyDemo();
  })();
})();
