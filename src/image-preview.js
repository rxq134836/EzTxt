'use strict';

// ===== 独立图片预览窗口逻辑 =====
// 主进程通过 image-preview-data 下发 { srcs: string[], index: number, theme?: {bg,ink,inkSoft,accent,line} }
// 功能：左右切换（按钮/←→）、Esc/关闭、单张隐藏导航、
//       滚轮缩放（鼠标锚点）、拖拽平移、双击/按钮复位、缩放按钮（+/-/1:1）

const stage = document.getElementById('stage');
const img = document.getElementById('previewImg');
const counter = document.getElementById('counter');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnClose = document.getElementById('btnClose');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const btnReset = document.getElementById('btnReset');

let srcs = [];
let idx = 0;

// 缩放状态
const ZOOM_MIN = 0.25;   // 相对 fit 尺寸的最小倍数（往下缩）
const ZOOM_MAX = 20;     // 相对原始像素的最大倍数（往上放）
const ZOOM_STEP = 1.25;  // 每档缩放倍率
let zoom = 1;            // 当前缩放倍数（相对 fit 基准）
let panX = 0;            // 位移（px）
let panY = 0;
let fitScale = 1;        // fit 时原始像素 → 显示尺寸 的换算
let isZoomed = false;    // 是否处于缩放态
let dragging = false;    // 是否正在拖拽
let dragStartX = 0, dragStartY = 0, dragPanX = 0, dragPanY = 0;

// ===== 主题色应用 =====
function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  const root = document.documentElement;
  const set = (name, val) => { if (typeof val === 'string' && val) root.style.setProperty(name, val); };
  set('--pv-bg', theme.bg);
  set('--pv-ink', theme.ink);
  set('--pv-ink-soft', theme.inkSoft);
  set('--pv-accent', theme.accent);
  set('--pv-line', theme.line);
}

// ===== 图片显示 =====
function resetZoom() {
  isZoomed = false;
  zoom = 1;
  panX = 0;
  panY = 0;
  img.classList.remove('pv-zoomed', 'pv-dragging');
  img.style.transform = '';
  img.style.width = '';
  img.style.height = '';
  updateResetLabel();
}

// 复位/缩放按钮文字：缩放态显示相对原始像素的百分比，fit 态显示“自适应”
function updateResetLabel() {
  btnReset.textContent = isZoomed
    ? Math.round(fitScale * zoom * 100) + '%'
    : '自适应';
}

function showImage() {
  if (!srcs.length) return;
  resetZoom();
  img.src = srcs[idx] || '';
  counter.textContent = `${idx + 1} / ${srcs.length}`;
  const single = srcs.length <= 1;
  btnPrev.classList.toggle('hidden', single);
  btnNext.classList.toggle('hidden', single);
}

// 进入缩放态：以 fit 尺寸为基准，记录原始像素↔fit 的换算，应用缩放与位移
function enterZoom() {
  if (isZoomed) return;
  if (!img.naturalWidth || !img.naturalHeight) return;
  isZoomed = true;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  fitScale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight, 1);
  if (!fitScale) fitScale = 1;
  img.classList.add('pv-zoomed');
  img.style.width = img.naturalWidth + 'px';
  img.style.height = img.naturalHeight + 'px';
  applyTransform();
  updateResetLabel();
}

// 应用 transform：以 fit 显示为中心锚点计算位移
function applyTransform() {
  const s = fitScale * zoom;
  // fit 时图片在 stage 中心：中心偏移 = (stage - naturalSize*fitScale)/2
  const cx = (stage.clientWidth - img.naturalWidth * fitScale) / 2;
  const cy = (stage.clientHeight - img.naturalHeight * fitScale) / 2;
  // 以 fit 中心为原点，缩放围绕中心：平移量 = 中心 + 缩放造成的中心外扩
  const tx = cx - (img.naturalWidth * s - img.naturalWidth * fitScale) / 2 + panX;
  const ty = cy - (img.naturalHeight * s - img.naturalHeight * fitScale) / 2 + panY;
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

function zoomBy(factor, anchorX, anchorY) {
  if (!isZoomed) { enterZoom(); }
  if (!isZoomed) return;
  const oldS = fitScale * zoom;
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
  const newS = fitScale * newZoom;
  // 缩放动画避免闪烁
  // 以锚点（stage 坐标）为中心缩放：保持锚点下的图片点不动
  // 图片左上角当前 stage 坐标
  const cx0 = (stage.clientWidth - img.naturalWidth * fitScale) / 2;
  const cy0 = (stage.clientHeight - img.naturalHeight * fitScale) / 2;
  const curX = cx0 - (img.naturalWidth * oldS - img.naturalWidth * fitScale) / 2 + panX;
  const curY = cy0 - (img.naturalHeight * oldS - img.naturalHeight * fitScale) / 2 + panY;
  // 锚点在图片坐标系的比例
  const ax = anchorX || stage.clientWidth / 2;
  const ay = anchorY || stage.clientHeight / 2;
  const px = (ax - curX) / oldS;
  const py = (ay - curY) / oldS;
  // 缩放后图片左上角 = 锚点 - px*newS
  const newX = ax - px * newS;
  const newY = ay - py * newS;
  // 换算回 pan 偏移
  panX = newX - (cx0 - (img.naturalWidth * newS - img.naturalWidth * fitScale) / 2);
  panY = newY - (cy0 - (img.naturalHeight * newS - img.naturalHeight * fitScale) / 2);
  zoom = newZoom;
  applyTransform();
  updateResetLabel();
}

function zoomToFit() {
  if (!isZoomed) return;
  resetZoom(); // 直接回到纯 fit 态
}

function nav(dir) {
  if (!srcs.length) return;
  idx = (idx + dir + srcs.length) % srcs.length;
  showImage();
}

function closeWindow() {
  if (window.api && window.api.closeImagePreviewWindow) {
    window.api.closeImagePreviewWindow();
  }
}

// ===== 事件 =====
// 接收主进程下发的图片数据
if (window.api && window.api.onImagePreviewData) {
  window.api.onImagePreviewData((payload) => {
    const list = Array.isArray(payload && payload.srcs) ? payload.srcs.filter(Boolean) : [];
    if (!list.length) return;
    applyTheme(payload.theme);
    srcs = list;
    idx = Math.max(0, Math.min(payload.index || 0, srcs.length - 1));
    showImage();
  });
}

btnPrev.addEventListener('click', () => nav(-1));
btnNext.addEventListener('click', () => nav(1));
btnClose.addEventListener('click', closeWindow);

btnZoomIn.addEventListener('click', () => { if (!isZoomed) enterZoom(); else zoomBy(ZOOM_STEP); });
btnZoomOut.addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
btnReset.addEventListener('click', zoomToFit);

// 滚轮缩放：以鼠标位置为锚点
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const ax = e.clientX - rect.left;
  const ay = e.clientY - rect.top;
  zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ax, ay);
}, { passive: false });

// 双击复位
img.addEventListener('dblclick', (e) => { e.preventDefault(); zoomToFit(); });

// 拖拽平移（仅缩放态）
stage.addEventListener('mousedown', (e) => {
  if (!isZoomed || e.button !== 0) return;
  dragging = true;
  img.classList.add('pv-dragging');
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragPanX = panX;
  dragPanY = panY;
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  panX = dragPanX + (e.clientX - dragStartX);
  panY = dragPanY + (e.clientY - dragStartY);
  applyTransform();
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  img.classList.remove('pv-dragging');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeWindow(); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); if (!isZoomed) enterZoom(); else zoomBy(ZOOM_STEP); }
  else if (e.key === '-') { e.preventDefault(); zoomBy(1 / ZOOM_STEP); }
  else if (e.key === '0') { e.preventDefault(); zoomToFit(); }
});
