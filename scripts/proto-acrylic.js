'use strict';
// 独立原型：验证非透明窗口 + Windows 系统材质（acrylic/mica）能否真实模糊桌面。
// 不依赖主程序任何代码，关闭窗口即退出。

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win = null;

function createProto() {
  win = new BrowserWindow({
    width: 520,
    height: 360,
    frame: false,
    transparent: false, // 关键：系统材质必须用非透明窗口
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic', // 关键：Windows 11 22H2+ 系统亚克力
    resizable: true,
    alwaysOnTop: true,
    title: 'EzTxt 亚克力原型验证',
    webPreferences: {
      preload: path.join(__dirname, 'proto-acrylic-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getHtml()));

  win.on('closed', () => { win = null; });
}

function getHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* 关键：页面背景必须透明，系统材质才能透出来 */
  html, body { background: transparent; height: 100%; font-family: "Microsoft YaHei", sans-serif; user-select: none; }
  #app {
    height: 100%;
    display: flex; flex-direction: column;
    border-radius: 12px;
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.28);
    overflow: hidden;
  }
  #titlebar {
    -webkit-app-region: drag;
    height: 44px; flex: 0 0 44px;
    display: flex; align-items: center; padding: 0 14px;
    color: #fff; font-size: 13px;
    background: rgba(0,0,0,0.18);
  }
  #titlebar .x {
    -webkit-app-region: no-drag;
    margin-left: auto; width: 30px; height: 30px;
    border: none; background: rgba(255,255,255,0.14); color: #fff;
    border-radius: 6px; cursor: pointer; font-size: 15px;
  }
  #body { flex: 1; padding: 18px; color: #fff; display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 17px; font-weight: 600; }
  p { font-size: 12.5px; line-height: 1.7; opacity: 0.92; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    -webkit-app-region: no-drag;
    padding: 7px 14px; border: 1px solid rgba(255,255,255,0.35);
    background: rgba(255,255,255,0.14); color: #fff;
    border-radius: 7px; cursor: pointer; font-size: 12.5px;
  }
  button:hover { background: rgba(255,255,255,0.26); }
  #cur { font-size: 12px; opacity: 0.8; }
</style>
</head>
<body>
<div id="app">
  <div id="titlebar">EzTxt 亚克力原型验证（可拖动）<button class="x" onclick="closeWin()">✕</button></div>
  <div id="body">
    <h1>把本窗口移到有图标/文字的桌面上看效果</h1>
    <p>如果「桌面模糊」成立：窗口背后能看到桌面图标被虚化，而不是直接透出清晰图标，也不是一块纯色。</p>
    <p>注意：亚克力在窗口<b>失焦</b>时会自动退化为纯色是系统行为，聚焦窗口再判断。</p>
    <div class="row">
      <button onclick="setMat('acrylic')">亚克力 acrylic</button>
      <button onclick="setMat('mica')">云母 mica</button>
      <button onclick="setMat('none')">无材质 none</button>
      <button onclick="toggleBg()">切换面板底色</button>
    </div>
    <div id="cur"></div>
  </div>
</div>
<script>
  const api = window.proto;
  let mat = 'acrylic', bgOn = true;
  function render() {
    document.getElementById('cur').textContent = '当前材质: ' + mat + ' / 面板底色: ' + (bgOn ? '浅色 0.35' : '近透明 0.02');
    document.getElementById('app').style.background = bgOn ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.02)';
    document.querySelectorAll('button').forEach(b => b.style.color = '#111');
  }
  function setMat(m) { mat = m; api.setMaterial(m); render(); }
  function toggleBg() { bgOn = !bgOn; render(); }
  function closeWin() { api.close(); }
  render();
</script>
</body>
</html>`;
}

app.whenReady().then(() => {
  ipcMain.on('proto-material', (_e, m) => {
    if (!win || win.isDestroyed()) return;
    try { win.setBackgroundMaterial(m); } catch (err) { console.error('setBackgroundMaterial 失败:', err.message); }
  });
  ipcMain.on('proto-close', () => { if (win && !win.isDestroyed()) win.close(); });
  createProto();
});
app.on('window-all-closed', () => app.quit());
