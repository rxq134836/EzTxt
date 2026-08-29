'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const TurndownService = require('turndown');

// 配置 marked：开启 GFM（含任务列表复选框）+ breaks（换行即 <br>）
marked.setOptions({
  gfm: true,
  breaks: true
});

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
turndownService.addRule('br', {
  filter: 'br',
  replacement: () => '\n'
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

  // 所见即所得编辑器：contenteditable 的 innerHTML → Markdown（turndown）
  htmlToMarkdown: (html) => turndownService.turndown(html == null ? '' : String(html)),

  // 窗口控制
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  togglePin: () => ipcRenderer.send('window-toggle-pin'),
  getPinState: () => ipcRenderer.invoke('window-get-pin-state'),

  // Mini 小条控制
  enterMini: () => ipcRenderer.send('enter-mini'),
  exitMini: () => ipcRenderer.send('exit-mini'),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),

  // 置顶状态变更通知
  onPinToggled: (callback) => {
    const listener = (_event, isPinned) => callback(isPinned);
    ipcRenderer.on('pin-toggled', listener);
    return () => ipcRenderer.removeListener('pin-toggled', listener);
  },

  // Mini 贴边态状态变更通知
  onSnapStateChanged: (callback) => {
    const listener = (_event, isMini) => callback(isMini);
    ipcRenderer.on('snap-state-changed', listener);
    return () => ipcRenderer.removeListener('snap-state-changed', listener);
  }
});
