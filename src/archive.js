(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // ===== DOM 引用 =====
  const archiveListEl = $('#archiveList');
  const archiveEmptyTip = $('#archiveEmptyTip');
  const archiveEmptyText = $('#archiveEmptyText');
  const archiveSearchInput = $('#archiveSearchInput');
  const archiveSearchClear = $('#archiveSearchClear');
  const winClose = $('#winClose');
  const btnBatchMode = $('#btnBatchMode');
  const btnBatchDelete = $('#btnBatchDelete');
  const batchModeLabel = $('#batchModeLabel');
  const batchDeleteLabel = $('#batchDeleteLabel');
  const confirmMask = $('#confirmMask');
  const confirmText = $('#confirmText');
  const btnConfirmOk = $('#btnConfirmOk');
  const btnConfirmCancel = $('#btnConfirmCancel');

  // ===== 状态 =====
  let items = [];
  let batchMode = false;
  let batchSelected = new Set();
  let archiveKeyword = ''; // 归档标题搜索关键字（小写）
  let settings = {
    theme: 'amber',
    material: 'opaque',
    customThemes: [],
    customThemeId: null,
    fontSize: 13,
    bgImage: null
  };

  /** 应用窗口材质到 body（决定 .settings-window 实心/半透明背景 + 边框）。
   *  与 settings.js 回退规则一致：acrylic（隐藏预留）回退 translucent。 */
  function applyMaterial(material) {
    let val = ['opaque', 'translucent'].includes(material) ? material : 'opaque';
    if (material === 'acrylic') val = 'translucent';
    settings.material = val;
    document.body.dataset.material = val;
  }

  // ===== 主题跟随 =====
  async function loadSettingsState() {
    if (!window.api || !api.loadSettings) return;
    try {
      const s = await api.loadSettings();
      Object.assign(settings, s);
      settings.customThemes = Array.isArray(s.customThemes) ? s.customThemes : [];
      document.body.dataset.theme = settings.theme;
      applyMaterial(settings.material); // 材质跟随：经典实心 / 半透明
      if (settings.theme === 'custom') {
        const item = settings.customThemes.find((t) => t.id === settings.customThemeId);
        if (item && api.applyCustomThemeVars) {
          api.applyCustomThemeVars(item);
        } else {
          settings.theme = 'blue';
          document.body.dataset.theme = 'blue';
          if (api.clearCustomThemeVars) api.clearCustomThemeVars();
        }
      } else {
        if (api.clearCustomThemeVars) api.clearCustomThemeVars();
      }
    } catch (err) {
      console.error('加载设置失败：', err);
    }
  }

  // ===== 加载归档 =====
  async function loadArchive() {
    try {
      const doc = await api.loadNote();
      items = (Array.isArray(doc?.items) ? doc.items : []).filter((it) => it.archived);
      groupAndRender();
    } catch (err) {
      console.error('加载归档失败：', err);
      items = [];
      groupAndRender();
    }
  }

  /** 按搜索关键字过滤（标题，忽略大小写） */
  function filterByKeyword(list) {
    const kw = archiveKeyword.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((it) => String(it.title || '').toLowerCase().includes(kw));
  }

  /** 按完成日期分组渲染 */
  function groupAndRender() {
    archiveListEl.innerHTML = '';
    const filtered = filterByKeyword(items);
    if (filtered.length === 0) {
      archiveEmptyTip.classList.remove('hidden');
      archiveEmptyText.textContent = archiveKeyword.trim()
        ? '没有找到标题匹配的任务'
        : '暂无已完成的任务';
      return;
    }
    archiveEmptyTip.classList.add('hidden');

    // 按 completedAt 倒序排列（最近完成的在前）
    const sorted = [...filtered].sort((a, b) => {
      const ta = a.completedAt || a.updatedAt || '';
      const tb = b.completedAt || b.updatedAt || '';
      return tb.localeCompare(ta);
    });

    // 按日期分组
    const groups = {};
    for (const item of sorted) {
      const dateStr = (item.completedAt || item.updatedAt || '').slice(0, 10);
      if (!groups[dateStr]) groups[dateStr] = [];
      groups[dateStr].push(item);
    }

    for (const [dateStr, groupItems] of Object.entries(groups)) {
      const groupLi = document.createElement('li');
      groupLi.className = 'archive-date-group';

      const header = document.createElement('h4');
      header.className = 'archive-group-title';
      header.textContent = formatDate(dateStr);
      groupLi.appendChild(header);

      const innerUl = document.createElement('ul');
      for (const item of groupItems) {
        innerUl.appendChild(createArchiveCard(item));
      }
      groupLi.appendChild(innerUl);
      archiveListEl.appendChild(groupLi);
    }
  }

  function formatDate(dateStr) {
    try {
      const d = new Date(dateStr + 'T00:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diff = Math.floor((today - d) / 86400000);
      if (diff === 0) return '今天';
      if (diff === 1) return '昨天';
      if (diff > 1 && diff < 7) return diff + ' 天前';
      return dateStr;
    } catch (_) {
      return dateStr;
    }
  }

  /** 创建归档卡片 */
  function createArchiveCard(item) {
    const li = document.createElement('li');
    li.className = 'task-card is-done archive-card';
    li.dataset.id = item.id;

    const main = document.createElement('div');
    main.className = 'card-main';

    // 标题行：标题左（收缩省略）+ 展开箭头（有备注时）+ 完成时间右
    const titleRow = document.createElement('div');
    titleRow.className = 'card-title-row';

    const title = document.createElement('span');
    title.className = 'card-title-text';
    title.textContent = item.title || '(无标题)';
    titleRow.appendChild(title);

    // 有备注时显示展开箭头（复用首页 card-toggle 交互）
    if (item.note) {
      li.classList.add('is-expandable'); // 收起区可点击展开备注
      const toggle = document.createElement('button');
      toggle.className = 'card-toggle';
      toggle.type = 'button';
      toggle.dataset.action = 'toggle-expand';
      toggle.title = '展开备注';
      toggle.setAttribute('aria-label', '展开备注');
      toggle.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M5 3l6 5-6 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      titleRow.appendChild(toggle);
    }

    // 完成时间：作为行内最后一个流元素 → 靠右对齐
    const meta = document.createElement('span');
    meta.className = 'archive-card-time';
    const time = item.completedAt || item.updatedAt;
    if (time) {
      try {
        meta.textContent = new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      } catch (_) {
        meta.textContent = '';
      }
    }
    titleRow.appendChild(meta);

    // 「恢复待办」按钮：放在标题行内（相对标题行定位），
    // 备注展开后按钮仍与标题/时间保持同一行，不会跑到卡片中部。
    // hover 卡片时从右侧滑入，点击才把任务放回待办。
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'archive-restore-btn';
    restoreBtn.type = 'button';
    restoreBtn.dataset.action = 'restore';
    restoreBtn.title = '恢复为待办';
    restoreBtn.textContent = '恢复待办';
    titleRow.appendChild(restoreBtn);

    main.appendChild(titleRow);

    // 备注区：复用首页 .card-note 收起/展开机制，内容为只读 Markdown 渲染
    if (item.note) {
      const noteWrap = document.createElement('div');
      noteWrap.className = 'card-note';
      const noteView = document.createElement('div');
      noteView.className = 'card-editor archive-note-view';
      noteWrap.appendChild(noteView);
      main.appendChild(noteWrap);

      // 异步渲染 Markdown（与首页一致），只读不可编辑
      Promise.resolve(api.renderMarkdown(item.note || ''))
        .then((html) => {
          if (li.isConnected) noteView.innerHTML = html;
        })
        .catch(() => { noteView.textContent = item.note; });
    }

    li.appendChild(main);

    return li;
  }

  // ===== 取消归档 =====
  async function unarchive(id) {
    try {
      // 重新读取完整 doc，避免覆盖主列表中的其他改动
      const doc = await api.loadNote();
      if (!Array.isArray(doc?.items)) return;
      const it = doc.items.find((x) => x.id === id);
      if (!it) return;
      const now = new Date().toISOString();
      Object.assign(it, { done: false, archived: false, completedAt: null, updatedAt: now });
      await api.saveNote(doc);
      // 刷新本地列表
      items = items.filter((x) => x.id !== id);
      groupAndRender();
    } catch (err) {
      console.error('取消归档失败：', err);
    }
  }

  // ===== 批量模式 =====
  function enterBatchMode() {
    batchMode = true;
    batchSelected.clear();
    document.body.classList.add('is-batch-mode');
    batchModeLabel.textContent = '退出选择';
    btnBatchDelete.classList.remove('hidden');
    updateBatchUI();
  }

  function exitBatchMode() {
    batchMode = false;
    batchSelected.clear();
    document.body.classList.remove('is-batch-mode');
    batchModeLabel.textContent = '批量选择';
    btnBatchDelete.classList.add('hidden');
    archiveListEl.querySelectorAll('.is-batch-selected').forEach((el) => el.classList.remove('is-batch-selected'));
  }

  function toggleBatchSelect(id) {
    if (batchSelected.has(id)) {
      batchSelected.delete(id);
    } else {
      batchSelected.add(id);
    }
    updateBatchUI();
  }

  function updateBatchUI() {
    const n = batchSelected.size;
    batchDeleteLabel.textContent = n > 0 ? `删除选中 (${n})` : '删除选中';
    btnBatchDelete.classList.toggle('is-disabled', n === 0);
  }

  function openBatchDeleteConfirm() {
    const n = batchSelected.size;
    if (n === 0) return;
    confirmText.textContent = `确定要删除选中的 ${n} 个已完成任务吗？此操作不可恢复。`;
    confirmMask.classList.remove('hidden');
    btnConfirmOk.focus();
  }

  function closeBatchDeleteConfirm() {
    confirmMask.classList.add('hidden');
  }

  async function doBatchDelete() {
    const ids = [...batchSelected];
    closeBatchDeleteConfirm();
    try {
      // 重新读取完整 doc，避免覆盖
      const doc = await api.loadNote();
      if (!Array.isArray(doc?.items)) return;
      doc.items = doc.items.filter((it) => !batchSelected.has(it.id));
      await api.saveNote(doc);
      items = items.filter((it) => !batchSelected.has(it.id));
      exitBatchMode();
      groupAndRender();
    } catch (err) {
      console.error('批量删除失败：', err);
    }
  }

  // ===== 事件绑定 =====

  // 关闭窗口
  winClose.addEventListener('click', () => window.close());

  /** 点击恢复按钮：卡片淡出后取消归档 */
  function fadeAndUnarchive(card, id) {
    card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.9)';
    setTimeout(() => unarchive(id), 250);
  }

  // 列表点击：备注展开/收起、恢复待办、批量选择
  archiveListEl.addEventListener('click', (e) => {
    // 「恢复待办」按钮：取消归档，放回待办列表
    const restoreBtn = e.target.closest('[data-action="restore"]');
    if (restoreBtn) {
      if (batchMode) return; // 批量模式下按钮隐藏，防御性跳过
      e.stopPropagation();
      const card = restoreBtn.closest('.task-card');
      const id = card && card.dataset.id;
      if (id) fadeAndUnarchive(card, id);
      return;
    }

    const card = e.target.closest('.task-card');
    if (!card) return;
    const id = card.dataset.id;
    if (!id) return;

    // 展开箭头：切换备注展开/收起
    const toggle = e.target.closest('[data-action="toggle-expand"]');
    if (toggle) {
      e.stopPropagation();
      const expanded = card.classList.toggle('is-expanded');
      toggle.classList.toggle('is-expanded', expanded);
      return;
    }

    // 备注正文区：只读，允许选择文本
    if (e.target.closest('.card-note')) return;

    // 批量模式下：整卡点击用于选择删除
    if (batchMode) {
      toggleBatchSelect(id);
      card.classList.toggle('is-batch-selected', batchSelected.has(id));
      return;
    }

    // 普通模式：点击卡片主体（标题行/收起的那部分）→ 展开/收起备注；
    // 若卡片无备注则无动作
    if (card.querySelector('.card-note')) {
      const expanded = card.classList.toggle('is-expanded');
      const arrow = card.querySelector('.card-toggle');
      if (arrow) arrow.classList.toggle('is-expanded', expanded);
    }
  });

  // 批量模式开关
  btnBatchMode.addEventListener('click', () => {
    if (batchMode) exitBatchMode();
    else enterBatchMode();
  });

  // ===== 归档搜索（按标题过滤，防抖实时过滤） =====
  let archiveSearchTimer = null;
  function applyArchiveSearch() {
    archiveKeyword = archiveSearchInput.value;
    // 清除按钮随输入显隐
    archiveSearchClear.classList.toggle('hidden', archiveKeyword.trim() === '');
    groupAndRender();
  }
  archiveSearchInput.addEventListener('input', () => {
    clearTimeout(archiveSearchTimer);
    archiveSearchTimer = setTimeout(applyArchiveSearch, 120);
  });
  archiveSearchClear.addEventListener('click', () => {
    archiveSearchInput.value = '';
    clearTimeout(archiveSearchTimer);
    applyArchiveSearch();
    archiveSearchInput.focus();
  });

  // 批量删除
  btnBatchDelete.addEventListener('click', () => {
    if (batchSelected.size === 0) return;
    openBatchDeleteConfirm();
  });

  // 确认弹窗
  btnConfirmOk.addEventListener('click', doBatchDelete);
  btnConfirmCancel.addEventListener('click', closeBatchDeleteConfirm);
  confirmMask.addEventListener('click', (e) => {
    if (e.target === confirmMask) closeBatchDeleteConfirm();
  });

  // Esc：清空搜索 → 关闭弹窗 → 退出批量模式
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (archiveSearchInput.value !== '') {
      archiveSearchInput.value = '';
      clearTimeout(archiveSearchTimer);
      applyArchiveSearch();
      archiveSearchInput.blur();
      return;
    }
    if (!confirmMask.classList.contains('hidden')) {
      closeBatchDeleteConfirm();
    } else if (batchMode) {
      exitBatchMode();
    }
  });

  // 主题变化 → 重新加载设置
  if (api.onSettingsChanged) {
    api.onSettingsChanged(() => loadSettingsState());
  }

  // 笔记数据被其他窗口修改 → 刷新归档列表
  if (api.onNoteChanged) {
    api.onNoteChanged(() => loadArchive());
  }

  // ===== 初始化 =====
  (async function init() {
    await loadSettingsState();
    await loadArchive();
  })();
})();
