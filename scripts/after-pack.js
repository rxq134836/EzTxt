'use strict';
/**
 * electron-builder afterPack 钩子：
 * 用 rcedit 给主程序 exe 注入应用图标。
 * 背景：打包环境无法解压 winCodeSign（符号链接权限问题），故用
 * signAndEditExecutable:false 跳过 app-builder 的图标注入，
 * 在 pack 之后、NSIS 压缩之前手动注入，保证安装版/便携版内嵌正确图标。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  const { appOutDir, packager } = context;
  const exePath = path.join(appOutDir, packager.appInfo.productFilename + '.exe');
  const icoPath = path.join(packager.projectDir, 'src', 'icon.ico');
  const rcedit = path.join(__dirname, 'rcedit-x64.exe');
  if (!fs.existsSync(exePath)) {
    console.warn('[after-pack] exe 不存在，跳过图标注入:', exePath);
    return;
  }
  if (!fs.existsSync(rcedit)) {
    console.warn('[after-pack] rcedit 不存在，跳过图标注入:', rcedit);
    return;
  }
  console.log('[after-pack] 注入图标:', exePath);
  execFileSync(rcedit, [exePath, '--set-icon', icoPath], { stdio: 'inherit' });
};
