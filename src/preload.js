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
// 裸 <pre>（编辑器 Ctrl+Shift+K 产生的，无 <code> 子元素）→ ``` 围栏代码块
turndownService.addRule('pre', {
  filter: (node) => node.nodeName === 'PRE' && !(node.firstChild && node.firstChild.nodeName === 'CODE'),
  replacement: (content, node) => {
    const code = node.textContent.replace(/\n$/, '');
    return '\n\n```\n' + code + '\n```\n\n';
  }
});

contextBridge.exposeInMainWorld('api', {
  // 笔记数据
  loadNote: () => ipcRenderer.invoke('load-note'),
  saveNote: (note) => ipcRenderer.invoke('save-note', note),

  // 设置（主题、背景图）
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),

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
