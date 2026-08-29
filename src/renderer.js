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
  const btnSettings = $('#btnSettings');
  const settingsPage = $('#settingsPage');
  const btnSettingsBack = $('#btnSettingsBack');
  const shortcutListEl = $('#shortcutList');
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
  let settings = { theme: 'amber', bgImage: null, bgOpacity: 0.35, shortcuts: {} };
  let isMiniMode = false;
  let isLoadingSettings = false;

  // ===== 编辑器快捷键（设置面板可开关 / 改绑） =====
  // 目录：默认键位 + 显示名；settings.shortcuts 中存用户覆盖 { enabled, key, ctrl, shift, alt }
  const DEFAULT_SHORTCUTS = {
    bold:          { enabled: true, key: 'b', ctrl: true,  shift: false, alt: false, label: '加粗' },
    italic:        { enabled: true, key: 'i', ctrl: true,  shift: false, alt: false, label: '斜体' },
    inlineCode:    { enabled: true, key: 'k', ctrl: true,  shift: false, alt: false, label: '行内代码' },
    codeBlock:     { enabled: true, key: 'k', ctrl: true,  shift: true,  alt: false, label: '代码块' },
    orderedList:   { enabled: true, key: '[', ctrl: true,  shift: true,  alt: false, label: '有序列表' },
    unorderedList: { enabled: true, key: ']', ctrl: true,  shift: true,  alt: false, label: '无序列表' }
  };
  const SHORTCUT_HANDLERS = {
    bold: () => document.execCommand('bold'),
    italic: () => document.execCommand('italic'),
    inlineCode: (editor, id) => wrapSelectionWith('code', editor, id),
    codeBlock: () => document.execCommand('formatBlock', false, 'pre'),
    orderedList: () => document.execCommand('insertOrderedList'),
    unorderedList: () => document.execCommand('insertUnorderedList')
  };
  // Shift 键产生的字符变化（匹配 Ctrl+Shift+[ 时 e.key 可能是 '{'）
  const SHIFT_CHARS = { '[': '{', ']': '}', '`': '~', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '-': '_', '=': '+', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' };
  let capturingShortcut = null; // 正在改绑的快捷键名，null 表示未在改绑

  /** 判断按键事件是否匹配某组合 */
  function matchShortcut(combo, e) {
    if (!combo || combo.enabled === false || !combo.key) return false;
    if (!!combo.ctrl !== !!(e.ctrlKey || e.metaKey)) return false;
    if (!!combo.shift !== !!e.shiftKey) return false;
    if (!!combo.alt !== !!e.altKey) return false;
    const k = String(combo.key).toLowerCase();
    const ek = e.key.toLowerCase();
    if (ek === k) return true;
    if (SHIFT_CHARS[k] && ek === SHIFT_CHARS[k]) return true;       // 绑定 '['，实际按下 '{'
    if (SHIFT_CHARS[ek] === k) return true;                          // 绑定 '{'，实际按下 '['
    return false;
  }

  /** 组合键显示文本，如 Ctrl+Shift+K */
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

  /** 生成可持久化的 shortcuts（去掉 label） */
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
              data-action="toggle-expand" title="点击展开备注">${escapeHtml(renderNoteMeta(item.note))}</span>
        <button class="card-toggle${item.expanded ? ' is-expanded' : ''}"
                data-action="toggle-expand" title="展开备注" type="button" aria-label="展开备注">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M5 3l6 5-6 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="card-note">
        <div class="card-editor" data-action="edit-note" contenteditable="true" spellcheck="false"
             data-placeholder="在此输入 Markdown 备注… (Ctrl+B 加粗 / Ctrl+K 代码 / Ctrl+Shift+[ ] 列表 / 输入 \`\`\`js 回车=代码块)"></div>
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
   * 完整 HTML 转义（用于 innerHTML 注入的文本）。
   * 备注内容可能含 < > & 等字符（如用户粘贴的 HTML/代码），
   * 不转义会被浏览器解析成真实 DOM，破坏卡片结构（hover 摘要显示异常）。
   */
  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  /**
   * Typora 式代码块输入：光标所在「行」只含 ``` 或 ```语言 时按回车，
   * 把该行替换成 <pre><code class="language-xxx"> 代码块，光标落入其中。
   * 返回 true 表示已转换（调用方应阻止默认的换行行为）。
   */
  function fenceToCodeBlock(editor, id) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const textNode = range.startContainer;
    if (!textNode || textNode.nodeType !== 3) return false; // 需要文本节点
    const offset = range.startOffset;
    const block = textNode.parentElement
      ? textNode.parentElement.closest('p,div,h1,h2,h3,h4,h5,h6,li,pre')
      : null;
    if (!block || !editor.contains(block)) return false;

    // 收集块内光标前的文本（fence 必须是整行内容）
    let before = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let cur;
    while ((cur = walker.nextNode())) {
      if (cur === textNode) { before += textNode.data.slice(0, offset); break; }
      before += cur.data;
    }
    const m = before.match(/^```([a-zA-Z0-9_+-]*)$/);
    if (!m) return false;

    // 光标后必须只有空白（即光标在行尾）
    let after = '';
    const walker2 = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let reached = false;
    while ((cur = walker2.nextNode())) {
      if (cur === textNode) { reached = true; after += textNode.data.slice(offset); continue; }
      if (reached) after += cur.data;
    }
    if (after.trim() !== '') return false;

    // 构造代码块 <pre><code class="language-xxx">
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (m[1]) code.className = 'language-' + m[1];
    pre.appendChild(code);

    if (block === editor) {
      // 文本直接位于编辑器根：替换光标所在文本节点
      textNode.parentNode.replaceChild(pre, textNode);
    } else if (block.tagName === 'LI') {
      // 列表项内：保留列表结构，代码块嵌进 li
      block.replaceChildren(pre);
    } else {
      block.replaceWith(pre);
    }

    // 光标落入代码块开头
    const r = document.createRange();
    r.setStart(code, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    syncEditorNote(editor, id);
    return true;
  }

  /**
   * 光标当前是否位于代码块（<pre> 或行内 <code>）内。
   * @returns {HTMLElement|null} pre/code 元素，或 null
   */
  function caretInCodeBlock(editor) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const block = el && el.closest ? el.closest('pre,code') : null;
    if (!block || !editor.contains(block)) return null;
    return block;
  }

  /**
   * 代码块内回车：只插入换行，不拆分割裂代码元素。
   * - <pre>（代码块）：插入 '\n' 文本节点（pre 保留换行，turndown 序列化不丢行）
   * - 行内 <code>：插入 <br>（turndown 的 br→\n 规则会转回换行）
   */
  function insertCodeNewline(block, editor, id) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    // <pre> 或 <pre> 内的 <code> → 插入 '\n'（pre 保留换行，turndown 序列化不丢行）；
    // 行内 <code>（不在 pre 内）→ 插入 <br>（turndown 的 br→\n 规则转回换行）
    const inPre = block.tagName === 'PRE' || (block.tagName === 'CODE' && block.closest('pre'));
    if (inPre) {
      const tn = document.createTextNode('\n');
      range.insertNode(tn);
      const r = document.createRange();
      r.setStartAfter(tn);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      document.execCommand('insertLineBreak');
    }
    // 手动 DOM 变更不触发 input 事件，这里同步一次（execCommand 路径重复同步无害）
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

      // Enter：在代码块内只插换行（避免被 Chromium 拆分成两个代码块）；
      // 行首 ```[语言] 则新建代码块（Typora 输入习惯，如 ```node / ```js 回车）
      if (e.key === 'Enter') {
        const codeBlock = caretInCodeBlock(actionEl);
        if (codeBlock) {
          e.preventDefault();
          insertCodeNewline(codeBlock, actionEl, id);
          return;
        }
        if (!e.shiftKey && fenceToCodeBlock(actionEl, id)) {
          e.preventDefault();
          return;
        }
      }

      // Tab / Shift+Tab：缩进 / 反缩进（列表内缩进嵌套层级）
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        return;
      }
      // 编辑器快捷键（键位与开关来自设置面板，可改绑）
      for (const [name, handler] of Object.entries(SHORTCUT_HANDLERS)) {
        if (matchShortcut(settings.shortcuts[name], e)) {
          e.preventDefault();
          handler(actionEl, id);
          return;
        }
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
    // Esc：关闭帮助 / 设置页 / 主题面板 / 搜索条
    if (e.key === 'Escape') {
      if (!helpPanel.classList.contains('hidden')) {
        toggleHelp(false);
      } else if (document.body.classList.contains('showing-settings')) {
        toggleSettingsPage(false);
      } else if (!themePanel.classList.contains('hidden')) {
        toggleThemePanel(false);
      } else if (!searchbarEl.classList.contains('hidden')) {
        toggleSearch(false);
      }
    }
    // Ctrl+,：打开 / 关闭设置页
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      toggleHelp(false);
      toggleThemePanel(false);
      toggleSettingsPage();
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

  // ============================================================
  //  设置页（整页视图）：快捷键开关 / 改绑
  // ============================================================

  function toggleSettingsPage(force) {
    const show = typeof force === 'boolean' ? force : !document.body.classList.contains('showing-settings');
    document.body.classList.toggle('showing-settings', show);
    btnSettings.classList.toggle('is-active', show);
    if (show) renderShortcutList();
    else endShortcutCapture();
  }

  /** 渲染快捷键列表：每行 = 名称 + 开关 + 按键徽标 */
  function renderShortcutList() {
    if (!shortcutListEl) return;
    shortcutListEl.innerHTML = '';
    for (const [name, def] of Object.entries(DEFAULT_SHORTCUTS)) {
      const s = settings.shortcuts[name] || def;
      const row = document.createElement('div');
      row.className = 'shortcut-row' + (s.enabled === false ? ' disabled' : '');

      const label = document.createElement('span');
      label.className = 'shortcut-label';
      label.textContent = def.label;

      // 启用开关
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

      // 按键徽标（点击改绑）
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

  /** 进入改绑模式：捕获下一次按键组合 */
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

  /** 改绑捕获：Esc 取消；Backspace/Delete 解绑；需 Ctrl/Alt 组合或功能键 */
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
      // 无修饰键的普通键不允许（会与正常输入冲突），提示后继续等待
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
      // 快捷键逐项合并默认值（老配置缺项兜底）
      settings.shortcuts = settings.shortcuts || {};
      for (const [name, def] of Object.entries(DEFAULT_SHORTCUTS)) {
        settings.shortcuts[name] = { ...def, ...(settings.shortcuts[name] || {}) };
      }
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
      toggleSettingsPage(false);
      toggleThemePanel();
    });
    themePanel.addEventListener('click', (e) => {
      if (e.target === themePanel) toggleThemePanel(false);
    });

    // 设置页
    btnSettings.addEventListener('click', () => {
      toggleHelp(false);
      toggleThemePanel(false);
      toggleSettingsPage();
    });
    btnSettingsBack.addEventListener('click', () => toggleSettingsPage(false));
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

    // 点击面板外任意处 → 自动收起主题面板
    document.addEventListener('click', (e) => {
      if (!themePanel.classList.contains('hidden') &&
          !themePanel.contains(e.target) && !btnTheme.contains(e.target)) {
        toggleThemePanel(false);
      }
    });

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
