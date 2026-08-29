'use strict';
/**
 * 把 src/logo-0829-1.png 转成 src/icon.ico(多尺寸 16/32/48/64/128/256)
 * 和 src/icon.png(256px，供 Electron 运行时使用)。
 * 图标源已固定为 logo-0829-1.png —— 应用图标一律由此生成，勿改回旧 logo。
 * 运行: node scripts/gen-icon.js
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const ROOT = path.join(__dirname, '..');
// 图标源固定为 logo-0829-1.png（最新 logo）；改图标请替换此文件后重新运行本脚本
const SRC = path.join(ROOT, 'src', 'logo-0829-1.png');
const DST_ICO = path.join(ROOT, 'src', 'icon.ico');
const DST_PNG = path.join(ROOT, 'src', 'icon.png'); // 额外留一份 256px PNG 供 Electron 直接使用

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('源文件不存在:', SRC);
    process.exit(1);
  }

  const sizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = [];

  for (const s of sizes) {
    const buf = await sharp(SRC).resize(s, s).png().toBuffer();
    pngBuffers.push(buf);
    console.log('  生成', s + 'x' + s, 'PNG,', buf.length, 'bytes');
  }

  // 最大那张另存为 icon.png(Electron nativeImage 直接用)
  fs.writeFileSync(DST_PNG, pngBuffers[pngBuffers.length - 1]);
  console.log('已写入', DST_PNG);

  const ico = await pngToIco(pngBuffers);
  fs.writeFileSync(DST_ICO, ico);
  console.log('已写入', DST_ICO, '共', ico.length, 'bytes');
}

main().catch((err) => {
  console.error('转换失败:', err);
  process.exit(1);
});
