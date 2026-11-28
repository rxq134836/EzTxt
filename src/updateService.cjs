/**
 * EzTxt 自托管更新服务 —— 与 FlowSpec 共用同一套博客通用清单接口。
 *
 * 契约（见博客 /api/release/:id/latest.json）：
 *   { version, file, sha256, notes, publishedAt }
 * 客户端只依赖 base URL，不绑定具体工具站点实现；下载、校验、安装都在主进程完成。
 *
 * 安全规则：
 *  - base URL 与全部重定向必须是 HTTPS
 *  - latest.json 限 64 KiB，安装包限 512 MiB
 *  - 安装包必须是纯 *.exe 文件名（无路径分隔符）
 *  - sha256 必须与清单一致
 */
'use strict';

const { app, ipcMain, net } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHECK_CHANNEL = 'update:check';
const DOWNLOAD_CHANNEL = 'update:download';
const INSTALL_CHANNEL = 'update:install';
const PROGRESS_CHANNEL = 'update:progress';
const GET_STATE_CHANNEL = 'update:get-state';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 20000;
// 慢网下载：只在「连续 60 秒没有任何数据」时判超时，另有 15 分钟总上限兜底。
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
const DOWNLOAD_MAX_MS = 15 * 60 * 1000;
const EXE_NAME_RE = /^[A-Za-z0-9._-]+\.exe$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

// 最近一次检查结果。设置窗口打开时可立即拿到启动自动检查的状态，避免重复请求。
let lastState = { phase: 'idle', info: null, progress: null, error: '', installerPath: '' };
// 同一 URL 的并发检查复用同一个 Promise。
const inFlightChecks = new Map();

function log(message) {
  console.log(`[update] ${message}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getState() {
  return { ...lastState };
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value) {
  const base = String(value ?? '').trim().replace(/\/+$/, '');

  if (!base) {
    throw new Error('请先填写更新源地址');
  }

  if (!isHttpsUrl(base)) {
    throw new Error('更新源必须是 HTTPS 地址');
  }

  return base;
}

/** 简单三段式版本号比较；忽略预发布后缀。 */
function compareVersions(a, b) {
  const left = String(a).split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);

  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] > right[i] ? 1 : -1;
    }
  }

  return 0;
}

/** GET 小响应：超时、大小限制、仅 HTTPS 重定向。 */
function fetchManifest(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(new Error('检查更新超时，请检查网络或更新源地址')), MANIFEST_TIMEOUT_MS);

    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    let request;

    try {
      request = net.request({ url, method: 'GET' });
    } catch (error) {
      finish(error);
      return;
    }

    request.on('redirect', (_status, redirectUrl) => {
      if (!isHttpsUrl(redirectUrl)) {
        request.abort();
        finish(new Error('更新源重定向到了非 HTTPS 地址'));
      }
    });

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`更新源返回 HTTP ${response.statusCode}`));
        return;
      }

      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_MANIFEST_BYTES) {
          request.abort();
          finish(new Error('更新清单过大，已拒绝'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, Buffer.concat(chunks)));
      response.on('error', (error) => finish(error));
    });
    request.on('error', (error) => finish(error));
    request.end();
  });
}

async function checkForUpdate(baseUrlInput) {
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const raw = await fetchManifest(`${baseUrl}/latest.json`);
  let manifest;

  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('更新清单不是有效的 JSON');
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('更新清单格式无效');
  }

  const version = String(manifest.version ?? '').trim();
  const file = String(manifest.file ?? '').trim();
  const sha256 = String(manifest.sha256 ?? '').trim().toLowerCase();

  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error('更新清单缺少有效版本号');
  }

  if (!EXE_NAME_RE.test(file)) {
    throw new Error('更新清单的安装包文件名无效');
  }

  if (!SHA256_RE.test(sha256)) {
    throw new Error('更新清单缺少有效的 sha256');
  }

  const currentVersion = app.getVersion();

  return {
    ok: true,
    available: compareVersions(version, currentVersion) > 0,
    currentVersion,
    version,
    file,
    sha256,
    baseUrl,
    notes: typeof manifest.notes === 'string' ? manifest.notes.slice(0, 2000) : '',
    publishedAt: typeof manifest.publishedAt === 'string' ? manifest.publishedAt.slice(0, 40) : '',
  };
}

/** 同一 base URL 的重复检查复用在途请求。 */
function check(baseUrlInput) {
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(baseUrlInput);
  } catch (error) {
    return Promise.reject(error);
  }

  if (!inFlightChecks.has(baseUrl)) {
    const task = checkForUpdate(baseUrl).finally(() => {
      inFlightChecks.delete(baseUrl);
    });
    inFlightChecks.set(baseUrl, task);
  }

  return inFlightChecks.get(baseUrl);
}

/** 流式下载安装包；持续收数据就重置空闲计时。 */
function downloadInstaller(url, destination, reportProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    let lastReport = 0;
    const output = fsSync.createWriteStream(destination);
    let idleTimer = null;
    let maxTimer = null;

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(new Error('下载超时，请检查网络或更新源')),
        DOWNLOAD_IDLE_TIMEOUT_MS,
      );
    }

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      if (error) {
        output.destroy();
        reject(error);
      } else {
        resolve();
      }
    }

    resetIdleTimer();
    maxTimer = setTimeout(
      () => finish(new Error('下载超过 15 分钟，已中止，请检查网络或更新源')),
      DOWNLOAD_MAX_MS,
    );

    let request;

    try {
      request = net.request({ url, method: 'GET' });
    } catch (error) {
      finish(error);
      return;
    }

    request.on('redirect', (_status, redirectUrl) => {
      if (!isHttpsUrl(redirectUrl)) {
        request.abort();
        finish(new Error('下载重定向到了非 HTTPS 地址'));
      }
    });

    request.on('response', (response) => {
      resetIdleTimer();
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`下载失败：HTTP ${response.statusCode}`));
        return;
      }

      const total = Number(response.headers['content-length']) || 0;

      response.on('data', (chunk) => {
        received += chunk.length;
        resetIdleTimer();

        if (received > MAX_INSTALLER_BYTES) {
          request.abort();
          finish(new Error('安装包超过 512 MB，已拒绝'));
          return;
        }

        const now = Date.now();

        if (now - lastReport > 120) {
          lastReport = now;
          reportProgress({
            received,
            total,
            percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
          });
        }

        if (!output.write(chunk)) {
          response.pause();
          output.once('drain', () => response.resume());
        }
      });

      response.on('end', () => {
        output.end(() => {
          reportProgress({ received, total, percent: 100 });
          finish(null);
        });
      });
      response.on('error', (error) => finish(error));
    });
    request.on('error', (error) => finish(error));
    request.end();
  });
}

async function downloadUpdate(payload, reportProgress) {
  const baseUrl = normalizeBaseUrl(payload?.baseUrl);
  const file = String(payload?.file ?? '');
  const expected = String(payload?.sha256 ?? '').toLowerCase();

  if (!EXE_NAME_RE.test(file)) {
    throw new Error('安装包文件名无效');
  }

  if (!SHA256_RE.test(expected)) {
    throw new Error('安装包校验值无效');
  }

  const directory = path.join(os.tmpdir(), 'eztxt-updates');
  await fs.mkdir(directory, { recursive: true });

  const destination = path.join(directory, file);
  const partial = `${destination}.part`;

  log(`downloading ${file} from ${baseUrl}`);
  await downloadInstaller(`${baseUrl}/${file}`, partial, reportProgress);

  const bytes = await fs.readFile(partial);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');

  if (actual !== expected) {
    await fs.unlink(partial).catch(() => {});
    throw new Error('安装包校验失败（sha256 不匹配），可能下载不完整或文件被篡改');
  }

  await fs.rename(partial, destination);
  log(`verified ${file} (${bytes.length} bytes)`);

  return { filePath: destination, size: bytes.length };
}

function installUpdate(filePath) {
  const installer = String(filePath ?? '');

  if (!path.isAbsolute(installer) || !fsSync.existsSync(installer)) {
    throw new Error('安装包不存在，请重新下载');
  }

  log('launching installer and quitting');
  const child = spawn(installer, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  // 交给安装包接管；NSIS 安装完成后重新打开 EzTxt。
  setTimeout(() => app.quit(), 400);

  return { started: true };
}

/**
 * 注册 IPC。onState(patch) 用于主进程广播状态给所有窗口。
 */
function registerUpdateHandlers({ onState } = {}) {
  function publish(patch) {
    lastState = { ...lastState, ...patch };
    if (typeof onState === 'function') {
      onState(getState());
    }
  }

  ipcMain.handle(CHECK_CHANNEL, async (_event, baseUrl) => {
    try {
      const result = await check(baseUrl);
      publish({ phase: result.available ? 'available' : 'latest', info: result, error: '', progress: null });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      log(`check failed: ${message}`);
      publish({ phase: 'error', info: null, error: message, progress: null });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(DOWNLOAD_CHANNEL, async (event, payload) => {
    try {
      const sender = event.sender;
      publish({ phase: 'downloading', progress: { received: 0, total: 0, percent: 0 }, error: '' });
      const result = await downloadUpdate(payload, (progress) => {
        if (!sender.isDestroyed()) {
          sender.send(PROGRESS_CHANNEL, progress);
        }
        publish({ progress });
      });
      publish({ phase: 'ready', installerPath: result.filePath, progress: null });
      return { ok: true, ...result };
    } catch (error) {
      const message = errorMessage(error);
      log(`download failed: ${message}`);
      publish({ phase: 'error', error: message, progress: null });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(INSTALL_CHANNEL, async (_event, filePath) => {
    try {
      return { ok: true, ...installUpdate(filePath) };
    } catch (error) {
      const message = errorMessage(error);
      log(`install failed: ${message}`);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(GET_STATE_CHANNEL, () => getState());
}

module.exports = {
  CHECK_CHANNEL,
  DOWNLOAD_CHANNEL,
  INSTALL_CHANNEL,
  PROGRESS_CHANNEL,
  GET_STATE_CHANNEL,
  check,
  getState,
  registerUpdateHandlers,
};
