'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const TurndownService = require('turndown');
const hljs = require('highlight.js');

// 配置 marked：开启 GFM（含任务列表复选框）+ breaks（换行即 <br>）
marked.setOptions({
  gfm: true,
  breaks: true
});

// ===== 代码高亮（highlight.js）=====
// Vue 单文件组件没有内置语言，注册一个自定义定义：
// template → xml 高亮、<script> → javascript、<style> → css/scss/stylus
hljs.registerLanguage('vue', function (hljs_) {
  return {
    subLanguage: 'xml',
    contains: [
      hljs_.COMMENT('<!--', '-->', { relevance: 10 }),
      {
        begin: /^(\s*)(<script(\s[^>]*)?>)/gm,
        end: /^(\s*)(<\/script>)/gm,
        subLanguage: 'javascript',
        excludeBegin: true,
        excludeEnd: true
      },
      {
        begin: /^(\s*)(<style(\s[^>]*)?>)/gm,
        end: /^(\s*)(<\/style>)/gm,
        subLanguage: 'css',
        excludeBegin: true,
        excludeEnd: true
      }
    ]
  };
});

// 语言别名：用户常用简称 → highlight.js 语言名
const LANG_ALIASES = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  sh: 'bash', shell: 'bash', zsh: 'bash', py: 'python',
  cs: 'csharp', 'c#': 'csharp', 'csharp': 'csharp', 'vb': 'vbnet', 'vbnet': 'vbnet',
  '.net': 'csharp', 'net': 'csharp', 'vue': 'vue', 'vuejs': 'vue',
  html: 'xml', htm: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown',
  txt: 'plaintext', text: 'plaintext', plain: 'plaintext'
};

/** 把用户写的语言名规范化成 highlight.js 可用语言名（找不到返回 null） */
function resolveHighlightLang(lang) {
  if (!lang) return null;
  const key = String(lang).trim().toLowerCase();
  if (LANG_ALIASES[key]) return hljs.getLanguage(LANG_ALIASES[key]) ? LANG_ALIASES[key] : null;
  return hljs.getLanguage(key) ? key : null;
}

/** 高亮代码文本，返回含 <span class="hljs-*"> 的 HTML；语言无效或高亮失败时返回转义文本 */
function highlightCode(code, lang) {
  const text = code == null ? '' : String(code);
  const resolved = resolveHighlightLang(lang);
  if (!resolved) return escapeHtmlForPre(text);
  try {
    const result = hljs.highlight(text, { language: resolved, ignoreIllegals: true });
    return result.value;
  } catch (_) {
    return escapeHtmlForPre(text);
  }
}

/** 代码块内文本转义（< > & 需转义，否则会被当 HTML 解析破坏结构） */
function escapeHtmlForPre(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 所见即所得编辑器：contenteditable DOM → Markdown（turndown）
// 自定义规则保证 marked → turndown 往返无损：
//   - <br>（breaks:true 产生）→ 单个 \n（默认会变 \n\n 破坏软换行）
//   - 列表前缀单空格（本 fork 硬编码 3/2 空格）
//   - GFM 任务列表复选框 → [ ] / [x]
const turndownService = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined'
});
// 软换行：<br> → \n；若前一个兄弟节点也是 <br>（连续空行，如粘贴多行文本），
// 输出 \n\n 保留空行（turndown 默认会把相邻 br 折叠成单个换行，丢失空行）
turndownService.addRule('br', {
  filter: 'br',
  replacement: (content, node) => {
    let prev = node.previousSibling;
    while (prev && prev.nodeType === 3 && !prev.data) prev = prev.previousSibling; // 跳过空白文本
    const isDouble = prev && prev.nodeName === 'BR';
    return isDouble ? '\n\n' : '\n';
  }
});
turndownService.addRule('taskListCheckbox', {
  filter: (node) => node.nodeName === 'INPUT' && node.type === 'checkbox',
  replacement: (content, node) => (node.checked ? '[x]' : '[ ]')
});
// 删除线：<del>/<s> → ~~text~~（marked 渲染 ~~ ~~ 得到 <del>，此处反向还原，往返无损）
turndownService.addRule('strikethrough', {
  filter: (node) => node.nodeName === 'DEL' || node.nodeName === 'S',
  replacement: (content) => {
    const text = String(content).trim();
    return '~~' + text + '~~';
  }
});
turndownService.addRule('listItem', {
  filter: 'li',
  replacement: (content, node, options) => {
    let prefix = options.bulletListMarker + ' ';
    const parent = node.parentNode;
    if (parent.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const index = Array.prototype.indexOf.call(parent.children, node);
      prefix = (start ? Number(start) + index : index + 1) + '. ';
    }
    const isParagraph = /\n$/.test(content);
    content = content.replace(/^\n+/, '').replace(/\n+$/, '') + (isParagraph ? '\n' : '');
    content = content.replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
    return prefix + content + (node.nextSibling ? '\n' : '');
  }
});
// 代码块文本提取：文本节点原样、<br> 视为换行（编辑器可能产出 <br>）
function codeBlockText(node) {
  let s = '';
  const children = node.childNodes || [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 3) s += child.data;
    else if (child.nodeName === 'BR') s += '\n';
    else s += codeBlockText(child);
  }
  return s;
}

// 覆盖默认 fencedCodeBlock 规则：用 <br> 感知的提取替代 textContent（textContent 会丢掉 <br> 换行）
turndownService.addRule('fencedCodeBlock', {
  filter: (node) => node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE',
  replacement: (content, node) => {
    const codeEl = node.firstChild;
    const className = codeEl.getAttribute('class') || '';
    const language = (className.match(/language-(\S+)/) || [null, ''])[1];
    const code = codeBlockText(codeEl).replace(/\n$/, '');
    const fenceChar = '`';
    let fenceSize = 3;
    const fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');
    let match;
    while ((match = fenceInCodeRegex.exec(code))) {
      if (match[0].length >= fenceSize) fenceSize = match[0].length + 1;
    }
    const fence = fenceChar.repeat(fenceSize);
    return '\n\n' + fence + language + '\n' + code + '\n' + fence + '\n\n';
  }
});

// 裸 <pre>（编辑器内的代码块均为纯 pre，语言写在 pre 的 class 上）→ ``` 围栏代码块
turndownService.addRule('pre', {
  filter: (node) => node.nodeName === 'PRE' && !(node.firstChild && node.firstChild.nodeName === 'CODE'),
  replacement: (content, node) => {
    const className = node.getAttribute('class') || '';
    const language = (className.match(/language-(\S+)/) || [null, ''])[1];
    const code = codeBlockText(node).replace(/\n$/, '');
    const fenceChar = '`';
    let fenceSize = 3;
    const fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');
    let match;
    while ((match = fenceInCodeRegex.exec(code))) {
      if (match[0].length >= fenceSize) fenceSize = match[0].length + 1;
    }
    const fence = fenceChar.repeat(fenceSize);
    return '\n\n' + fence + language + '\n' + code + '\n' + fence + '\n\n';
  }
});

// ===== 自定义主题（3 色 + 明暗 → 完整 CSS 变量，主窗口/设置窗口/编辑器共用） =====
// 自定义主题可注入的全部 CSS 变量 key（切回预置主题时按此列表清除内联覆盖）
const CUSTOM_THEME_VARS = [
  'bg', 'bg-solid', 'bg-rgb',
  'accent', 'accent-rgb',
  'ink', 'ink-rgb',
  'ink-soft', 'ink-mute',
  'line', 'line-soft',
  'accent-soft',
  'card-bg', 'card-bg-hover', 'hover-bg',
  'surface', 'surface-strong'
];

function hexToRgbArr(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 颜色混合：t = A 的占比（0~1），返回 rgb 数组
function mixRgb(hexA, hexB, t) {
  const a = hexToRgbArr(hexA);
  const b = hexToRgbArr(hexB);
  if (!a || !b) return null;
  return a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
}

/**
 * 由 {accent, bg, ink, dark} 派生自定义主题的完整 CSS 变量对象。
 * 派生规则与 11 套预置主题一致：
 *  - 次级/弱化文字 = ink 与 bg 按 73%/40% 混合
 *  - 线色 = ink 低透明度；强调浅底 = accent 低透明度
 *  - 表面色（卡片）按明暗两套透明度
 * 非法/缺失输入回退到琥珀默认值。
 */
function deriveCustomTheme(theme) {
  const t = theme || {};
  const ok6 = (v) => hexToRgbArr(v) !== null;
  const accent = ok6(t.accent) ? String(t.accent).trim() : '#e0a82e';
  const bg = ok6(t.bg) ? String(t.bg).trim() : '#FAF5E1';
  const ink = ok6(t.ink) ? String(t.ink).trim() : '#4a3f24';
  const dark = !!t.dark;
  const accentRgb = hexToRgbArr(accent).join(', ');
  const inkRgb = hexToRgbArr(ink).join(', ');
  const bgRgb = hexToRgbArr(bg).join(', ');
  const soft = mixRgb(ink, bg, 0.73).join(', ');
  const mute = mixRgb(ink, bg, 0.4).join(', ');
  return {
    // --bg 带透明度（浅色 0.86 / 暗色 0.92，与预置主题一致）
    'bg': 'rgba(' + bgRgb + ', ' + (dark ? '0.92' : '0.86') + ')',
    'bg-solid': bg,
    'bg-rgb': bgRgb,
    'accent': accent,
    'accent-rgb': accentRgb,
    'ink': ink,
    'ink-rgb': inkRgb,
    'ink-soft': 'rgb(' + soft + ')',
    'ink-mute': 'rgb(' + mute + ')',
    'line': 'rgba(' + inkRgb + ', 0.12)',
    'line-soft': 'rgba(' + inkRgb + ', 0.06)',
    'accent-soft': 'rgba(' + accentRgb + ', 0.18)',
    // 卡片/悬停表面：浅色白透明 / 暗色微光变体（与 night 主题一致）
    'card-bg': dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.55)',
    'card-bg-hover': dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.8)',
    'hover-bg': dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.7)',
    'surface': dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.75)',
    'surface-strong': dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.9)'
  };
}

contextBridge.exposeInMainWorld('api', {
  // 笔记数据
  loadNote: () => ipcRenderer.invoke('load-note'),
  saveNote: (note) => ipcRenderer.invoke('save-note', note),

  // 设置（主题、材质、背景图、字号、快捷键）
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),

  // 窗口材质（半透明 / 亚克力）—— 系统级亚克力（Windows 11 22H2+）
  setWindowMaterial: (material) => ipcRenderer.send('set-window-material', material),

  // 自动更新（GitHub Releases）
  checkUpdate: (notifyUpToDate) => ipcRenderer.invoke('update-check', notifyUpToDate),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },

  // 主窗口尺寸预设（设置页「外观 → 窗口比例」；key='custom' 时带 size 宽高）
  setWindowSize: (key, size) => ipcRenderer.send('set-window-size', key, size),
  // 查询主窗口当前尺寸（自定义尺寸弹窗用）
  getWindowSize: () => ipcRenderer.invoke('get-window-size'),
  // 主窗口渲染层上报 CSS 视口尺寸（innerWidth/innerHeight）
  reportWindowSize: (size) => ipcRenderer.send('report-window-size', size),
  // 主窗口尺寸变化通知（自定义尺寸弹窗实时同步）
  onWindowResized: (callback) => {
    const listener = (_event, size) => callback(size);
    ipcRenderer.on('window-resized', listener);
    return () => ipcRenderer.removeListener('window-resized', listener);
  },

  // 打开独立的设置窗口
  openSettings: () => ipcRenderer.send('open-settings'),
  // 打开自定义主题编辑器窗口（editId 空=新建；传 id=编辑已有主题）
  openCustomTheme: (editId) => ipcRenderer.send('open-custom-theme', editId || null),

  // ===== 自定义主题 =====
  // 由 {accent, bg, ink, dark} 派生完整 CSS 变量对象（key 不带 -- 前缀）
  deriveCustomTheme: (theme) => deriveCustomTheme(theme),
  // 自定义主题占用的 CSS 变量 key 列表（切回预置主题时用于清除内联覆盖）
  customThemeVarKeys: CUSTOM_THEME_VARS,
  // 把派生变量注入指定元素（elem 缺省为 body）；返回注入的变量对象
  applyCustomThemeVars: (theme, elem) => {
    const vars = deriveCustomTheme(theme);
    const target = elem || document.body;
    for (const [k, v] of Object.entries(vars)) target.style.setProperty('--' + k, v);
    return vars;
  },
  // 清除注入的自定义主题变量（恢复当前 data-theme 预置值）
  clearCustomThemeVars: (elem) => {
    const target = elem || document.body;
    for (const k of CUSTOM_THEME_VARS) target.style.removeProperty('--' + k);
  },
  // 设置被修改时（主进程广播，主窗口即时重新加载应用）
  onSettingsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('settings-changed', listener);
    return () => ipcRenderer.removeListener('settings-changed', listener);
  },

  // 数据保存位置
  getStorageInfo: () => ipcRenderer.invoke('storage-get-info'),
  chooseStorageDir: () => ipcRenderer.invoke('storage-choose-dir'),
  setStorageDir: (dir) => ipcRenderer.invoke('storage-set-dir', dir),
  openStorageDir: () => ipcRenderer.invoke('storage-open-dir'),
  // 数据存储位置变更时（主窗口重载笔记/设置）
  onStorageChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('storage-changed', listener);
    return () => ipcRenderer.removeListener('storage-changed', listener);
  },

  // Markdown 渲染（在 preload 中执行，避免渲染进程直接持有 marked）
  renderMarkdown: (text) => marked.parse(text == null ? '' : String(text)),

  // 代码高亮：返回含 <span class="hljs-*"> 的 HTML（语言无效则返回转义文本）
  highlightCode: (code, lang) => highlightCode(code, lang),

  // 所见即所得编辑器：contenteditable 的 innerHTML → Markdown（turndown）
  htmlToMarkdown: (html) => turndownService.turndown(html == null ? '' : String(html)),

  // 窗口控制
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  quit: () => ipcRenderer.send('window-quit'),
  togglePin: () => ipcRenderer.send('window-toggle-pin'),
  getPinState: () => ipcRenderer.invoke('window-get-pin-state'),

  // Mini 小条控制
  enterMini: () => ipcRenderer.send('enter-mini'),
  exitMini: () => ipcRenderer.send('exit-mini'),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),
  // mini 态鼠标穿透（true=球外区域点击穿透到下层软件，false=正常捕获）
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),

  // 置顶状态变更通知
  onPinToggled: (callback) => {
    const listener = (_event, isPinned) => callback(isPinned);
    ipcRenderer.on('pin-toggled', listener);
    return () => ipcRenderer.removeListener('pin-toggled', listener);
  },

  // Mini 贴边态状态变更通知（edge: 'left'|'right'|'top'|'bottom'|null，用于展开动画方向）
  onSnapStateChanged: (callback) => {
    const listener = (_event, isMini, edge) => callback(isMini, edge);
    ipcRenderer.on('snap-state-changed', listener);
    return () => ipcRenderer.removeListener('snap-state-changed', listener);
  },

  // 全局键盘活动通知（mini 态下 PowerShell 监听检测到按键 → 触发打字 gif 切换）
  onTypingActivity: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('typing-activity', listener);
    return () => ipcRenderer.removeListener('typing-activity', listener);
  }
});
