'use strict';
// 诊断脚本：创建同一个亚克力窗口，分别在 acrylic / none 两种材质下截取整屏，
// 输出到系统临时目录 proto-shot-acrylic.png / proto-shot-none.png，然后自动退出。
// 用像素对比判断系统材质是否真的渲染（acrylic 与 none 应该明显不同）。

const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let win = null;

function getHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { background: transparent; margin: 0; height: 100%; }
  #app { height: 100%; border-radius: 12px; background: rgba(255,255,255,0.05);
         border: 1px solid rgba(255,255,255,0.4); color: #fff; font: 14px "Microsoft YaHei";
         display: flex; align-items: center; justify-content: center; }
</style></head>
<body><div id="app">acrylic 诊断窗口（背后应为虚化桌面）</div></body></html>`;
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
  const buf = src.thumbnail.toPNG();
  fs.writeFileSync(file, buf);
  console.log('saved', file, buf.length, 'bytes');
}

async function main() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const W = 760, H = 480;
  win = new BrowserWindow({
    width: W,
    height: H,
    // 放到屏幕右下密集内容区上方，便于观察模糊效果
    x: wa.x + Math.round(wa.width * 0.45),
    y: wa.y + Math.round(wa.height * 0.45),
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    alwaysOnTop: true,
    resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getHtml()));
  await new Promise((r) => win.once('ready-to-show', r));
  win.show();
  win.focus();
  await new Promise((r) => setTimeout(r, 1500));

  await captureShot(path.join(os.tmpdir(), 'proto-shot-acrylic2.png'));

  try { win.setBackgroundMaterial('none'); } catch (e) { console.error('set none failed:', e.message); }
  await new Promise((r) => setTimeout(r, 900));
  await captureShot(path.join(os.tmpdir(), 'proto-shot-none2.png'));

  app.quit();
}

app.whenReady().then(main);
app.on('window-all-closed', () => app.quit());
