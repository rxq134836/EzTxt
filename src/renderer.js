'use strict';

/**
 * EzTxt 任务列表便签 —— 渲染进程逻辑
 *
 * 关键设计：
 *  1. 一次性 renderList() 建立 DOM，后续只通过增量函数（updateCardTitle/Note/Done/...）
 *     修改受影响卡片，避免每次输入全量 innerHTML 重建毁 textarea 焦点。
 *  2. 事件委托：#taskList 上一个 listener，通过 data-action + data-id 分发。
 *  3. 懒渲染：只有卡片处于 expanded 状态时才实时 marked.parse 预览；
 *     折叠态仅用截断的 Markdown 源文本做 meta 摘要（不 parse）。
 *  4. 全局防抖保存（AUTOSAVE_DELAY=2s），Ctrl+S 立即保存，关闭前尽力保存一次。
 */
(function () {
  const api = window.api;

  // ===== 常量 =====
  const AUTOSAVE_DELAY = 2000;

  // ===== DOM 引用 =====
  const $ = (sel) => document.querySelector(sel);
  const taskListEl = $('#taskList');
  const emptyTipEl = $('#emptyTip');
  const titleSummaryEl = $('#titleSummary');
  const saveTimeEl = $('#saveTime');
  const statusTextEl = $('#statusText');
  const statusDotEl = $('#statusDot');
  const pinBtn = $('#pinBtn');
  const minBtn = $('#minBtn');
  const shrinkBtn = $('#shrinkBtn');
  const closeBtn = $('#closeBtn');
  const searchbarEl = $('#searchbar');
  const searchInputEl = $('#searchInput');
  const searchClearBtn = $('#searchClear');
  const btnSearch = $('#btnSearch');
  const btnDelete = $('#btnDelete');
  const btnDivider = $('#btnDivider');
  const btnAdd = $('#btnAdd');
  const btnAddEmpty = $('#btnAddEmpty');
  const btnHelp = $('#btnHelp');
  const helpPanel = $('#helpPanel');
  const btnTheme = $('#btnTheme');
  const themePanel = $('#themePanel');
  const themeSwatches = $('#themeSwatches');
  const miniBar = $('#miniBar');
  const miniCount = $('#miniCount');
  const bgImageLayer = $('#bgImageLayer');
  const btnUploadBg = $('#btnUploadBg');
  const btnRemoveBg = $('#btnRemoveBg');
  const bgOpacitySlider = $('#bgOpacity');
  const bgFileInput = $('#bgFileInput');

  // ===== 应用状态 =====
  /**
   * items:  [{ id, title, done, note, expanded, createdAt, updatedAt, _idx }]
   * 注意：_idx 是保存到主进程前的位置索引，渲染层会把它删掉再保存。
   */
  let items = [];
  let docUpdatedAt = null;
  let isDirty = false;
  let saveTimer = null;
  let activeSearch = ''; // 当前过滤关键字
  let selectedId = null; // 选中的卡片（用于 Backspace 删除）

  // ===== 主题常量 & 设置状态 =====
  const THEMES = [
    { key: 'amber',      name: '琥珀', accent: '#e0a82e', bg: '#FAF5E1', ink: '#4a3f24' },
    { key: 'blue',       name: '深蓝', accent: '#2B5275', bg: '#FFFBBD', ink: '#1a2a3a' },
    { key: 'olive',      name: '墨绿', accent: '#4D5E30', bg: '#F5F0D4', ink: '#2a3319' },
    { key: 'terracotta', name: '砖红', accent: '#D16647', bg: '#F5EAD4', ink: '#3d2a1a' },
    { key: 'gold',       name: '棕金', accent: '#BCA052', bg: '#F5EAD4', ink: '#4A3C2B' },
    { key: 'rose',       name: '酒红', accent: '#954B44', bg: '#F5E5E0', ink: '#3a1f1b' },
    { key: 'sage',       name: '草绿', accent: '#A68329', bg: '#F5F0D4', ink: '#3a2f14' }
  ];
  let settings = { theme: 'amber', bgImage: null, bgOpacity: 0.35 };
  let isMiniMode = false;
  let isLoadingSettings = false;

  function uid() {
    // 渲染层生成 id 用时间戳+随机，主进程再兜底换 crypto.randomBytes
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  // ===== 时间格式化 =====
  function formatTime(iso) {
    if (!iso) return '尚未保存';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '尚未保存';
    const pad = (n) => String(n).padStart(2, '0');
    return `已保存 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ===== 状态指示 =====
  function setStatus(state, text) {
    statusDotEl.classList.remove('dirty', 'saving', 'saved');
    if (state) statusDotEl.classList.add(state);
    if (text != null) statusTextEl.textContent = text;
  }
  function markDirty() {
    if (isDirty) return;
    isDirty = true;
    setStatus('dirty', '未保存的修改');
  }

  // ============================================================
  //  DOM 构建（一次性）
  // ============================================================

  /**
   * 为单张卡片创建 DOM 结构。此时 note 是折叠的，不做预览。
   * 只有 toggle 按钮、title input、checkbox、note-meta、note-area（textarea + 空的 preview）。
   */
  function createCardEl(item) {
    const li = document.createElement('li');
    li.className = 'task-card';
    if (item.done) li.classList.add('is-done');
    if (item.expanded) li.classList.add('is-expanded');
    li.dataset.id = item.id;
    // divider 卡片？我们用 data-type="divider" 标记而不是在 items 数组里加 type 字段
    // 这样主进程数据结构保持干净。如果 title === '__DIVIDER__' 则渲染为分割线
    if (item.title === '__DIVIDER__') {
      li.classList.add('is-divider');
      li.dataset.type = 'divider';
      li.innerHTML = '<hr/>';
      return li;
    }

    li.innerHTML = `
      <div class="task-row">
        <div class="card-checkbox${item.done ? ' is-checked' : ''}"
             data-action="toggle-done" role="checkbox" aria-checked="${item.done}"></div>
        <input class="card-title" data-action="edit-title"
               type="text" value="${escapeAttr(item.title)}"
               placeholder="新任务…" spellcheck="false" />
        <span class="card-note-meta${!item.note ? ' is-empty' : ''}"
              data-action="toggle-expand" title="点击展开备注">${renderNoteMeta(item.note)}</span>
        <button class="card-toggle${item.expanded ? ' is-expanded' : ''}"
                data-action="toggle-expand" title="展开备注" type="button" aria-label="展开备注">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M5 3l6 5-6 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="card-note">
        <div class="card-editor" data-action="edit-note" contenteditable="true" spellcheck="false"
             data-placeholder="在此输入 Markdown 备注… (Ctrl+B 加粗 / Ctrl+I 斜体 / Ctrl+K 代码 / Ctrl+Shift+[ ] 列表 / Enter 延续列表)"></div>
      </div>
    `;
    // 异步把 Markdown 渲染成所见即所得内容（marked 在 preload 中同步执行，
    // contextBridge 直接返回字符串；Promise.resolve 兼容两种形态）
    Promise.resolve(api.renderMarkdown(item.note || ''))
      .then((html) => {
        if (li.isConnected) {
          const editor = li.querySelector('.card-editor');
          // 仅在用户尚未输入时写入，避免覆盖用户正在编辑的内容
          if (editor && editor.innerHTML === '') editor.innerHTML = html;
        }
      })
      .catch(() => {});
    return li;
  }

  function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 折叠态摘要：截断 Markdown 源文本（不 parse）。
   */
  function renderNoteMeta(note) {
    const s = (note || '').replace(/\s+/g, ' ').trim();
    if (!s) return '+ 添加备注';
    return s.length > 32 ? s.slice(0, 32) + '…' : s;
  }

  /**
   * 首次加载：清空 list，逐张 createCardEl 追加。
   */
  function renderList() {
    taskListEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const item of items) {
      frag.appendChild(createCardEl(item));
    }
    taskListEl.appendChild(frag);

    updateSummary();
    applyFilter();
    updateEmptyTip();
  }

  // ============================================================
  //  增量 DOM 更新
  // ============================================================

  function cardElById(id) {
    return taskListEl.querySelector(`.task-card[data-id="${id}"]`);
  }

  function removeCardEl(id) {
    const el = cardElById(id);
    if (el) el.remove();
  }

  function updateSummary() {
    const taskCount = items.filter((it) => it.title !== '__DIVIDER__').length;
    const doneCount = items.filter((it) => it.title !== '__DIVIDER__' && it.done).length;
    titleSummaryEl.textContent = `· ${taskCount}项 · 已完成${doneCount}`;
    updateMiniCount();
  }

  function updateEmptyTip() {
    const visibleTask = taskListEl.querySelector('.task-card:not(.is-filtered-out):not(.is-divider)');
    emptyTipEl.classList.toggle('hidden', !!visibleTask);
  }

  /**
   * 刷新某张卡片的 meta 摘要（折叠态显示的一行文本）。
   */
  function updateCardMeta(id) {
    const el = cardElById(id);
    if (!el) return;
    const item = findItem(id);
    if (!item) return;
    const meta = el.querySelector('.card-note-meta');
    if (!meta) return;
    meta.textContent = renderNoteMeta(item.note);
    meta.classList.toggle('is-empty', !item.note);
  }

  function updateCardTitleDom(id) {
    const el = cardElById(id);
    if (!el) return;
    const item = findItem(id);
    if (!item) return;
    const titleInput = el.querySelector('.card-title');
    if (titleInput && titleInput.value !== item.title) {
      titleInput.value = item.title;
    }
  }

  function updateCardDoneDom(id) {
    const el = cardElById(id);
    if (!el) return;
    const item = findItem(id);
    if (!item) return;
    el.classList.toggle('is-done', !!item.done);
    const cb = el.querySelector('.card-checkbox');
    if (cb) {
      cb.classList.toggle('is-checked', !!item.done);
      cb.setAttribute('aria-checked', String(!!item.done));
    }
  }

  function updateCardExpandedDom(id) {
    const el = cardElById(id);
    if (!el) return;
    const item = findItem(id);
    if (!item) return;
    el.classList.toggle('is-expanded', !!item.expanded);
    const tb = el.querySelector('.card-toggle');
    if (tb) tb.classList.toggle('is-expanded', !!item.expanded);
  }

  function updateSelection() {
    taskListEl.querySelectorAll('.task-card').forEach((el) => {
      const id = el.dataset.id;
      el.classList.toggle('is-selected', id === selectedId);
    });
  }

  function applyFilter() {
    const q = activeSearch.trim().toLowerCase();
    let anyVisible = false;
    for (const item of items) {
      if (item.title === '__DIVIDER__') continue;
      const el = cardElById(item.id);
      if (!el) continue;
      if (!q) {
        el.classList.remove('is-filtered-out');
        if (!anyVisible) anyVisible = true;
        continue;
      }
      const hay = ((item.title || '') + ' ' + (item.note || '')).toLowerCase();
      const match = hay.includes(q);
      el.classList.toggle('is-filtered-out', !match);
      if (match) anyVisible = true;
    }
    updateEmptyTip();
  }

  // ============================================================
  //  数据操作（都要 markDirty + scheduleAutosave + 刷新对应 DOM）
  // ============================================================

  function findItem(id) {
    return items.find((it) => it.id === id);
  }

  function updateItem(id, patch) {
    const it = findItem(id);
    if (!it) return;
    Object.assign(it, patch);
    markDirty();
    scheduleAutosave();
  }

  function toggleDone(id) {
    const it = findItem(id);
    if (!it) return;
    updateItem(id, { done: !it.done, updatedAt: new Date().toISOString() });
    updateCardDoneDom(id);
    updateSummary();
  }

  function updateTitle(id, title) {
    updateItem(id, { title: title, updatedAt: new Date().toISOString() });
    updateSummary();
  }

  function updateNote(id, note) {
    updateItem(id, { note: note, updatedAt: new Date().toISOString() });
    updateCardMeta(id);
  }

  function toggleExpand(id) {
    const it = findItem(id);
    if (!it) return;
    updateItem(id, { expanded: !it.expanded, updatedAt: new Date().toISOString() });
    updateCardExpandedDom(id);
  }

  function addTask(title = '', note = '') {
    const now = new Date().toISOString();
    const item = {
      id: uid(),
      title: title,
      done: false,
      note: note,
      expanded: false,
      createdAt: now,
      updatedAt: now
    };
    items.push(item);
    markDirty();
    scheduleAutosave();
    // 只追加一个新 DOM 节点（不重渲染整个 list）
    taskListEl.appendChild(createCardEl(item));
    updateSummary();
    applyFilter();
    updateEmptyTip();

    // 自动 focus 标题
    requestAnimationFrame(() => {
      const el = cardElById(item.id);
      if (el) {
        const t = el.querySelector('.card-title');
        if (t) {
          t.focus();
          t.setSelectionRange(t.value.length, t.value.length);
        }
      }
    });
    return item;
  }

  function addDivider() {
    const now = new Date().toISOString();
    const item = {
      id: uid(),
      title: '__DIVIDER__',
      done: false,
      note: '',
      expanded: false,
      createdAt: now,
      updatedAt: now
    };
    items.push(item);
    markDirty();
    scheduleAutosave();
    taskListEl.appendChild(createCardEl(item));
    updateSummary();
    applyFilter();
  }

  function deleteItem(id) {
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return;
    items.splice(idx, 1);
    markDirty();
    scheduleAutosave();
    removeCardEl(id);
    if (selectedId === id) selectedId = null;
    updateSelection();
    updateSummary();
    applyFilter();
    updateEmptyTip();
  }

  function deleteSelected() {
    if (!selectedId) return;
    deleteItem(selectedId);
  }

  // ============================================================
  //  自动保存
  // ============================================================

  function scheduleAutosave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(performSave, AUTOSAVE_DELAY);
  }

  async function performSave() {
    if (!isDirty) return;
    saveTimer = null;
    setStatus('saving', '保存中…');
    try {
      const payload = {
        items: items.map((it) => {
          const copy = { ...it };
          delete copy._idx; // 去掉渲染层临时字段
          return copy;
        })
      };
      const res = await api.saveNote(payload);
      if (res && res.ok) {
        docUpdatedAt = res.updatedAt;
        saveTimeEl.textContent = formatTime(res.updatedAt);
        isDirty = false;
        setStatus('saved', '已保存');
        setTimeout(() => {
          if (!isDirty) setStatus(null, '就绪');
        }, 1200);
      } else {
        setStatus(null, '保存失败');
        saveTimeEl.textContent = '保存失败';
      }
    } catch (err) {
      console.error(err);
      setStatus(null, '保存失败');
    }
  }

  function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!isDirty) {
      setStatus('saved', '已是最新');
      setTimeout(() => { if (!isDirty) setStatus(null, '就绪'); }, 800);
      return;
    }
    performSave();
  }

  // ============================================================
  //  事件委托：#taskList
  // ============================================================

  /**
   * 所见即所得编辑器（contenteditable）→ 同步到 Markdown 状态：
   * 用 preload 中的 turndown 把 innerHTML 反序列化为 Markdown，
   * 有变化才写入（避免无谓 dirty / 自动保存）。
   */
  function syncEditorNote(editor, id) {
    // 用户清空后 Chromium 会残留 <br>，清掉让占位符能显示
    if (editor.innerHTML === '<br>') editor.innerHTML = '';
    const it = findItem(id);
    if (!it) return;
    // turndown 同步返回字符串（contextBridge 不包装 Promise）；Promise.resolve 兼容两种形态
    Promise.resolve(api.htmlToMarkdown(editor.innerHTML))
      .then((md) => {
        if (md !== it.note) updateNote(id, md);
      })
      .catch(() => {});
  }

  /**
   * 用指定标签包裹当前选区（contenteditable 内，行内元素如 code）。
   * 无选区时插入空标签、光标落中间。DOM 变更不会触发 input 事件，
   * 因此操作后手动调用 syncEditorNote。
   */
  function wrapSelectionWith(tagName, editor, id) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const el = document.createElement(tagName);
    el.textContent = range.toString();
    range.deleteContents();
    range.insertNode(el);
    // 光标移到标签末尾
    const r = document.createRange();
    r.setStartAfter(el);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    syncEditorNote(editor, id);
  }

  function onTaskListClick(e) {
    const target = e.target;
    const li = target.closest('.task-card');
    if (!li) return;

    // 选中
    selectedId = li.dataset.id;
    updateSelection();

    const actionEl = target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = li.dataset.id;

    if (action === 'toggle-done') {
      toggleDone(id);
      e.preventDefault();
      e.stopPropagation();
    } else if (action === 'toggle-expand') {
      toggleExpand(id);
      e.preventDefault();
      e.stopPropagation();
    } else if (action === 'edit-title' || action === 'edit-note') {
      // 不阻止事件，让原生 focus 生效
    }
  }

  /**
   * input/keydown 在子元素触发冒泡到 #taskList 上统一处理。
   * 这样每张卡片无需单独绑 listener。
   */
  function onTaskListInput(e) {
    const target = e.target;
    const li = target.closest('.task-card');
    if (!li) return;
    const id = li.dataset.id;
    // contenteditable 的 e.target 可能是内部元素（strong/li 等），用 closest 取 action
    const actionEl = target.closest ? target.closest('[data-action]') : null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'edit-title') {
      const v = target.value;
      const it = findItem(id);
      if (!it) return;
      if (v !== it.title) updateTitle(id, v);
    } else if (action === 'edit-note') {
      // 所见即所得编辑器：渲染后的 DOM → Markdown 保存
      syncEditorNote(actionEl, id);
    }
  }

  function onTaskListKeyDown(e) {
    const target = e.target;
    const li = target.closest('.task-card');
    if (!li) return;
    const id = li.dataset.id;
    const actionEl = target.closest ? target.closest('[data-action]') : null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'edit-note') {
      // 所见即所得编辑器（contenteditable）：用原生富文本命令，格式即时可见
      const ctrl = e.ctrlKey || e.metaKey;

      // Tab / Shift+Tab：缩进 / 反缩进（列表内缩进嵌套层级）
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        return;
      }
      // Ctrl+B 加粗
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        document.execCommand('bold');
        return;
      }
      // Ctrl+I 斜体
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        document.execCommand('italic');
        return;
      }
      // Ctrl+K 行内代码：用 <code> 包裹选区
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        wrapSelectionWith('code', actionEl, id);
        return;
      }
      // Ctrl+Shift+K 代码块
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.execCommand('formatBlock', false, 'pre');
        return;
      }
      // Ctrl+Shift+[ 有序列表（Typora 风格；部分键盘 Shift 后 key 为 '{'）
      if (ctrl && e.shiftKey && (e.key === '[' || e.key === '{')) {
        e.preventDefault();
        document.execCommand('insertOrderedList');
        return;
      }
      // Ctrl+Shift+] 无序列表（Typora 风格；部分键盘 Shift 后 key 为 '}'）
      if (ctrl && e.shiftKey && (e.key === ']' || e.key === '}')) {
        e.preventDefault();
        document.execCommand('insertUnorderedList');
        return;
      }
      // Enter 延续列表：contenteditable 原生行为（li 内回车自动续项、空项回车结束列表）
      // Shift+Enter：软换行，原生 <br>
    }
  }

  // ============================================================
  //  其他全局事件
  // ============================================================

  function onGlobalKeyDown(e) {
    // Ctrl+S：立即保存
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
      return;
    }
    // Ctrl+N：新建任务
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      addTask();
      return;
    }
    // Ctrl+Shift+T：切换置顶
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      api.togglePin();
      return;
    }
    // Ctrl+/：帮助
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      toggleHelp();
      return;
    }
    // Backspace：删除选中
    if (e.key === 'Backspace') {
      const ae = document.activeElement;
      const focusTag = ae && ae.tagName;
      const isEditing = focusTag === 'INPUT' || focusTag === 'TEXTAREA' || (ae && ae.isContentEditable);
      if (!isEditing && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    }
    // Esc：关闭帮助 / 搜索条 / 主题面板
    if (e.key === 'Escape') {
      if (!helpPanel.classList.contains('hidden')) {
        toggleHelp(false);
      } else if (!themePanel.classList.contains('hidden')) {
        toggleThemePanel(false);
      } else if (!searchbarEl.classList.contains('hidden')) {
        toggleSearch(false);
      }
    }
  }

  function toggleHelp(force) {
    const show = typeof force === 'boolean' ? force : helpPanel.classList.contains('hidden');
    helpPanel.classList.toggle('hidden', !show);
    if (show) {
      btnHelp.classList.add('is-active');
    } else {
      btnHelp.classList.remove('is-active');
    }
  }

  function toggleSearch(force) {
    const show = typeof force === 'boolean' ? force : searchbarEl.classList.contains('hidden');
    searchbarEl.classList.toggle('hidden', !show);
    btnSearch.classList.toggle('is-active', show);
    if (show) {
      requestAnimationFrame(() => searchInputEl.focus());
    } else {
      activeSearch = '';
      searchInputEl.value = '';
      applyFilter();
    }
  }

  // ============================================================
  //  主题 & 设置
  // ============================================================

  function toggleThemePanel(force) {
    const show = typeof force === 'boolean' ? force : themePanel.classList.contains('hidden');
    themePanel.classList.toggle('hidden', !show);
    btnTheme.classList.toggle('is-active', show);
  }

  function applyTheme(key, persist = true) {
    if (!THEMES.find((t) => t.key === key)) key = 'amber';
    document.body.dataset.theme = key;
    settings.theme = key;
    renderThemeSwatches();
    if (persist) api.saveSettings({ theme: key });
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

  function applyBgImage(dataURL) {
    if (dataURL) {
      bgImageLayer.style.backgroundImage = `url(${dataURL})`;
      bgImageLayer.style.opacity = String(settings.bgOpacity);
      bgImageLayer.classList.add('has-image');
      settings.bgImage = dataURL;
    } else {
      bgImageLayer.style.backgroundImage = 'none';
      bgImageLayer.classList.remove('has-image');
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
    e.target.value = ''; // 允许重新选同一文件
  }

  function handleBgRemove() {
    applyBgImage(null);
    api.saveSettings({ bgImage: null });
  }

  function onBgOpacityChange() {
    if (isLoadingSettings) return;
    const v = parseFloat(bgOpacitySlider.value);
    settings.bgOpacity = v;
    if (settings.bgImage) {
      bgImageLayer.style.opacity = String(v);
    }
    api.saveSettings({ bgOpacity: v });
  }

  async function loadSettingsState() {
    try {
      isLoadingSettings = true;
      const s = await api.loadSettings();
      Object.assign(settings, s);
      applyTheme(settings.theme, false);   // 启动加载，不回写磁盘
      applyBgImage(settings.bgImage);
      bgOpacitySlider.value = String(settings.bgOpacity);
    } catch (_) {
      renderThemeSwatches();
    } finally {
      isLoadingSettings = false;
    }
  }

  // ============================================================
  //  Mini 态（贴边吸附）
  // ============================================================

  function updateMiniCount() {
    if (!miniCount) return;
    const pending = items.filter(
      (it) => it.title !== '__DIVIDER__' && !it.done
    ).length;
    miniCount.textContent = String(pending);
  }

  function enterMiniMode() {
    isMiniMode = true;
    document.body.classList.add('is-mini');
    updateMiniCount();
    miniBar.classList.remove('hidden');
  }

  function exitMiniMode() {
    isMiniMode = false;
    document.body.classList.remove('is-mini');
    miniBar.classList.add('hidden');
  }

  function initWindowControls() {
    minBtn.addEventListener('click', () => api.minimize());
    shrinkBtn.addEventListener('click', () => api.enterMini());
    closeBtn.addEventListener('click', () => api.close());
    pinBtn.addEventListener('click', () => api.togglePin());

    btnAdd.addEventListener('click', () => addTask());
    btnAddEmpty.addEventListener('click', () => addTask());
    btnDivider.addEventListener('click', () => addDivider());
    btnDelete.addEventListener('click', () => deleteSelected());
    btnSearch.addEventListener('click', () => toggleSearch());
    searchClearBtn.addEventListener('click', () => {
      searchInputEl.value = '';
      activeSearch = '';
      applyFilter();
      searchInputEl.focus();
    });
    searchInputEl.addEventListener('input', () => {
      activeSearch = searchInputEl.value;
      applyFilter();
    });
    btnHelp.addEventListener('click', () => toggleHelp());
    helpPanel.addEventListener('click', (e) => {
      if (e.target === helpPanel) toggleHelp(false);
    });

    // 主题
    btnTheme.addEventListener('click', () => {
      toggleHelp(false);
      toggleThemePanel();
    });
    themePanel.addEventListener('click', (e) => {
      if (e.target === themePanel) toggleThemePanel(false);
    });
    btnUploadBg.addEventListener('click', handleBgUpload);
    btnRemoveBg.addEventListener('click', handleBgRemove);
    bgFileInput.addEventListener('change', onBgFileSelected);
    bgOpacitySlider.addEventListener('input', onBgOpacityChange);

    // Mini bar: 用 JS 区分点击 vs 拖动(原生 drag region 已移除)
    // 方案: pointer events + screen 坐标 + pointer capture
    //   - 点击(位移<5px 且按下<250ms)或双击 → 退出 mini 态展开窗口
    //   - 拖动 → 跟随鼠标移动 mini 条位置
    let miniDownStart = null;       // { screenX, screenY, lastScreenX, lastScreenY, time }
    let miniIsDragging = false;
    const CLICK_DIST_THRESHOLD = 5;
    const CLICK_TIME_THRESHOLD = 250;

    miniBar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      miniDownStart = {
        screenX: e.screenX, screenY: e.screenY,
        lastScreenX: e.screenX, lastScreenY: e.screenY,
        time: Date.now()
      };
      miniIsDragging = false;
      miniBar.setPointerCapture(e.pointerId);
    });

    miniBar.addEventListener('pointermove', (e) => {
      if (!miniDownStart) return;
      const s = miniDownStart;
      const totalDx = e.screenX - s.screenX;
      const totalDy = e.screenY - s.screenY;
      const dist = Math.hypot(totalDx, totalDy);

      if (!miniIsDragging && dist > CLICK_DIST_THRESHOLD) {
        miniIsDragging = true;
        miniBar.classList.add('is-dragging');
      }
      if (miniIsDragging) {
        const dx = e.screenX - s.lastScreenX;
        const dy = e.screenY - s.lastScreenY;
        api.moveWindow(dx, dy);
        s.lastScreenX = e.screenX;
        s.lastScreenY = e.screenY;
      }
    });

    miniBar.addEventListener('pointerup', (e) => {
      if (!miniDownStart) return;
      const s = miniDownStart;
      const downMs = Date.now() - s.time;
      const totalDx = e.screenX - s.screenX;
      const totalDy = e.screenY - s.screenY;
      const dist = Math.hypot(totalDx, totalDy);

      miniBar.classList.remove('is-dragging');
      try { miniBar.releasePointerCapture(e.pointerId); } catch (_) {}

      const wasClick = !miniIsDragging && dist < CLICK_DIST_THRESHOLD && downMs < CLICK_TIME_THRESHOLD;
      miniDownStart = null;
      miniIsDragging = false;

      if (wasClick && isMiniMode) {
        api.exitMini();
      }
    });

    miniBar.addEventListener('pointercancel', () => {
      miniBar.classList.remove('is-dragging');
      miniDownStart = null;
      miniIsDragging = false;
    });

    // 双击直接退出 mini 态
    miniBar.addEventListener('dblclick', () => {
      if (isMiniMode) api.exitMini();
    });
  }

  function setPinButtonState(active) {
    pinBtn.classList.toggle('is-active', !!active);
    pinBtn.title = active ? '取消置顶 (Ctrl+Shift+T)' : '置顶 (Ctrl+Shift+T)';
  }
  async function initPinState() {
    try {
      setPinButtonState(await api.getPinState());
    } catch (_) {}
    api.onPinToggled(setPinButtonState);
  }

  // ============================================================
  //  加载 & 初始化
  // ============================================================

  async function loadInitial() {
    try {
      const doc = await api.loadNote();
      if (Array.isArray(doc?.items)) {
        items = doc.items;
      } else {
        items = [];
      }
      docUpdatedAt = doc?.updatedAt || null;
      saveTimeEl.textContent = formatTime(docUpdatedAt);
      renderList();
      setStatus(null, '就绪');
    } catch (err) {
      console.error('加载失败：', err);
      items = [];
      setStatus(null, '加载失败');
    }
  }

  /**
   * 粘贴处理：所见即所得编辑器只插入纯文本，避免网页富文本产生脏 DOM。
   * （粘贴 Markdown 源码时可直接输入，样式在输入后由 marked 再渲染）
   */
  function onTaskListPaste(e) {
    const target = e.target;
    const editor = target.closest && target.closest('[data-action="edit-note"]');
    if (!editor) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }

  function init() {
    // 事件委托
    taskListEl.addEventListener('click', onTaskListClick);
    taskListEl.addEventListener('input', onTaskListInput);
    taskListEl.addEventListener('keydown', onTaskListKeyDown);
    taskListEl.addEventListener('paste', onTaskListPaste);
    document.addEventListener('keydown', onGlobalKeyDown);

    initWindowControls();
    initPinState();

    // mini 态事件（主进程贴边/恢复时通知）
    if (api.onSnapStateChanged) {
      api.onSnapStateChanged((mini) => {
        if (mini) enterMiniMode(); else exitMiniMode();
      });
    }

    // 先加载主题设置，再加载笔记（避免主题闪烁）
    loadSettingsState().finally(() => {
      loadInitial();
    });

    window.addEventListener('beforeunload', () => {
      if (isDirty) {
        try {
          api.saveNote({
            items: items.map((it) => {
              const copy = { ...it };
              delete copy._idx;
              return copy;
            })
          });
        } catch (_) {}
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
