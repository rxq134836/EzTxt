'use strict';
// 仅截取当前整屏并保存，随后自动退出（用于验证 EzTxt 主窗口的系统亚克力效果）
const { app, desktopCapturer, screen } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 500));
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * display.scaleFactor), height: Math.round(height * display.scaleFactor) }
  });
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  const file = path.join(os.tmpdir(), 'eztxt-smoke-shot.png');
  fs.writeFileSync(file, src.thumbnail.toPNG());
  console.log('saved', file);
  app.quit();
});
