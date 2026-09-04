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
  const btnSettings = $('#btnSettings');
  const miniBar = $('#miniBar');
  const miniCount = $('#miniCount');
  const appEl = $('#app');
  const bgImageLayer = $('#bgImageLayer');
  const btnBatchDelete = $('#btnBatchDelete');
  const batchDeleteLabel = $('#batchDeleteLabel');
  const confirmMask = $('#confirmMask');
  const confirmText = $('#confirmText');
  const btnConfirmOk = $('#btnConfirmOk');
  const btnConfirmCancel = $('#btnConfirmCancel');

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
  let pendingDeleteId = null; // 单条删除二次确认待执行 id

  // ===== 主题常量 & 设置状态 =====
  const THEMES = [
    { key: 'amber',      name: '琥珀', accent: '#e0a82e', bg: '#FAF5E1', ink: '#4a3f24' },
    { key: 'blue',       name: '深蓝', accent: '#2B5275', bg: '#FFFBBD', ink: '#1a2a3a' },
    { key: 'olive',      name: '墨绿', accent: '#4D5E30', bg: '#F5F0D4', ink: '#2a3319' },
    { key: 'terracotta', name: '砖红', accent: '#D16647', bg: '#F5EAD4', ink: '#3d2a1a' },
    { key: 'gold',       name: '棕金', accent: '#BCA052', bg: '#F5EAD4', ink: '#4A3C2B' },
    { key: 'rose',       name: '酒红', accent: '#954B44', bg: '#F5E5E0', ink: '#3a1f1b' },
    { key: 'sage',       name: '草绿', accent: '#A68329', bg: '#F5F0D4', ink: '#3a2f14' },
    { key: 'night',      name: '纯黑', accent: '#E8B84B', bg: '#16161A', ink: '#F0F0F2' },
    { key: 'paper',      name: '纯白', accent: '#2B5275', bg: '#FFFFFF', ink: '#1A1A1A' },
    { key: 'remi',       name: '蕾米埃尔', accent: '#A788D8', bg: '#FDF0F6', ink: '#693FA8' },
    { key: 'remi-night', name: '蕾米埃尔·夜', accent: '#F5A8C0', bg: '#2A1B3D', ink: '#F3EAFB' }
  ];
  let settings = { theme: 'amber', material: 'opaque', acrylicBlur: 40, bgImage: null, bgOpacity: 0.35, fontSize: 13, closeAction: 'tray', windowSize: 'default', customWindowSize: { width: 560, height: 620 }, miniBallStyle: 'classic', shortcuts: {} };
  let isMiniMode = false;
let miniMouseIgnoring = false; // mini 态鼠标穿透状态
  let isLoadingSettings = false;
  let enterMiniTimer = null;
  let exitMiniTimer = null;

  // ===== 编辑器快捷键（设置面板可开关 / 改绑） =====
  // 目录：默认键位 + 显示名；settings.shortcuts 中存用户覆盖 { enabled, key, ctrl, shift, alt }
  const DEFAULT_SHORTCUTS = {
    bold:          { enabled: true, key: 'b', ctrl: true,  shift: false, alt: false, label: '加粗' },
    italic:        { enabled: true, key: 'i', ctrl: true,  shift: false, alt: false, label: '斜体' },
    strikethrough: { enabled: true, key: 'd', ctrl: true,  shift: false, alt: false, label: '删除线' },
    inlineCode:    { enabled: true, key: 'k', ctrl: true,  shift: false, alt: false, label: '行内代码' },
    codeBlock:     { enabled: true, key: 'k', ctrl: true,  shift: true,  alt: false, label: '代码块' },
    orderedList:   { enabled: true, key: '[', ctrl: true,  shift: true,  alt: false, label: '有序列表' },
    unorderedList: { enabled: true, key: ']', ctrl: true,  shift: true,  alt: false, label: '无序列表' }
  };
  const SHORTCUT_HANDLERS = {
    bold: () => document.execCommand('bold'),
    italic: () => document.execCommand('italic'),
    strikethrough: (editor, id) => toggleStrikethrough(editor, id),
    inlineCode: (editor, id) => wrapSelectionWith('code', editor, id),
    codeBlock: () => document.execCommand('formatBlock', false, 'pre'),
    orderedList: () => document.execCommand('insertOrderedList'),
    unorderedList: () => document.execCommand('insertUnorderedList')
  };
  // Shift 键产生的字符变化（匹配 Ctrl+Shift+[ 时 e.key 可能是 '{'）
  const SHIFT_CHARS = { '[': '{', ']': '}', '`': '~', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '-': '_', '=': '+', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' };

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
  //  编辑器 undo / redo（基于 innerHTML 快照 + 光标偏移 + 防抖）
  //  背景：contenteditable 原生 Ctrl+Z 在 innerHTML 被重渲染
  //  （rerenderEditorContent）或 DOM API 直接修改（wrapSelectionWith）
  //  后失效，故自管理快照栈。快照同时存光标字符偏移，恢复后还原。
  // ============================================================
  const editorUndoMap = new Map(); // editor 元素 → { undo, redo, lastSnap, lastCaret, timer }

  const UNDO_MAX = 50;       // 最多保留 50 步
  const UNDO_DEBOUNCE = 600; // 停止输入 600ms 后压栈（连续打字算一步）

  /** 获取/创建编辑器的 undo 状态对象 */
  function getUndoState(editor) {
    let st = editorUndoMap.get(editor);
    if (!st) {
      st = { undo: [], redo: [], lastSnap: '', lastCaret: 0, timer: null };
      editorUndoMap.set(editor, st);
    }
    return st;
  }

  /** 获取光标在编辑器内的字符偏移（从根开始，按文本节点顺序累加） */
  function getCaretOffsetInEditor(editor) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return 0;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) return offset + range.startOffset;
      offset += node.data.length;
    }
    return offset;
  }

  /** 按字符偏移把光标恢复到编辑器内 */
  function setCaretOffsetInEditor(editor, offset) {
    if (offset < 0) offset = 0;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node;
    let remaining = offset;
    let target = null;
    let targetOffset = 0;
    while ((node = walker.nextNode())) {
      if (remaining <= node.data.length) {
        target = node; targetOffset = remaining; break;
      }
      remaining -= node.data.length;
    }
    if (!target) {
      // 偏移超出末尾 → 定位到最后一个文本节点末尾
      const last = editor.lastChild;
      if (last && last.nodeType === 3) {
        target = last; targetOffset = last.data.length;
      } else if (last) {
        const r = document.createRange();
        r.setStartAfter(last); r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        return;
      } else {
        // 空编辑器
        const r = document.createRange();
        r.setStart(editor, 0); r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
    }
    const r = document.createRange();
    r.setStart(target, targetOffset);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 防抖压栈：连续输入归并为一步，停止打字后压入 */
  function scheduleUndoSnapshot(editor) {
    const st = getUndoState(editor);
    clearTimeout(st.timer);
    st.timer = setTimeout(() => pushUndoSnapshot(editor), UNDO_DEBOUNCE);
  }

  /** 立即压栈当前快照（跳过防抖），存 { html, caret } 对象 */
  function pushUndoSnapshot(editor) {
    const st = getUndoState(editor);
    clearTimeout(st.timer);
    const snap = editor.innerHTML;
    if (snap === st.lastSnap) return; // 无变化
    const caret = getCaretOffsetInEditor(editor);
    // 把"上一个状态"压入 undo 栈（含其光标偏移）
    st.undo.push({ html: st.lastSnap, caret: st.lastCaret });
    if (st.undo.length > UNDO_MAX) st.undo.shift();
    // 更新 lastSnap/lastCaret 为当前状态
    st.lastSnap = snap;
    st.lastCaret = caret;
    st.redo.length = 0; // 新操作清空 redo
  }

  /** 在编辑器聚焦时初始化快照基线（仅首次或重渲染后） */
  function initUndoBaseline(editor) {
    const st = getUndoState(editor);
    st.lastSnap = editor.innerHTML;
    st.lastCaret = getCaretOffsetInEditor(editor);
  }

  /** 撤销：弹出上一步恢复 innerHTML + 光标，当前状态推入 redo */
  function editorUndo(editor) {
    const st = getUndoState(editor);
    if (st.undo.length === 0) return false;
    // 确保当前状态已压栈（防抖未到期的情况）
    if (st.lastSnap !== editor.innerHTML) {
      st.undo.push({ html: st.lastSnap, caret: st.lastCaret });
      st.lastSnap = editor.innerHTML;
      st.lastCaret = getCaretOffsetInEditor(editor);
    }
    // 当前状态推入 redo
    st.redo.push({ html: editor.innerHTML, caret: getCaretOffsetInEditor(editor) });
    const prev = st.undo.pop();
    editor.innerHTML = prev.html;
    setCaretOffsetInEditor(editor, prev.caret);
    st.lastSnap = prev.html;
    st.lastCaret = prev.caret;
    return true;
  }

  /** 重做：恢复被撤销的操作 */
  function editorRedo(editor) {
    const st = getUndoState(editor);
    if (st.redo.length === 0) return false;
    st.undo.push({ html: editor.innerHTML, caret: getCaretOffsetInEditor(editor) });
    const next = st.redo.pop();
    editor.innerHTML = next.html;
    setCaretOffsetInEditor(editor, next.caret);
    st.lastSnap = next.html;
    st.lastCaret = next.caret;
    return true;
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
      li.innerHTML = `
        <div class="divider-row">
          <div class="drag-handle" title="拖动排序">
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><circle cx="5" cy="3.5" r="1.3" fill="currentColor"/><circle cx="11" cy="3.5" r="1.3" fill="currentColor"/><circle cx="5" cy="8" r="1.3" fill="currentColor"/><circle cx="11" cy="8" r="1.3" fill="currentColor"/><circle cx="5" cy="12.5" r="1.3" fill="currentColor"/><circle cx="11" cy="12.5" r="1.3" fill="currentColor"/></svg>
          </div>
          <hr/>
        </div>
        <input class="divider-label${item.label ? '' : ' is-empty'}" data-action="edit-divider-label"
               type="text" value="${escapeAttr(item.label || '')}"
               placeholder="分区标题（可选）" spellcheck="false" />
      `;
      return li;
    }

    li.innerHTML = `
      <div class="task-row">
        <div class="drag-handle" title="拖动排序">
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><circle cx="5" cy="3.5" r="1.3" fill="currentColor"/><circle cx="11" cy="3.5" r="1.3" fill="currentColor"/><circle cx="5" cy="8" r="1.3" fill="currentColor"/><circle cx="11" cy="8" r="1.3" fill="currentColor"/><circle cx="5" cy="12.5" r="1.3" fill="currentColor"/><circle cx="11" cy="12.5" r="1.3" fill="currentColor"/></svg>
        </div>
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
          if (editor && editor.innerHTML === '') {
            editor.innerHTML = html;
            // 代码块结构简化：<pre><code class="language-x">…</code></pre> → <pre class="language-x">…</pre>
            // 行内 <code> 嵌套在 pre 里会让 Chromium 的编辑行为不稳定（回车被吞/拆块），
            // 纯 <pre> 的换行行为是明确可靠的。
            editor.querySelectorAll('pre').forEach((pre) => {
              const code = pre.firstElementChild;
              if (code && code.tagName === 'CODE') {
                const lang = (code.className.match(/language-(\S+)/) || [])[1];
                if (lang) pre.className = 'language-' + lang;
                pre.textContent = code.textContent; // 保留代码内容（含换行）
              }
              applyCodeLangBadge(pre); // 右下角语言标识
            });
            // 代码块语法高亮（highlight.js via preload）
            highlightCodeBlocks(editor);
          }
        }
      })
      .catch(() => {});
    return li;
  }

  function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ============================================================
  //  代码块高亮（highlight.js via preload）
  //  设计：展示态 pre 内是高亮 span；进入编辑（focus）时还原为纯文本，
  //  保证 contenteditable 的编辑行为与之前完全一致（回车/退出逻辑不受影响）；
  //  失焦时重新高亮。turndown 序列化用递归提取文本，span 不影响 Markdown 往返。
  // ============================================================

  /** 提取 pre 的纯代码文本（span 穿透、<br> 视为换行） */
  function preCodeText(pre) {
    let s = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) s += child.data;
        else if (child.nodeName === 'BR') s += '\n';
        else walk(child);
      }
    };
    walk(pre);
    return s;
  }

  /** 从 pre 的 class（language-x）提取语言名，写入 data-lang 供右下角标识显示 */
  function applyCodeLangBadge(pre) {
    if (!pre) return;
    const lang = (pre.className.match(/language-(\S+)/) || [])[1];
    if (lang) pre.dataset.lang = lang;
    else delete pre.dataset.lang;
  }

  /** 对编辑器内所有代码块应用高亮（跳过已高亮 / 空代码块） */
  function highlightCodeBlocks(editor) {
    if (!editor || !api.highlightCode) return;
    editor.querySelectorAll('pre').forEach((pre) => {
      applyCodeLangBadge(pre); // 右下角语言标识（语言名取自 class language-x）
      if (pre.querySelector('span[class*="hljs-"]')) return; // 已高亮
      const text = preCodeText(pre);
      if (!text.trim()) return; // 空代码块保持纯文本（输入占位）
      const lang = (pre.className.match(/language-(\S+)/) || [])[1];
      Promise.resolve(api.highlightCode(text, lang)).then((html) => {
        if (pre.isConnected && !pre.querySelector('span[class*="hljs-"]')) {
          pre.innerHTML = html;
        }
      }).catch(() => {});
    });
  }

  /** 把代码块的高亮 span 还原为纯文本（进入编辑前调用，避免 span 干扰输入） */
  function stripCodeHighlight(pre) {
    if (!pre || !pre.querySelector('span[class*="hljs-"]')) return;
    pre.textContent = preCodeText(pre);
  }

  /** 计算光标在 pre 内的字符偏移（编辑前保存，还原纯文本后恢复位置） */
  function caretOffsetIn(pre) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0);
    if (!pre.contains(range.startContainer)) return -1;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) { offset += range.startOffset; return offset; }
      offset += node.data.length;
    }
    return offset;
  }

  /** 按字符偏移把光标恢复到 pre 内（strip 高亮后调用） */
  function restoreCaretTo(pre, offset) {
    if (!pre || offset < 0) return;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let node;
    let remaining = offset;
    let target = null;
    let targetOffset = 0;
    while ((node = walker.nextNode())) {
      if (remaining <= node.data.length) {
        target = node; targetOffset = remaining; break;
      }
      remaining -= node.data.length;
    }
    if (!target && pre.lastChild) {
      // 偏移超出末尾 → 定位到最后一个文本节点末尾
      target = pre.lastChild.nodeType === 3 ? pre.lastChild : null;
      targetOffset = target ? target.data.length : 0;
      if (!target) {
        // 无文本节点（如只有 <br>）→ 定位到 pre 开头
        const r0 = document.createRange();
        r0.setStart(pre, 0); r0.collapse(true);
        const sel0 = window.getSelection();
        sel0.removeAllRanges(); sel0.addRange(r0);
        return;
      }
    }
    if (target) {
      const r = document.createRange();
      r.setStart(target, targetOffset);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  // 代码块高亮：聚焦编辑时还原纯文本，失焦时重新高亮（事件委托在 #taskList）
  function onEditorFocusIn(e) {
    const editor = e.target.closest && e.target.closest('.card-editor');
    // 编辑器聚焦：初始化 undo 基线（首次聚焦或重渲染后）
    if (editor) initUndoBaseline(editor);

    const pre = e.target.closest && e.target.closest('pre');
    if (!pre) return;
    pre.dataset.caretOffset = String(caretOffsetIn(pre));
    stripCodeHighlight(pre);
    restoreCaretTo(pre, parseInt(pre.dataset.caretOffset, 10) || 0);
  }

  function onEditorFocusOut(e) {
    const editor = e.target.closest && e.target.closest('.card-editor');
    if (!editor) return;
    // 焦点移到编辑器内部（如 pre 之间）不重新渲染，避免打断
    if (editor.contains(e.relatedTarget)) return;
    const id = e.target.closest && e.target.closest('.task-card')
      ? e.target.closest('.task-card').dataset.id : null;
    // 失焦时先保存（del → ~~text~~ 等格式序列化），再按保存值重渲染，
    // 让删除线等格式始终由 marked 生成（不依赖 Chromium 保留 <del>，失焦后仍可见）
    const it = id ? findItem(id) : null;
    if (it && !isMiniMode) {
      // 离开前确保当前输入已压栈，供下次聚焦时 Ctrl+Z 能撤回到此编辑会话的步骤
      pushUndoSnapshot(editor);
      Promise.resolve(api.htmlToMarkdown(editor.innerHTML))
        .then((md) => {
          if (md !== it.note) updateNote(id, md);
          rerenderEditorContent(editor, md);
          // innerHTML 被重渲染替换 → 旧 undo 历史失效，清空并重置基线
          const st = editorUndoMap.get(editor);
          if (st) { st.undo.length = 0; st.redo.length = 0; st.lastSnap = ''; }
        })
        .catch(() => {});
    } else {
      pushUndoSnapshot(editor);
      highlightCodeBlocks(editor);
    }
  }

  /** 用 Markdown 重新渲染编辑器内容（marked 输出，保持 WYSIWYG 与数据一致） */
  function rerenderEditorContent(editor, md) {
    if (!editor) return;
    Promise.resolve(api.renderMarkdown(md || ''))
      .then((html) => {
        if (!editor.isConnected) return;
        editor.innerHTML = html;
        // 代码块简化：<pre><code class="language-x"> → <pre class="language-x">
        editor.querySelectorAll('pre').forEach((pre) => {
          const code = pre.firstElementChild;
          if (code && code.tagName === 'CODE') {
            const lang = (code.className.match(/language-(\S+)/) || [])[1];
            if (lang) pre.className = 'language-' + lang;
            pre.textContent = code.textContent;
          }
          applyCodeLangBadge(pre);
        });
        highlightCodeBlocks(editor);
      })
      .catch(() => {});
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
   * 剥离常见 Markdown 语法标记，得到纯文本（用于折叠摘要，避免显示 **、- 、``` 等）。
   */
  function stripMarkdown(text) {
    let s = String(text || '');
    // 代码围栏（连同内容）→ 空格
    s = s.replace(/```[\s\S]*?```/g, ' ');
    // 行内代码 `code` → code
    s = s.replace(/`([^`]+)`/g, '$1');
    // 删除线 ~~text~~ → text（预览纯文本显示，不暴露 Markdown 源码）
    s = s.replace(/~~([^~]+)~~/g, '$1');
    // 粗体/斜体 **x** / *x* / __x__ / _x_
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
         .replace(/__([^_]+)__/g, '$1')
         .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1$2')
         .replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1$2');
    // 标题 # ## ### …（行首）
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    // 引用 >
    s = s.replace(/^\s{0,3}>\s?/gm, '');
    // 列表标记 - * + 数字.
    s = s.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '');
    // 图片/链接 ![alt](url) / [text](url) → 文本
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
         .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // 分隔线 --- / *** / ___
    s = s.replace(/^\s{0,3}([-*_]){3,}\s*$/gm, '');
    // 折叠空白
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * 折叠态摘要：剥离 Markdown 语法后截断显示纯文本。
   */
  function renderNoteMeta(note) {
    const s = stripMarkdown(note);
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
  //  拖动排序（HTML5 DnD；仅从左侧把手发起，搜索过滤时禁用）
  //  数据：items 数组顺序即显示/保存顺序；DOM 同步移动节点，
  //  不重渲染（保留编辑器输入状态），走 markDirty + 防抖自动保存持久化。
  // ============================================================
  let dragId = null; // 正在拖动的卡片 id

  /** 把手按下时临时开启 li.draggable（避免整卡 draggable 干扰输入框/编辑器选字） */
  function onTaskListMouseDown(e) {
    if (e.button !== 0) return;
    const handle = e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!handle) return;
    const li = handle.closest('.task-card');
    if (li && !activeSearch) li.draggable = true;
  }

  /** 未发生拖动的普通抬起：撤销 draggable */
  function onTaskListMouseUp(e) {
    const li = e.target.closest ? e.target.closest('.task-card') : null;
    if (li && li.draggable) li.draggable = false;
  }

  function onTaskListDragStart(e) {
    const li = e.target.closest ? e.target.closest('.task-card') : null;
    if (!li || !li.draggable) { e.preventDefault(); return; }
    dragId = li.dataset.id;
    li.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  }

  /** 根据光标 Y 计算落点：插入到哪张卡片的前/后；无参照卡（空列表）返回 null */
  function computeDropTarget(clientY) {
    const cards = taskListEl.querySelectorAll('.task-card:not(.is-dragging)');
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      if (r.height > 0 && clientY < r.top + r.height / 2) {
        return { id: card.dataset.id, after: false };
      }
    }
    const last = cards.length ? cards[cards.length - 1] : null;
    return last ? { id: last.dataset.id, after: true } : null;
  }

  function clearDropIndicator() {
    taskListEl
      .querySelectorAll('.drop-above, .drop-below')
      .forEach((el) => el.classList.remove('drop-above', 'drop-below'));
  }

  function onTaskListDragOver(e) {
    if (!dragId) return;
    e.preventDefault(); // 允许 drop
    e.dataTransfer.dropEffect = 'move';
    const t = computeDropTarget(e.clientY);
    clearDropIndicator();
    if (t) {
      const el = cardElById(t.id);
      if (el) el.classList.add(t.after ? 'drop-below' : 'drop-above');
    }
  }

  function onTaskListDragLeave(e) {
    if (!dragId) return;
    if (e.relatedTarget && taskListEl.contains(e.relatedTarget)) return; // 子元素间移动
    clearDropIndicator();
  }

  function onTaskListDrop(e) {
    if (!dragId) return;
    e.preventDefault();
    const t = computeDropTarget(e.clientY);
    if (t && t.id !== dragId) moveItemOrder(dragId, t.id, t.after);
    cleanupCardDrag();
  }

  function onTaskListDragEnd() {
    cleanupCardDrag();
  }

  function cleanupCardDrag() {
    clearDropIndicator();
    const li = dragId ? cardElById(dragId) : null;
    if (li) {
      li.classList.remove('is-dragging');
      li.draggable = false;
    }
    dragId = null;
  }

  /** 把 id 卡片移动到 refId 前/后（items 数组 + DOM 同步），自动保存持久化 */
  function moveItemOrder(id, refId, after) {
    const from = items.findIndex((it) => it.id === id);
    if (from < 0) return;
    const [moved] = items.splice(from, 1);
    const to = items.findIndex((it) => it.id === refId);
    if (to < 0) {
      items.splice(from, 0, moved); // 参照卡不存在（理论不发生）：放回原位
      return;
    }
    items.splice(after ? to + 1 : to, 0, moved);
    markDirty();
    scheduleAutosave();
    const li = cardElById(id);
    const refLi = cardElById(refId);
    if (li && refLi) {
      if (after) refLi.after(li);
      else refLi.before(li);
    }
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
      label: '', // 分割线可选标题
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
    // 二次确认（与批量删除共用确认弹窗）
    const item = findItem(selectedId);
    const title = item && item.title ? item.title.trim() : '';
    const label = title ? `「${title.slice(0, 20)}${title.length > 20 ? '…' : ''}」` : '该项';
    confirmText.textContent = `确定要删除${label}吗？此操作不可恢复。`;
    confirmMask.classList.remove('hidden');
    btnConfirmOk.focus();
    // 标记待删除 id，确认后执行
    pendingDeleteId = selectedId;
  }

  // ============================================================
  //  批量删除（工具栏「删除」进入批量选择 → 右下角按钮 → 二次确认）
  // ============================================================

  let batchMode = false;          // 是否处于批量选择模式
  let batchSelected = new Set();  // 批量选中的任务 id

  function enterBatchMode() {
    if (batchMode) return;
    batchMode = true;
    batchSelected.clear();
    document.body.classList.add('is-batch-mode');
    btnDelete.classList.add('is-active');
    updateBatchUI();
  }

  function exitBatchMode() {
    if (!batchMode) return;
    batchMode = false;
    batchSelected.clear();
    document.body.classList.remove('is-batch-mode');
    btnDelete.classList.remove('is-active');
    // 清除卡片上的批量选中样式
    taskListEl.querySelectorAll('.task-card.is-batch-selected').forEach((el) => {
      el.classList.remove('is-batch-selected');
    });
    updateBatchUI();
  }

  function toggleBatchSelect(id) {
    if (!batchMode) return;
    if (batchSelected.has(id)) {
      batchSelected.delete(id);
    } else {
      batchSelected.add(id);
    }
    const el = cardElById(id);
    if (el) el.classList.toggle('is-batch-selected', batchSelected.has(id));
    updateBatchUI();
  }

  /** 刷新右下角浮动按钮：未选择时禁用 */
  function updateBatchUI() {
    const n = batchSelected.size;
    btnBatchDelete.classList.toggle('hidden', !batchMode);
    batchDeleteLabel.textContent = n > 0 ? `删除选中 (${n})` : '删除选中';
    btnBatchDelete.classList.toggle('is-disabled', n === 0);
  }

  /** 弹出二次确认框 */
  function openBatchDeleteConfirm() {
    const n = batchSelected.size;
    if (n === 0) return;
    confirmText.textContent = `确定要删除选中的 ${n} 个任务吗？此操作不可恢复。`;
    confirmMask.classList.remove('hidden');
    btnConfirmOk.focus();
  }

  function closeBatchDeleteConfirm() {
    confirmMask.classList.add('hidden');
  }

  /** 确认后执行批量删除并退出批量模式 */
  function doBatchDelete() {
    const ids = [...batchSelected];
    closeBatchDeleteConfirm();
    for (const id of ids) deleteItem(id);
    exitBatchMode();
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
    // 离散格式操作立即压栈（不防抖），保证 Ctrl+Z 可精确撤销
    pushUndoSnapshot(editor);
  }

  /**
   * 删除线切换（Ctrl+D）：选区起点已在 del/s/strike 内 → 解开该标签恢复纯文本；
   * 否则用 <del> 包裹选区。不 normalize 文本节点，保证选区端点引用不变。
   */
  function toggleStrikethrough(editor, id) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement
      : range.startContainer;
    const del = startEl && startEl.closest ? startEl.closest('del, s, strike') : null;
    if (!del || !editor.contains(del)) {
      wrapSelectionWith('del', editor, id);
      return;
    }
    // 解开标签：子节点原位上移，删除空壳（选区所在文本节点保持原引用）
    const parent = del.parentNode;
    if (!parent) return;
    while (del.firstChild) parent.insertBefore(del.firstChild, del);
    parent.removeChild(del);
    syncEditorNote(editor, id);
    pushUndoSnapshot(editor);
  }

  /** 光标是否在删除线（del/s/strike）内 */
  function caretInStrikethrough(editor) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const c = sel.getRangeAt(0).startContainer;
    const el = c.nodeType === 3 ? c.parentElement : c;
    return !!(el && el.closest && editor.contains(el) && el.closest('del, s, strike'));
  }

  /**
   * 回车后清理新行继承的删除线。原生 contenteditable 回车会把 <del> 拆分延续到
   * 新块（如 <p><del>文</del></p><p><del><br></del></p>），视觉上第二行仍是删除线。
   * 默认回车完成后（setTimeout 0）把光标所在块内的 del/s/strike 全部解开；
   * 光标直接位于编辑器根时只解开空壳（无文本或仅 <br>），避免误伤上一行内容。
   */
  function cleanupStrikethroughAfterEnter(editor, id) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const c = sel.getRangeAt(0).startContainer;
    const el = c.nodeType === 3 ? c.parentElement : c;
    if (!el || !editor.contains(el)) return;
    const block = el.closest('p, div, h1, h2, h3, h4, h5, h6, li, pre');
    const scope = block && editor.contains(block) ? block : editor;
    const onlyEmpty = scope === editor; // 根级无法界定“新行”，只清理空壳
    let changed = false;
    scope.querySelectorAll('del, s, strike').forEach((d) => {
      if (onlyEmpty && d.textContent.trim() !== '') return;
      const parent = d.parentNode;
      if (!parent) return;
      while (d.firstChild) parent.insertBefore(d.firstChild, d);
      parent.removeChild(d);
      changed = true;
    });
    if (changed) syncEditorNote(editor, id);
  }

  /** 光标是否位于引用块（blockquote，Tab 缩进产生）内的空行上 */
  function caretInEmptyBlockquote(editor) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const c = sel.getRangeAt(0).startContainer;
    const el = c.nodeType === 3 ? c.parentElement : c;
    if (!el || !editor.contains(el)) return false;
    const bq = el.closest('blockquote');
    if (!bq || !editor.contains(bq)) return false;
    const block = el.closest('p, div, h1, h2, h3, h4, h5, h6, li, pre');
    if (!block || !bq.contains(block)) return false;
    return block.textContent.trim() === '' && !block.querySelector('img');
  }

  /**
   * 退出引用块：光标在引用块内的空行上时按回车（Typora 习惯）。
   * 三种情况：空行是引用块唯一内容 → 整体替换为普通段落；
   * 空行在末尾 → 删空行、在引用块后插入新段落；空行在中间 → 拆分两个引用块、中间插段落。
   */
  function exitBlockquote(editor, id) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const c = sel.getRangeAt(0).startContainer;
    const el = c.nodeType === 3 ? c.parentElement : c;
    if (!el || !editor.contains(el)) return;
    const bq = el.closest('blockquote');
    const block = el.closest('p, div, h1, h2, h3, h4, h5, h6, li');
    if (!bq || !block || !bq.contains(block)) return;

    const p = document.createElement('p');
    if (block === bq.firstElementChild && block === bq.lastElementChild) {
      bq.replaceWith(block); // 引用块只剩空行：脱离后原位保留空段落
    } else if (block === bq.lastElementChild) {
      block.remove();
      bq.after(p);
    } else {
      const rest = document.createElement('blockquote');
      while (block.nextSibling) rest.appendChild(block.nextSibling);
      block.remove();
      bq.after(p);
      p.after(rest);
    }
    // 光标落入新段落
    const r = document.createRange();
    r.setStart(p, 0);
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

    // 构造代码块 <pre class="language-xxx">（纯 pre，避免行内 code 嵌套导致的编辑异常）
    const pre = document.createElement('pre');
    if (m[1]) pre.className = 'language-' + m[1];
    applyCodeLangBadge(pre); // 右下角语言标识（``` 后的语言类型）

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
    r.setStart(pre, 0);
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
   * 判断代码块内光标所在「行」是否为空（回车应退出代码块的依据，Typora 习惯）。
   * 光标前到行首、光标后到行尾均为空白 → 空行。
   */
  function isCodeLineEmpty(pre) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;
    // 收集 pre 内所有文本节点
    const textNodes = [];
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let cur;
    while ((cur = walker.nextNode())) textNodes.push(cur);

    let before = '';
    let after = '';
    const idx = node.nodeType === 3 ? textNodes.indexOf(node) : -1;
    for (let i = 0; i < textNodes.length; i++) {
      const t = textNodes[i];
      if (idx === -1) {
        // 光标在元素位置（pre/code 本身）：按子节点顺序切分
        const children = pre.childNodes;
        for (let j = 0; j < children.length; j++) {
          const c = children[j];
          const txt = c.nodeType === 3 ? c.data : (c.textContent || '');
          if (j < offset) before += txt;
          else after += txt;
        }
        break;
      }
      if (i < idx) before += t.data;
      else if (i === idx) { before += t.data.slice(0, offset); after += t.data.slice(offset); }
      else after += t.data;
    }
    // 当前行：before 最后一个 \n 之后 / after 第一个 \n 之前
    const lb = before.lastIndexOf('\n');
    const lineBefore = before.slice(lb + 1);
    const nb = after.indexOf('\n');
    const lineAfter = nb === -1 ? after : after.slice(0, nb);
    return lineBefore.trim() === '' && lineAfter.trim() === '';
  }

  /**
   * 退出代码块：在 pre 后新建空段落并移入光标；代码块若已空则移除。
   * 空段落序列化为空，不会污染 Markdown。
   */
  function exitCodeBlock(pre, editor, id) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    pre.after(p);
    if (!pre.textContent.trim()) pre.remove();
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(p, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    syncEditorNote(editor, id);
  }

  /**
   * 代码块内回车：只插入换行，不拆分割裂代码元素。
   * 用原生 insertLineBreak（软换行命令，不触发段落拆分）—— Chromium 编辑状态一致，
   * 一次回车一个换行。pre 内若产出 <br>，preload 的 <br>→\n 提取保证序列化不丢行。
   */
  function insertCodeNewline(block, editor, id) {
    document.execCommand('insertLineBreak');
    // 原生命令已触发 input 事件，这里再同步一次（有变化才写入，重复无害）
    syncEditorNote(editor, id);
  }

  function onTaskListClick(e) {
    const target = e.target;
    const li = target.closest('.task-card');
    if (!li) return;

    // 批量选择模式：点击卡片切换选中（整卡为选择目标）
    if (batchMode) {
      toggleBatchSelect(li.dataset.id);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

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
    } else if (action === 'edit-divider-label') {
      // 分割线可选标题：空则隐藏输入框（仅 hover 显示占位），非空常显
      const v = target.value;
      const it = findItem(id);
      if (!it) return;
      target.classList.toggle('is-empty', !v.trim());
      if (v !== it.label) updateItem(id, { label: v });
    } else if (action === 'edit-note') {
      // 所见即所得编辑器：渲染后的 DOM → Markdown 保存
      syncEditorNote(actionEl, id);
      // 防抖压栈 undo 快照（连续打字归并为一步）
      scheduleUndoSnapshot(actionEl);
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

      // Enter：代码块内 —— 空行回车退出代码块（Typora 习惯），否则只插换行；
      // 行首 ```[语言] 则新建代码块
      if (e.key === 'Enter') {
        const codeBlock = caretInCodeBlock(actionEl);
        if (codeBlock) {
          e.preventDefault();
          // 关键：先还原为纯文本再执行回车。高亮 span 会让 Chromium 的
          // insertLineBreak 行为不稳定（拆出新的 <pre> 代码块）—— 与当初去掉
          // 行内 <code> 是同一个教训。strip 后保持原光标偏移。
          if (codeBlock.querySelector('span[class*="hljs-"]')) {
            const off = caretOffsetIn(codeBlock);
            stripCodeHighlight(codeBlock);
            restoreCaretTo(codeBlock, off);
          }
          if (!e.shiftKey && isCodeLineEmpty(codeBlock)) {
            exitCodeBlock(codeBlock, actionEl, id);
          } else {
            insertCodeNewline(codeBlock, actionEl, id);
          }
          return;
        }
        if (!e.shiftKey && fenceToCodeBlock(actionEl, id)) {
          e.preventDefault();
          return;
        }
        // 引用块（Tab 缩进产生 blockquote）内空行回车 → 退出引用块（Typora 习惯）
        if (!e.shiftKey && caretInEmptyBlockquote(actionEl)) {
          e.preventDefault();
          exitBlockquote(actionEl, id);
          return;
        }
        // 删除线内回车：原生行为会把 <del> 拆分延续到新行，回车完成后清理光标所在新块
        // （Shift+Enter 软换行留在同一块内，不清理）
        if (!e.shiftKey && caretInStrikethrough(actionEl)) {
          setTimeout(() => cleanupStrikethroughAfterEnter(actionEl, id), 0);
        }
      }

      // Ctrl+Z 撤销 / Ctrl+Shift+Z / Ctrl+Y 重做（自管理快照栈）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
        const isRedo = e.shiftKey || e.key === 'y';
        e.preventDefault();
        const did = isRedo ? editorRedo(actionEl) : editorUndo(actionEl);
        if (did) syncEditorNote(actionEl, id);
        return;
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
    // 打字状态追踪：mini 球处于动画模式时，任何键盘输入都驱动 gif 切换
    if (isMiniGifActive()) onEditorTyping();

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
    // Backspace：删除选中（批量模式下禁用，避免误删）
    if (e.key === 'Backspace' && !batchMode) {
      const ae = document.activeElement;
      const focusTag = ae && ae.tagName;
      const isEditing = focusTag === 'INPUT' || focusTag === 'TEXTAREA' || (ae && ae.isContentEditable);
      if (!isEditing && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    }
    // Esc：关闭确认框 / 退出批量选择 / 关闭帮助 / 搜索条
    if (e.key === 'Escape') {
      if (!confirmMask.classList.contains('hidden')) {
        pendingDeleteId = null;
        closeBatchDeleteConfirm();
      } else if (batchMode) {
        exitBatchMode();
      } else if (!helpPanel.classList.contains('hidden')) {
        toggleHelp(false);
      } else if (!searchbarEl.classList.contains('hidden')) {
        toggleSearch(false);
      }
    }
    // Ctrl+,：打开独立的设置窗口
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      toggleHelp(false);
      api.openSettings();
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
  //  主题 & 设置（设置 UI 已移至独立设置窗口 settings.html/settings.js；
  //  此处仅保留「应用」逻辑：启动加载 / settings-changed 时重新应用）
  // ============================================================

  /** 应用页面基础字号（驱动 --font-size 变量） */
  function applyFontSize(size) {
    const v = Number.isFinite(size) ? size : 13;
    settings.fontSize = v;
    document.documentElement.style.setProperty('--font-size', v + 'px');
  }

  function applyTheme(key, persist = true) {
    if (key !== 'custom' && !THEMES.find((t) => t.key === key)) key = 'amber';
    // custom 主题：按 customThemeId 从列表取项注入派生变量
    if (key === 'custom') {
      const item = (settings.customThemes || []).find((t) => t.id === settings.customThemeId);
      if (item) {
        api.applyCustomThemeVars(item);
      } else {
        key = 'amber'; // 激活项不存在（被删/损坏）→ 回退预置
      }
    }
    document.body.dataset.theme = key;
    settings.theme = key;
    if (key !== 'custom') api.clearCustomThemeVars();
    if (persist) api.saveSettings({ theme: key, ...(key !== 'custom' ? { customThemeId: null } : {}) });
  }

  /** 应用窗口材质：opaque（经典不透明）/ translucent（半透明）。
   *  亚克力（acrylic）暂时隐藏：旧配置残留时回退为半透明。
   *  经典=实心主题色；半透明=高不透明度+轻模糊。 */
  function applyMaterial(material) {
    let val = ['opaque', 'translucent'].includes(material) ? material : 'opaque';
    if (material === 'acrylic') val = 'translucent'; // 隐藏材质回退
    settings.material = val;
    document.body.dataset.material = val;
    if (api.setWindowMaterial) api.setWindowMaterial(val);
  }

  /** 应用亚克力磨砂强度（--acrylic-blur 变量，px） */
  function applyAcrylicBlur(value) {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(60, Math.round(value))) : 40;
    settings.acrylicBlur = v;
    document.documentElement.style.setProperty('--acrylic-blur', v + 'px');
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
      applyMaterial(settings.material);    // 应用窗口材质（含系统级亚克力）
      applyAcrylicBlur(settings.acrylicBlur); // 应用亚克力磨砂强度
      applyBgImage(settings.bgImage);
      applyFontSize(settings.fontSize);    // 应用页面字号（--font-size 变量）
      updateCloseButtonTitle();            // 关闭按钮提示跟随设置
      await loadGifThemes();               // 加载 GIF 动画主题列表
      if (api.setWindowSize) {
        if (settings.windowSize === 'custom' && settings.customWindowSize) {
          api.setWindowSize('custom', settings.customWindowSize); // 自定义尺寸
        } else {
          api.setWindowSize(settings.windowSize || 'default');
        }
      }
    } catch (_) {
      // 设置加载失败时保留默认外观
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

  // ===== mini 球动画模式（GIF 主题轮换 + 打字状态切换） =====
  // 主题由 settings.miniBallGif 指定（如 'remi'），从 mini-gifs/ 目录扫描发现
  // 命名规范：{主题}-{序号}.gif（闲时轮换）、{主题}-slow.gif、{主题}-fast.gif
  let miniGifThemes = [];      // 从主进程扫描的动画主题列表
  let miniGifIndex = 0;        // 当前轮换到的闲时 GIF 索引

  /** 当前是否启用 GIF 动画球（设置开启动画即可，不再绑定颜色主题） */
  function isMiniGifActive() {
    return settings.miniBallStyle === 'gif';
  }

  /** 获取当前选中主题的数据 */
  function currentGifTheme() {
    const name = settings.miniBallGif || 'remi';
    return miniGifThemes.find((t) => t.name === name) || miniGifThemes[0] || null;
  }

  /** 加载 GIF 主题列表（从主进程扫描 mini-gifs/ 目录） */
  async function loadGifThemes() {
    try {
      if (api.scanGifThemes) {
        miniGifThemes = await api.scanGifThemes();
      }
    } catch (_) {
      miniGifThemes = [];
    }
  }

  /** 进入 mini 时应用 GIF 背景（轮换取下一个；打字状态优先） */
  function applyMiniGif() {
    if (!isMiniGifActive()) {
      miniBar.classList.remove('is-gif');
      miniBar.style.backgroundImage = '';
      return;
    }
    const theme = currentGifTheme();
    if (!theme || theme.idle.length === 0) {
      miniBar.classList.remove('is-gif');
      miniBar.style.backgroundImage = '';
      return;
    }
    miniBar.classList.add('is-gif');
    if (currentTypingGif) {
      // 打字状态 gif 优先（slow 慢 / fast 快）
      miniBar.style.backgroundImage = `url(${miniGifUrl(currentTypingGif)})`;
    } else {
      const gif = theme.idle[miniGifIndex % theme.idle.length];
      miniGifIndex = (miniGifIndex + 1) % theme.idle.length;
      miniBar.style.backgroundImage = `url(${miniGifUrl(gif)})`;
    }
  }

  /** GIF 资源路径（打包后相对 app 目录；开发时相对项目根） */
  function miniGifUrl(name) {
    return './mini-gifs/' + name;
  }

  // ===== 打字状态 GIF（动画模式时，全局键盘监听触发） =====
  // 慢速打字 → {主题}-slow.gif；快速持续打字 → {主题}-fast.gif；暂停 2s → 恢复轮换 gif
  const TYPE_PAUSE_REVERT_MS = 2000;  // 暂停 2 秒后恢复
  const TYPE_FAST_INTERVAL = 250;     // 按键间隔 < 250ms 算快
  const TYPE_SLOW_INTERVAL = 450;    // 按键间隔 > 450ms 算慢
  const TYPE_SUSTAINED_MS = 1500;   // 快速持续 > 1.5 秒才切 fast
  const TYPE_WINDOW_SIZE = 15;       // 滑动窗口：最近 15 次按键

  let typeKeystrokes = [];      // 最近的按键时间戳
  let typingGifTimer = null;    // 暂停恢复定时器
  let currentTypingGif = null;  // 当前打字状态 gif（null = 正常轮换）

  /** 判断当前焦点是否在编辑器/标题输入框内 */
  function isTypingInEditor() {
    const ae = document.activeElement;
    if (!ae) return false;
    return ae.classList.contains('card-editor') || ae.classList.contains('card-title');
  }

  /** 编辑器按键时调用：追踪打字速度并切换 gif */
  function onEditorTyping() {
    if (!isMiniGifActive()) return; // 非 gif 模式不追踪
    const theme = currentGifTheme();
    if (!theme) return;
    const now = Date.now();
    typeKeystrokes.push(now);
    if (typeKeystrokes.length > TYPE_WINDOW_SIZE) typeKeystrokes.shift();

    clearTimeout(typingGifTimer);

    // 需要至少 3 次按键才能判断速度
    if (typeKeystrokes.length >= 3) {
      const span = typeKeystrokes[typeKeystrokes.length - 1] - typeKeystrokes[0];
      const avgInterval = span / (typeKeystrokes.length - 1);

      if (avgInterval < TYPE_FAST_INTERVAL && span > TYPE_SUSTAINED_MS) {
        // 快速且持续 → fast gif
        if (theme.fast) setTypingGif(theme.fast);
      } else if (avgInterval > TYPE_SLOW_INTERVAL) {
        // 慢速 → slow gif
        if (theme.slow) setTypingGif(theme.slow);
      }
      // 介于之间 → 保持当前 gif
    }

    // 暂停 2 秒后恢复
    typingGifTimer = setTimeout(revertTypingGif, TYPE_PAUSE_REVERT_MS);
  }

  /** 设置打字状态 gif（避免重复设置） */
  function setTypingGif(gif) {
    if (currentTypingGif === gif) return;
    currentTypingGif = gif;
    // mini 球可见时立即更新背景
    if (isMiniGifActive() && !miniBar.classList.contains('hidden')) {
      miniBar.style.backgroundImage = `url(${miniGifUrl(gif)})`;
    }
  }

  /** 暂停后恢复到正常轮换 gif */
  function revertTypingGif() {
    currentTypingGif = null;
    typeKeystrokes = [];
    if (isMiniGifActive() && !miniBar.classList.contains('hidden')) {
      const theme = currentGifTheme();
      if (theme && theme.idle.length > 0) {
        const gif = theme.idle[miniGifIndex % theme.idle.length];
        miniGifIndex = (miniGifIndex + 1) % theme.idle.length;
        miniBar.style.backgroundImage = `url(${miniGifUrl(gif)})`;
      }
    }
  }

  const MINI_ANIM_MS = 190; // 与主进程窗口缩放动画（180ms）同步，略留余量

  function enterMiniMode() {
    isMiniMode = true;
    const userMaterial = document.body.dataset.material || 'opaque';
    // 收起动画期间强制经典材质：避免半透明/亚克力样式在收缩过程中闪现
    document.body.dataset.material = 'opaque';
    // 1) 收起动画：内容向右上角收缩 + 淡出（与窗口缩小动画同步）
    appEl.classList.remove('is-collapsing', 'is-collapsing-to');
    // 强制 reflow 确保 transition 从当前状态开始
    void appEl.offsetWidth;
    appEl.classList.add('is-collapsing');
    void appEl.offsetWidth;
    appEl.classList.add('is-collapsing-to');
    // 2) 动画结束后才真正进入 mini 态（隐藏 .app，显示 miniBar）
    clearTimeout(enterMiniTimer);
    enterMiniTimer = setTimeout(() => {
      document.body.classList.add('is-mini');
      appEl.classList.remove('is-collapsing', 'is-collapsing-to');
      updateMiniCount();
      miniBar.classList.remove('hidden');
      // 应用 GIF 动画球背景（若开启且主题为蕾米埃尔系），否则经典样式
      applyMiniGif();
      // 恢复用户材质（mini 态 .app 已隐藏，仅记录待展开时使用）
      document.body.dataset.material = userMaterial;
      // 鼠标穿透：默认让球外透明区域点击穿透到下层软件；移入球时恢复捕获
      miniMouseIgnoring = true;
      if (api.setIgnoreMouse) api.setIgnoreMouse(true);
    }, MINI_ANIM_MS);
  }

  function exitMiniMode(edge) {
    isMiniMode = false;
    clearTimeout(enterMiniTimer);
    // 退出 mini：恢复鼠标正常捕获
    if (miniMouseIgnoring && api.setIgnoreMouse) api.setIgnoreMouse(false);
    miniMouseIgnoring = false;
    const userMaterial = document.body.dataset.material || 'opaque';
    // 展开动画期间强制经典材质：主页以实心样式放大，避免半透明闪现。
    // 必须先切换材质再恢复 .app 显示（remove is-mini），否则 .app 恢复显示的第一帧
    // 仍带着用户材质（半透明/背景图）渲染，造成闪一下。
    document.body.dataset.material = 'opaque';
    document.body.classList.remove('is-mini');
    miniBar.classList.add('hidden');
    // 展开原点：从贴近 mini 球的角释放（边缘方向决定）
    //   左边缘 → 左下角；右边缘 → 右下角；上边缘 → 左上角；下边缘 → 左下角
    let origin = 'left bottom';
    if (edge === 'right') origin = 'right bottom';
    else if (edge === 'left') origin = 'left bottom';
    else if (edge === 'top') origin = 'left top';
    else if (edge === 'bottom') origin = 'left bottom';
    appEl.style.setProperty('--expand-origin', origin);
    appEl.classList.remove('is-expanding', 'is-expanding-to');
    void appEl.offsetWidth;
    appEl.classList.add('is-expanding');
    void appEl.offsetWidth;
    appEl.classList.add('is-expanding-to');
    // 2) 动画结束后清理过渡类，恢复用户材质（CSS + 系统材质）
    clearTimeout(exitMiniTimer);
    exitMiniTimer = setTimeout(() => {
      appEl.classList.remove('is-expanding', 'is-expanding-to');
      appEl.style.removeProperty('--expand-origin');
      document.body.dataset.material = userMaterial;
      if (api.setWindowMaterial) api.setWindowMaterial(userMaterial);
    }, 220);
  }

  /** 关闭按钮悬浮提示跟随设置：缩为 mini 球 / 关闭软件 */
  function updateCloseButtonTitle() {
    closeBtn.title = settings.closeAction === 'quit' ? '关闭软件' : '缩为 mini 球';
  }

  function initWindowControls() {
    // 最小化按钮：同样进入 mini 态（缩为屏幕边缘 mini 球），保留任务栏常驻
    minBtn.addEventListener('click', () => api.enterMini());
    shrinkBtn.addEventListener('click', () => api.enterMini());
    // 关闭按钮：按设置执行 —— 「关闭软件」直接退出；「缩小到托盘」进入 mini 球态
    closeBtn.addEventListener('click', () => {
      if (settings.closeAction === 'quit') {
        api.quit(); // 退出软件
      } else {
        api.enterMini(); // 主页面收起，屏幕边缘弹出 mini 球
      }
    });
    pinBtn.addEventListener('click', () => api.togglePin());

    btnAdd.addEventListener('click', () => addTask());
    btnAddEmpty.addEventListener('click', () => addTask());
    btnDivider.addEventListener('click', () => addDivider());
    btnDelete.addEventListener('click', () => {
      // 进入/退出批量选择模式
      if (batchMode) exitBatchMode();
      else enterBatchMode();
    });

    // 批量删除：右下角浮动按钮（未选择时禁用）→ 二次确认
    btnBatchDelete.addEventListener('click', () => {
      if (batchSelected.size === 0) return;
      openBatchDeleteConfirm();
    });
    btnConfirmOk.addEventListener('click', () => {
      // 单条删除（Backspace）与批量删除共用确认弹窗
      if (pendingDeleteId) {
        const id = pendingDeleteId;
        pendingDeleteId = null;
        closeBatchDeleteConfirm();
        deleteItem(id);
        selectedId = null;
      } else {
        doBatchDelete();
      }
    });
    btnConfirmCancel.addEventListener('click', () => {
      pendingDeleteId = null;
      closeBatchDeleteConfirm();
    });
    confirmMask.addEventListener('click', (e) => {
      if (e.target === confirmMask) {
        pendingDeleteId = null;
        closeBatchDeleteConfirm();
      }
    });
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

    // 设置：打开独立设置窗口
    btnSettings.addEventListener('click', () => {
      toggleHelp(false);
      api.openSettings();
    });

    // Mini bar: 用 JS 区分点击 vs 拖动(原生 drag region 已移除)
    // 方案: pointer events + screen 坐标 + pointer capture
    //   - 点击(位移<5px 且按下<250ms)或双击 → 退出 mini 态展开窗口
    //   - 拖动 → 跟随鼠标移动 mini 条位置
    let miniDownStart = null;       // { screenX, screenY, lastScreenX, lastScreenY, time }
    let miniIsDragging = false;
    const CLICK_DIST_THRESHOLD = 5;
    const CLICK_TIME_THRESHOLD = 250;

    // mini 态鼠标穿透：窗口透明矩形会拦截球外点击。
    // 默认 setIgnoreMouse(true,{forward:true}) 让球外区域穿透；
    // 借助 forward 仍会收到的 mousemove，检测鼠标是否在球范围内 → 移入恢复捕获。
    let miniIgnoreHover = false; // 当前鼠标是否在球上
    function updateMiniMouseIgnore(e) {
      if (!isMiniMode) return;
      const r = miniBar.getBoundingClientRect();
      // 球是圆形，用中心距判断（含 hover 放大到 56px 的范围）
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const radius = r.width / 2;
      const inside = Math.hypot(e.clientX - cx, e.clientY - cy) <= radius;
      if (inside !== miniIgnoreHover) {
        miniIgnoreHover = inside;
        if (api.setIgnoreMouse) api.setIgnoreMouse(!inside); // 移入球 → 捕获；移出 → 穿透
      }
    }
    document.addEventListener('mousemove', updateMiniMouseIgnore);

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
        // 单击展开主页面（双击无特殊效果，直接展开）
        api.exitMini();
      }
    });

    miniBar.addEventListener('pointercancel', () => {
      miniBar.classList.remove('is-dragging');
      miniDownStart = null;
      miniIsDragging = false;
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
   * 粘贴处理：
   * - 剪贴板含图片（微信/QQ/系统截图等）→ 以 <img dataURL> 插入编辑区，
   *   序列化时 turndown 转回 ![alt](data:...) 存入笔记；
   * - 否则插入纯文本，避免网页富文本产生脏 DOM。
   */
  function onTaskListPaste(e) {
    const target = e.target;
    const editor = target.closest && target.closest('[data-action="edit-note"]');
    if (!editor) return;
    const li = target.closest('.task-card');
    const id = li && li.dataset.id;
    e.preventDefault();

    const items = e.clipboardData && e.clipboardData.items;
    let hasImage = false;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type && item.type.startsWith('image/')) {
          hasImage = true;
          const file = item.getAsFile && item.getAsFile();
          if (file) {
            readFileAsDataURL(file).then((dataURL) => {
              insertImageAtCaret(dataURL);
              syncEditorNote(editor, id);
            }).catch(() => {});
          }
        }
      }
    }
    if (!hasImage) {
      const text = e.clipboardData.getData('text/plain');
      insertTextAtCaret(editor, text, id);
    }
  }

  /**
   * 在光标处插入纯文本（替代 execCommand('insertText')）。
   * 不用原生命令的原因：
   *  - Chromium 的 insertText 会把多行文本中的空行（\n\n）拆成多个块级元素，
   *    粘贴代码会被打散成多个独立块，观感像"散成多个代码块"；
   *  - 在代码块（pre）内，insertText 也会破坏高亮 span 结构。
   * 自定义行为：
   *  - 光标在 pre 内 → 插入含 \n 的文本节点（pre 的 white-space 保留换行，仍是单个代码块）；
   *  - 光标在普通文本 → 行间用 <br> 软换行，不产生新块（turndown <br>→\n 往返无损）。
   */
  function insertTextAtCaret(editor, text, id) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const startNode = range.startContainer;
    // 光标所在代码块（若在 pre 内）
    const pre = startNode.nodeType === 1
      ? (startNode.closest && startNode.closest('pre'))
      : (startNode.parentElement && startNode.parentElement.closest('pre'));
    // pre 内若还是高亮 span（如通过 Tab/程序聚焦），先还原纯文本并恢复光标
    if (pre && pre.querySelector('span[class*="hljs-"]')) {
      const off = caretOffsetIn(pre);
      stripCodeHighlight(pre);
      restoreCaretTo(pre, off);
    }

    range.deleteContents();
    const frag = document.createDocumentFragment();
    if (pre) {
      // 代码块内：整段作为一个文本节点插入（含换行），保持单个 pre
      frag.appendChild(document.createTextNode(String(text)));
    } else {
      const lines = String(text).split('\n');
      lines.forEach((line, i) => {
        if (i > 0) frag.appendChild(document.createElement('br'));
        frag.appendChild(document.createTextNode(line));
      });
    }
    const last = frag.lastChild;
    range.insertNode(frag);
    // 光标移到插入内容末尾
    if (last) {
      const r = document.createRange();
      r.setStartAfter(last);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    syncEditorNote(editor, id);
  }

  /** 读取文件为 dataURL */
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /** 在光标处插入图片元素（所见即所得），光标移到图片后 */
  function insertImageAtCaret(src) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    range.insertNode(img);
    const r = document.createRange();
    r.setStartAfter(img);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function init() {
    // 事件委托
    taskListEl.addEventListener('click', onTaskListClick);
    taskListEl.addEventListener('input', onTaskListInput);
    taskListEl.addEventListener('keydown', onTaskListKeyDown);
    // 拖动排序（把手 mousedown 临时武装 draggable → dragstart/over/drop 重排）
    taskListEl.addEventListener('mousedown', onTaskListMouseDown);
    taskListEl.addEventListener('mouseup', onTaskListMouseUp);
    taskListEl.addEventListener('dragstart', onTaskListDragStart);
    taskListEl.addEventListener('dragover', onTaskListDragOver);
    taskListEl.addEventListener('dragleave', onTaskListDragLeave);
    taskListEl.addEventListener('drop', onTaskListDrop);
    taskListEl.addEventListener('dragend', onTaskListDragEnd);
    taskListEl.addEventListener('paste', onTaskListPaste);
    // 代码块高亮：进入编辑还原纯文本，失焦重新高亮
    taskListEl.addEventListener('focusin', onEditorFocusIn);
    taskListEl.addEventListener('focusout', onEditorFocusOut);
    document.addEventListener('keydown', onGlobalKeyDown);

    // 点击卡片外任意处 → 取消待办标题的选中效果（批量模式下不干扰多选）
    document.addEventListener('click', (e) => {
      if (batchMode) return;
      if (selectedId && !(e.target.closest && e.target.closest('.task-card'))) {
        selectedId = null;
        updateSelection();
      }
    });

    initWindowControls();
    initPinState();

    // mini 态事件（主进程贴边/恢复时通知；edge 用于展开动画方向）
    if (api.onSnapStateChanged) {
      api.onSnapStateChanged((mini, edge) => {
        if (mini) enterMiniMode(); else exitMiniMode(edge);
      });
    }

    // 全局键盘活动（mini 态下主进程 PowerShell 监听 → 打字 gif 切换）
    if (api.onTypingActivity) {
      api.onTypingActivity(() => onEditorTyping());
    }

    // 先加载主题设置，再加载笔记（避免主题闪烁）
    loadSettingsState().finally(() => {
      loadInitial();
    });

    // 设置窗口修改设置后（主题/字号/背景/快捷键）→ 主窗口即时重新应用
    if (api.onSettingsChanged) {
      api.onSettingsChanged(() => loadSettingsState());
    }

    // 数据存储位置变更后 → 主窗口重新加载笔记与设置
    if (api.onStorageChanged) {
      api.onStorageChanged(() => {
        loadSettingsState().finally(() => {
          loadInitial();
        });
      });
    }

    // 上报 CSS 视口尺寸（innerWidth/innerHeight）给主进程：
    // 设置窗口的自定义尺寸弹窗用它在主窗口调整大小时实时同步数值。
    function reportViewportSize() {
      if (!api.reportWindowSize) return;
      api.reportWindowSize({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener('resize', reportViewportSize);
    // 初始上报一次（等布局稳定）
    setTimeout(reportViewportSize, 300);

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
