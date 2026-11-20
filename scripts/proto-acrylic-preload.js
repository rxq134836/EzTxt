'use strict';
// 原型专用 preload：暴露最小 API
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('proto', {
  setMaterial: (m) => ipcRenderer.send('proto-material', m),
  close: () => ipcRenderer.send('proto-close')
});
