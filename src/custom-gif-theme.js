/**
 * EzTxt 自定义 GIF 动画主题编辑器
 * 上传 GIF 文件创建自定义 mini 球动画主题：
 *   - 闲时动画：可上传多张用于轮换
 *   - 慢速打字 / 快速打字：各一张（可选）
 * 模式：query 无 id = 新建；有 id = 编辑已有主题（额外显示「删除」按钮）。
 *
 * 说明：编辑已有主题时，scanGifThemes 返回的 idle/slow/fast 为 file:// 完整 URL，
 * 无法转回 data URL；此处仅用作预览背景图，保存时跳过 URL 项（只发送 data URL）。
 */
(function () {
  'use strict';

  // ===== 编辑目标 =====
  const urlParams = new URLSearchParams(window.location.search);
  const editId = urlParams.get('id') || null; // null = 新建

  // ===== DOM 引用 =====
  const $ = (id) => document.getElementById(id);
  const themeName = $('themeName');
  const nameError = $('nameError');
  const idleSlots = $('idleSlots');
  const slowSlot = $('slowSlot');
  const fastSlot = $('fastSlot');
  const btnAddIdle = $('btnAddIdle');
  const btnUploadSlow = $('btnUploadSlow');
  const btnUploadFast = $('btnUploadFast');
  const btnSave = $('btnSave');
  const btnDelete = $('btnDelete');
  const winClose = $('winClose');

  // ===== 工具函数 =====
  /** 判断是否为 data URL（新上传的 GIF）；已有的 file:// URL 视为非 data URL */
  function isDataUrl(v) {
    return typeof v === 'string' && v.indexOf('data:') === 0;
  }

  /** 给槽位设置预览图（value 为 data URL 或 file:// URL） */
  function setSlotPreview(slotEl, value) {
    const preview = slotEl.querySelector('.slot-preview');
    if (value) {
      preview.style.backgroundImage = 'url("' + value + '")';
      slotEl.classList.add('has-image');
    } else {
      preview.style.backgroundImage = '';
      slotEl.classList.remove('has-image');
    }
  }

  /** 调用文件选择对话框，成功则把 dataUrl 写入指定槽位 */
  async function uploadToSlot(slotEl) {
    try {
      const result = await window.api.selectGifFile();
      if (!result || !result.dataUrl) return;
      slotEl._value = result.dataUrl;
      setSlotPreview(slotEl, result.dataUrl);
    } catch (err) {
      console.error('选择 GIF 文件失败：', err);
    }
  }

  /** 创建一个闲时动画槽位（可带初始值：dataUrl 或 URL） */
  function createIdleSlot(value) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.innerHTML =
      '<div class="slot-preview"></div>' +
      '<button class="slot-del" title="删除">×</button>';
    slot._value = value || null;
    if (value) setSlotPreview(slot, value);

    // 点击预览区 → 上传
    slot.querySelector('.slot-preview').addEventListener('click', () => {
      uploadToSlot(slot);
    });
    // 删除按钮 → 移除槽位并刷新空提示
    slot.querySelector('.slot-del').addEventListener('click', () => {
      slot.remove();
      refreshIdleHint();
    });
    return slot;
  }

  /** 闲时槽位为空时显示提示 */
  function refreshIdleHint() {
    idleSlots.classList.toggle('empty-hint', idleSlots.children.length === 0);
  }

  // ===== 闲时动画：添加 / 上传 =====
  btnAddIdle.addEventListener('click', () => {
    idleSlots.appendChild(createIdleSlot(null));
    refreshIdleHint();
  });

  // ===== 慢速 / 快速：上传按钮 + 槽位点击均可触发 =====
  btnUploadSlow.addEventListener('click', () => uploadToSlot(slowSlot));
  btnUploadFast.addEventListener('click', () => uploadToSlot(fastSlot));
  slowSlot.querySelector('.slot-preview').addEventListener('click', () => uploadToSlot(slowSlot));
  fastSlot.querySelector('.slot-preview').addEventListener('click', () => uploadToSlot(fastSlot));

  // ===== 名称校验反馈 =====
  function setNameError(show) {
    themeName.classList.toggle('error', show);
    nameError.classList.toggle('show', show);
  }
  themeName.addEventListener('input', () => setNameError(false));

  // ===== 关闭按钮 =====
  winClose.addEventListener('click', () => window.close());

  // ===== 保存 =====
  btnSave.addEventListener('click', async () => {
    const name = themeName.value.trim();
    if (!name) {
      setNameError(true);
      themeName.focus();
      return;
    }
    try {
      // 闲时动画：只收集非空且为 data URL 的项（跳过已有的 file:// URL）
      const idle = [];
      for (const slot of idleSlots.children) {
        const v = slot._value;
        if (v && isDataUrl(v)) idle.push(v);
      }
      // 慢速 / 快速：非 data URL 一律视为未设置
      const slow = (slowSlot._value && isDataUrl(slowSlot._value)) ? slowSlot._value : null;
      const fast = (fastSlot._value && isDataUrl(fastSlot._value)) ? fastSlot._value : null;

      const result = await window.api.saveCustomGifTheme({
        id: editId || undefined,
        name: name,
        idle: idle,
        slow: slow,
        fast: fast
      });
      if (result && result.ok) {
        window.close();
      } else {
        console.error('保存自定义 GIF 主题失败：', result);
      }
    } catch (err) {
      console.error('保存自定义 GIF 主题失败：', err);
    }
  });

  // ===== 删除（仅编辑模式显示） =====
  btnDelete.addEventListener('click', async () => {
    if (!editId) return;
    try {
      const result = await window.api.deleteCustomGifTheme(editId);
      if (result && result.ok) {
        window.close();
      } else {
        console.error('删除自定义 GIF 主题失败：', result);
      }
    } catch (err) {
      console.error('删除自定义 GIF 主题失败：', err);
    }
  });

  // ===== 初始化 =====
  (async function init() {
    try {
      // 主题跟随：加载用户设置，设置 body data-theme + 自定义主题变量
      if (window.api.loadSettings) {
        const s = await window.api.loadSettings();
        if (s.theme) document.body.dataset.theme = s.theme;
        if (s.theme === 'custom' && s.customThemes && s.customThemeId) {
          const ct = s.customThemes.find((t) => t.id === s.customThemeId);
          if (ct && window.api.applyCustomThemeVars) {
            window.api.applyCustomThemeVars(ct);
          }
        }
      }

      if (editId) {
        // 编辑模式：从 scanGifThemes 载入已有主题（custom 主题 name === id）
        const themes = await window.api.scanGifThemes();
        const theme = themes.find((t) => t.custom && t.name === editId);
        if (theme) {
          themeName.value = theme.displayName || '';
          // 闲时动画：URL 直接作为预览背景，保存时会被跳过
          const idle = Array.isArray(theme.idle) ? theme.idle : [];
          for (const url of idle) {
            idleSlots.appendChild(createIdleSlot(url));
          }
          // 慢速 / 快速
          if (theme.slow) {
            slowSlot._value = theme.slow;
            setSlotPreview(slowSlot, theme.slow);
          }
          if (theme.fast) {
            fastSlot._value = theme.fast;
            setSlotPreview(fastSlot, theme.fast);
          }
        }
        btnDelete.style.display = '';
        btnSave.textContent = '保存修改';
      }
      refreshIdleHint();
    } catch (err) {
      console.error('读取自定义 GIF 主题失败：', err);
    }
  })();
})();
