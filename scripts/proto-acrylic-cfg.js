'use strict';
// 决定性诊断：自制高对比度背板 + 三种亚克力窗口配置逐一对比截屏。
// 输出 proto-cfg-a.png（无框+bg'00000000'）、proto-cfg-c.png（无框+无bg选项）、
//      proto-cfg-d.png（有框默认标题栏）到系统临时目录后自动退出。

const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let backdrop = null;
let testWin = null;

function testHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; }
  #app { height: 100%; color: #111; font: bold 16px "Microsoft YaHei";
         display: flex; align-items: flex-start; padding: 10px; box-sizing: border-box; }
</style></head>
<body><div id="app"></div>
<script>document.getElementById('app').textContent = window.__CFG__ || 'cfg';</script>
</body></html>`;
}

function backdropHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; }
  /* 高对比度彩色棋盘：模糊与否一目了然 */
  #c {
    height: 100%;
    background:
      repeating-linear-gradient(45deg, #ff3b30 0 60px, #ffffff 60px 120px),
      repeating-linear-gradient(-45deg, #007aff 0 60px, #ffffff 60px 120px);
  }
</style></head>
<body><div id="c"></div></body></html>`;
}

async function captureShot(file) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * display.scaleFactor), height: Math.round(height * display.scaleFactor) }
  });
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src) throw new Error('no screen source');
  fs.writeFileSync(file, src.thumbnail.toPNG());
  console.log('saved', file);
}

async function runCfg(name, options, dataUrl) {
  if (testWin && !testWin.isDestroyed()) testWin.destroy();
  testWin = new BrowserWindow({
    width: 620,
    height: 440,
    x: 320,
    y: 300,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    ...options
  });
  testWin.loadURL(dataUrl);
  await new Promise((r) => testWin.once('ready-to-show', r));
  testWin.show();
  testWin.focus();
  await new Promise((r) => setTimeout(r, 1600));
  await captureShot(path.join(os.tmpdir(), `proto-cfg-${name}.png`));
}

async function main() {
  // 背板窗口（不透明彩色棋盘）
  backdrop = new BrowserWindow({
    width: 900,
    height: 620,
    x: 200,
    y: 180,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  backdrop.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(backdropHtml()));
  await new Promise((r) => backdrop.once('ready-to-show', r));
  backdrop.show();
  await new Promise((r) => setTimeout(r, 600));

  const html = testHtml();

  // 配置 A：无框 + backgroundColor '#00000000' + acrylic（当前项目的做法）
  await runCfg('a', {
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic'
  }, 'data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('cfg', 'A: 无框+bg00000000')));

  // 配置 C：无框 + 不设 backgroundColor + acrylic
  await runCfg('c', {
    frame: false,
    transparent: false,
    backgroundMaterial: 'acrylic'
  }, 'data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('cfg', 'C: 无框+无bg选项')));

  // 配置 D：有框（默认标题栏）+ acrylic
  await runCfg('d', {
    frame: true,
    transparent: false,
    backgroundMaterial: 'acrylic'
  }, 'data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('cfg', 'D: 有框+acrylic')));

  app.quit();
}

app.whenReady().then(main);
app.on('window-all-closed', () => app.quit());
