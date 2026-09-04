/**
 * EzTxt 自定义主题编辑器
 * 左侧 demo 实时预览，右侧名称（必填）+ 3 色（强调/背景/文字）+ 明暗开关。
 * 预览只改 demo（不落盘、不动主窗口）；「保存」写入 settings.customThemes 并广播生效。
 * 模式：query 无 id = 新建；有 id = 编辑已有主题（额外显示「删除」按钮）。
 */
(function () {
  'use strict';

  const DEFAULT_CUSTOM = { accent: '#e0a82e', bg: '#FAF5E1', ink: '#4a3f24', dark: false };

  // 内置主题 accent（与 settings.js / renderer.js 的 THEMES 保持一致）：
  // 编辑器窗口为独立自绘面板（不引 styles.css），按钮/滚动条需自行跟随用户当前主题强调色。
  const BUILTIN_ACCENTS = {
    amber: '#e0a82e', blue: '#2B5275', olive: '#4D5E30', terracotta: '#D16647',
    gold: '#BCA052', rose: '#954B44', sage: '#A68329', night: '#E8B84B',
    paper: '#2B5275', remi: '#A788D8', 'remi-night': '#F5A8C0'
  };

  /** 十六进制 → "r, g, b"（CSS --accent-rgb 用） */
  function hexToRgbStr(hex) {
    const s = String(hex || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ');
  }

  /** 应用当前激活主题的强调色到窗口根元素（供按钮/滚动条跟随） */
  function applyThemeAccent(s) {
    let accent = '#e0a82e';
    if (s && s.theme === 'custom' && s.customThemeId) {
      const ct = (s.customThemes || []).find((t) => t.id === s.customThemeId);
      if (ct && ct.accent) accent = ct.accent;
    } else if (s && BUILTIN_ACCENTS[s.theme]) {
      accent = BUILTIN_ACCENTS[s.theme];
    }
    const rgb = hexToRgbStr(accent);
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    if (rgb) root.style.setProperty('--accent-rgb', rgb);
  }

  // 快捷预设（accent / bg / ink / dark 一组）
  const PRESETS = [
    { accent: '#e0a82e', bg: '#FAF5E1', ink: '#4a3f24', dark: false }, // 琥珀
    { accent: '#7BA7D8', bg: '#F1F5FA', ink: '#2E4A66', dark: false }, // 深蓝
    { accent: '#66997A', bg: '#EFF5F0', ink: '#2E4A3A', dark: false }, // 墨绿
    { accent: '#C97B6B', bg: '#F9F1EE', ink: '#5A3A32', dark: false }, // 砖红
    { accent: '#9A7BB5', bg: '#F5F1F8', ink: '#46325C', dark: false }, // 紫藤
    { accent: '#D89A9A', bg: '#F8F0F0', ink: '#66393F', dark: false }, // 酒红
    { accent: '#7BA05B', bg: '#F2F6EC', ink: '#3A4A2E', dark: false }, // 草绿
    { accent: '#E8B4B8', bg: '#FDF4F4', ink: '#6B3A42', dark: false }, // 樱粉
    { accent: '#D9A05B', bg: '#FBF2E6', ink: '#5C4632', dark: false }, // 杏橙
    { accent: '#6BA3B5', bg: '#EEF5F7', ink: '#2E4850', dark: false }, // 青碧
    { accent: '#A3A3C2', bg: '#F2F2F7', ink: '#3C3C55', dark: false }, // 暮紫灰
    { accent: '#4CC2A0', bg: '#0F1613', ink: '#D7E5DF', dark: true }   // 暗夜薄荷
  ];

  // ===== 编辑目标 =====
  const urlParams = new URLSearchParams(window.location.search);
  const editId = urlParams.get('id') || null; // null = 新建

  const state = { name: '', ...DEFAULT_CUSTOM };
  const demoApp = document.getElementById('demoApp');
  const demoStage = document.querySelector('.demo-stage'); // mini 球所在舞台（变量同样注入）

  // ===== DOM 引用 =====
  const $ = (id) => document.getElementById(id);
  const nameInput = $('themeName');
  const nameError = $('nameError');
  const deleteBtn = $('deleteBtn');
  const saveBtn = $('saveBtn');
  const inputs = {
    accent: { color: $('accentColor'), hex: $('accentHex') },
    bg: { color: $('bgColor'), hex: $('bgHex') },
    ink: { color: $('inkColor'), hex: $('inkHex') }
  };
  const darkSwitch = $('darkSwitch');

  // ===== demo 应用（只动 demo 舞台 + 主容器，不动主窗口） =====
  function applyDemo() {
    // 注入到整个舞台：mini 球(.demo-mini)在 demo-app 外部，同样要吃到变量
    window.api.applyCustomThemeVars(state, demoStage);
    for (const key of Object.keys(inputs)) {
      inputs[key].color.value = state[key].toLowerCase();
      inputs[key].hex.value = state[key].toUpperCase();
    }
    darkSwitch.checked = state.dark;
  }

  // ===== 名称校验反馈 =====
  function setNameError(show) {
    nameInput.classList.toggle('error', show);
    nameError.classList.toggle('show', show);
  }
  nameInput.addEventListener('input', () => setNameError(false));

  // ===== 颜色输入绑定 =====
  for (const key of Object.keys(inputs)) {
    inputs[key].color.addEventListener('input', () => {
      state[key] = inputs[key].color.value.toUpperCase();
      applyDemo();
    });
    inputs[key].hex.addEventListener('change', () => {
      const v = inputs[key].hex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        state[key] = v.toUpperCase();
        applyDemo();
      } else {
        inputs[key].hex.value = state[key].toUpperCase(); // 非法回显
      }
    });
  }
  darkSwitch.addEventListener('change', () => {
    state.dark = darkSwitch.checked;
    applyDemo();
  });

  // ===== 预设色板 =====
  const presetsBox = $('presets');
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `强调 ${p.accent} · 背景 ${p.bg}`;
    btn.style.background = `linear-gradient(135deg, ${p.bg} 0 55%, ${p.accent} 55% 100%)`;
    btn.addEventListener('click', () => {
      Object.assign(state, p);
      applyDemo();
    });
    presetsBox.appendChild(btn);
  }

  // ===== JSON 一键导入：{accent,bg,ink,dark} 直接应用到当前编辑 =====
  const jsonInput = $('jsonImport');
  const jsonApplyBtn = $('jsonApplyBtn');
  const jsonError = $('jsonError');

  function applyJsonImport() {
    const raw = jsonInput.value.trim();
    if (!raw) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      setJsonError('不是合法的 JSON，请检查格式');
      return;
    }
    const hexOk = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim());
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      setJsonError('需要是 {accent,bg,ink,dark} 对象');
      return;
    }
    const missing = ['accent', 'bg', 'ink', 'dark'].filter((k) => !(k in obj));
    if (missing.length > 0) {
      setJsonError('缺少字段：' + missing.join(', '));
      return;
    }
    if (!hexOk(obj.accent) || !hexOk(obj.bg) || !hexOk(obj.ink)) {
      setJsonError('颜色需为 #RRGGBB 格式');
      return;
    }
    if (typeof obj.dark !== 'boolean') {
      setJsonError('dark 需为布尔值 true/false');
      return;
    }
    state.accent = obj.accent.trim().toUpperCase();
    state.bg = obj.bg.trim().toUpperCase();
    state.ink = obj.ink.trim().toUpperCase();
    state.dark = obj.dark;
    jsonInput.classList.remove('error');
    jsonError.textContent = '';
    applyDemo();
  }

  function setJsonError(msg) {
    jsonInput.classList.add('error');
    jsonError.textContent = msg;
  }
  jsonApplyBtn.addEventListener('click', applyJsonImport);
  jsonInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyJsonImport();
    }
  });
  jsonInput.addEventListener('input', () => {
    // 输入变化时清除错误态，等用户重新粘贴/回车
    jsonInput.classList.remove('error');
    jsonError.textContent = '';
  });

  // ===== 提示词复制：发给 AI 从图片提取配色 =====
  const COLOR_PROMPT = `你是配色提取助手。给你一张图片，请为「EzTxt」便签应用提取一个主题所需的 3 个颜色 + 1 个明暗开关。
【应用背景】EzTxt 是桌面待办 + Markdown 便签软件，界面气质：柔和、克制、轻量。主题只需 accent (强调色)/bg (背景) /ink (文字) /dark (是否深色) 四个值，其余次级变量（弱文字、分割线、卡片底、输入框表面）会由接收方按固定公式从这四值自动推导，因此你只需保证这 4 个值正确自洽。
【提取侧重 —— 务必遵守】
1. bg（背景）：从图片的背景区域采色；低饱和、柔和；要么是干净的浅色系，要么是干净的深色系，不要中间灰浊色。浅 / 深由 bg 决定，二选一。
2. accent（强调色）：从图片主体 / 视觉焦点采色（服装、装饰、最有记忆点的色块）；允许比 bg 饱和鲜明，但必须与 bg 同色相家族或天然和谐，禁止刺眼互补撞色。
3. ink（文字）：优先用图片中最深色（浅主题）或近白色（深主题）；若图片里没有合适文字色，就按 bg 明暗自行推导深 / 近白色。硬性要求：ink 与 bg 的对比度 ≥ 4.5:1（这是唯一不可妥协项）。
4. 自洽性自查：accent 与 bg 同色相家族；ink 与 bg 同色相方向（否则自动推导的弱文字会变脏灰）。
5. 明暗判定：bg 偏亮 → dark:false；bg 偏暗 → dark:true。
6. 气质红线：柔和克制、像纸质 / 梦幻便签；拒绝赛博朋克式高饱和撞色。
【输出格式】只输出 JSON，不要多余文字：
{"accent":"#A788D8","bg":"#FDF0F6","ink":"#693FA8","dark":false}

【示例 1 —— 成功】图片：粉紫晚霞 + 白色纱裙少女
→ {"accent":"#A788D8","bg":"#FDF0F6","ink":"#693FA8","dark":false}
理由：bg 取天空 / 纱裙的柔和淡粉紫（低饱和浅色）；accent 取裙摆与云霞的薰衣草紫（与 bg 同色系、略饱和）；ink 取同色相家族的深紫（与浅粉紫 bg 对比达标）。气质柔和梦幻 ✓
【示例 2 —— 成功】图片：暗夜星空 + 紫红点缀的夜景
→ {"accent":"#F5A8C0","bg":"#2A1B3D","ink":"#F3EAFB","dark":true}
理由：bg 取夜空深紫（干净深色）；accent 取灯光 / 霓虹的粉紫红（深底上的高识别点缀，与紫同族）；ink 取近白紫灰（深底上对比达标）。✓
【示例 3 —— 失败示范】图片：霓虹街景（青绿背景 + 品红招牌）
→ 错误输出：{"accent":"#FF2E88","bg":"#00E5A0","ink":"#000000","dark":false}
为什么不行：bg 高饱和荧光绿（刺眼，非柔和底色）；accent 品红与青绿互为互补撞色（同框会闪）；ink 用纯黑但 bg 太亮太彩，弱文字推导会脏。改正方向：bg 降饱和压暗成深青夜色 dark:true，accent 保留品红做点缀，ink 换近白。
【示例 4 —— 失败示范】图片：暖黄夕阳剪影
→ 错误输出：{"accent":"#FFB300","bg":"#FFF3D6","ink":"#8A6D1A","dark":false}
为什么不行：accent 取到与 bg 几乎同亮同族的黄色，按钮 / 焦点在浅底上失去辨识度（accent 必须比 bg 明显深一档或更饱和）；ink 偏棕金与 bg 对比不足。改正：accent 加深为赭橙 #B86B1F，ink 加深为深棕 #4A3A1E。
请先判断图片属于 "浅色系" 还是 "深色系"，再按上述侧重提取，输出示例格式的 JSON。`;

  const copyPromptBtn = $('copyPromptBtn');
  const helpBtn = $('helpBtn');
  const helpMask = $('helpMask');
  const helpCloseBtn = $('helpCloseBtn');
  const helpOkBtn = $('helpOkBtn');

  /** 复制文本到剪贴板（优先异步 Clipboard API，失败回退 execCommand） */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  let copyTimer = null;
  copyPromptBtn.addEventListener('click', () => {
    copyText(COLOR_PROMPT).then(() => {
      copyPromptBtn.classList.add('copied');
      copyPromptBtn.textContent = '已复制';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyPromptBtn.classList.remove('copied');
        copyPromptBtn.textContent = '复制提示词';
      }, 1500);
    }).catch(() => {
      copyPromptBtn.textContent = '复制失败';
      setTimeout(() => { copyPromptBtn.textContent = '复制提示词'; }, 1200);
    });
  });

  // ===== 帮助弹窗：说明如何用提示词 + 图片获取 JSON =====
  function openHelp() { helpMask.classList.remove('hidden'); }
  function closeHelp() { helpMask.classList.add('hidden'); }
  helpBtn.addEventListener('click', openHelp);
  helpCloseBtn.addEventListener('click', closeHelp);
  helpOkBtn.addEventListener('click', closeHelp);
  helpMask.addEventListener('click', (e) => {
    if (e.target === helpMask) closeHelp(); // 点遮罩关闭
  });

  // ===== 底部按钮 =====
  $('resetBtn').addEventListener('click', () => {
    const keepName = state.name;
    Object.assign(state, DEFAULT_CUSTOM, { name: keepName });
    applyDemo();
  });

  $('cancelBtn').addEventListener('click', () => window.close());
  $('closeBtn').addEventListener('click', () => window.close());

  // 删除（仅编辑模式显示）
  deleteBtn.addEventListener('click', async () => {
    try {
      const s = await window.api.loadSettings();
      const list = (s.customThemes || []).filter((t) => t.id !== editId);
      const patch = { customThemes: list };
      // 删除的是激活主题 → 回退默认预置主题
      if (s.theme === 'custom' && s.customThemeId === editId) {
        patch.theme = 'blue';
        patch.customThemeId = null;
      }
      await window.api.saveSettings(patch);
      window.close();
    } catch (err) {
      console.error('删除自定义主题失败：', err);
    }
  });

  // 保存（名称必填校验）
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      setNameError(true);
      nameInput.focus();
      return;
    }
    try {
      const s = await window.api.loadSettings();
      const list = Array.isArray(s.customThemes) ? [...s.customThemes] : [];
      const item = {
        id: editId || 'ct-' + Math.random().toString(16).slice(2, 10),
        name,
        accent: state.accent,
        bg: state.bg,
        ink: state.ink,
        dark: state.dark
      };
      const idx = list.findIndex((t) => t.id === item.id);
      if (idx >= 0) list[idx] = item;
      else list.push(item);
      // 编辑旧激活项或新建 → 激活该自定义主题
      const isActive = s.theme === 'custom' && s.customThemeId === item.id;
      const shouldActivate = !editId || isActive;
      await window.api.saveSettings({
        customThemes: list,
        ...(shouldActivate ? { theme: 'custom', customThemeId: item.id } : {})
      });
      window.close();
    } catch (err) {
      console.error('保存自定义主题失败：', err);
    }
  });

  // ===== 初始化 =====
  (async function init() {
    try {
      const s = await window.api.loadSettings();
      applyThemeAccent(s); // 按钮/滚动条跟随当前主题强调色
      if (editId) {
        // 编辑模式：载入对应项，显示删除按钮
        const item = (s.customThemes || []).find((t) => t.id === editId);
        if (item) {
          state.name = item.name || '';
          state.accent = item.accent || DEFAULT_CUSTOM.accent;
          state.bg = item.bg || DEFAULT_CUSTOM.bg;
          state.ink = item.ink || DEFAULT_CUSTOM.ink;
          state.dark = !!item.dark;
        }
        deleteBtn.style.display = '';
        saveBtn.textContent = '保存修改';
      } else {
        // 新建模式：预设默认沿用上次任一自定义主题的风格（无则琥珀默认）
        const last = (s.customThemes || [])[s.customThemes.length - 1];
        if (last) {
          state.accent = last.accent || DEFAULT_CUSTOM.accent;
          state.bg = last.bg || DEFAULT_CUSTOM.bg;
          state.ink = last.ink || DEFAULT_CUSTOM.ink;
          state.dark = !!last.dark;
        }
      }
    } catch (err) {
      console.error('读取自定义主题失败：', err);
    }
    nameInput.value = state.name;
    applyDemo();
  })();
})();
