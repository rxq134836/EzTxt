'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');

// 配置 marked：开启 GFM（含任务列表复选框）+ breaks（换行即 <br>）
marked.setOptions({
  gfm: true,
  breaks: true
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

  // 窗口控制
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  togglePin: () => ipcRenderer.send('window-toggle-pin'),
  getPinState: () => ipcRenderer.invoke('window-get-pin-state'),

  // Mini 小条控制
  enterMini: () => ipcRenderer.send('enter-mini'),
  exitMini: () => ipcRenderer.send('exit-mini'),

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
