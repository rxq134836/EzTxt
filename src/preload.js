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

contextBridge.exposeInMainWorld('api', {
  // 笔记数据
  loadNote: () => ipcRenderer.invoke('load-note'),
  saveNote: (note) => ipcRenderer.invoke('save-note', note),

  // 设置（主题、材质、背景图、字号、快捷键）
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),

  // 窗口材质（半透明 / 亚克力）—— 系统级亚克力（Windows 11 22H2+）
  setWindowMaterial: (material) => ipcRenderer.send('set-window-material', material),

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
  }
});
