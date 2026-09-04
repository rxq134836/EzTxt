# EzTxt UI 设计规范（UI Design Spec）

> **必读声明**：本文件是修改页面内容的强制前置阅读材料。
> 凡修改 `src/index.html`、`src/styles.css`、`src/renderer.js` 中与界面外观、交互、动画相关的代码，**动手前必须先通读本文件**，并保证改动满足全部「必须」条款。
>
> 规范来源：[emilkowalski/skills](https://github.com/emilkowalski/skills)（Emil Kowalski 的设计工程哲学，源自 Vercel / Linear 经验），
> 核心文档：`emil-design-eng/SKILL.md`、`review-animations/STANDARDS.md`、`animation-vocabulary/SKILL.md`。
> 原始出处：[emilkowal.ski](https://emilkowal.ski/ui) 系列文章、[animations.dev](https://animations.dev/)。

---

## 1. 设计哲学（一切规则的理由）

1. **品味是训练出来的，不是天生的** —— 不要只求"能用"。研究最好的界面为什么感觉好，逆向工程它们的动画与交互。
2. **看不见的细节在累积** —— 用户几乎不会注意到单个细节，但上千个正确的细节叠加，造就"不知道为什么就是好用"的界面。
3. **美是杠杆** —— 用户依据整体体验选工具，不只看功能。好的默认值与动画是真实的差异化优势。
4. **匹配组件性格（Cohesion）** —— 动效的速度、缓动、视觉要与产品气质一致：轻松的组件可以更活泼（略带弹跳），专业工具应干脆利落。本应用是轻量便签，整体气质：柔和、克制、响应快。

---

## 2. 动效决策框架（写任何动画前按顺序回答）

### 2.1 该不该动？（使用频率决定）

| 使用频率 | 决策 |
| --- | --- |
| 100+ 次/天（快捷键、面板开关） | **完全不动画** |
| 十几次/天（hover、列表导航） | 去掉或大幅缩减 |
| 偶尔（弹层、抽屉、toast） | 标准动画 |
| 罕见/首次（引导、庆祝） | 可以加趣味 |

**「必须」：键盘触发的动作永远不动画**（Ctrl+S/N、Esc 关闭等），高频操作加动画只会显得迟钝。Raycast 的打开/关闭没有动画，这才是高频工具的正确体验。

### 2.2 目的

每个动画必须有明确答案回答"为什么动"。合法目的：空间一致性、状态指示、解释、反馈、防止突兀变化。**仅仅"好看"且用户经常看到 → 不要动。**

### 2.3 缓动（Easing）

按顺序判断：

- 元素**进入/退出** → `ease-out`（起步快，响应感强）
- 元素**在屏上移动/变形** → `ease-in-out`
- **hover / 颜色变化** → `ease`
- **匀速运动**（滚动条、进度条）→ `linear`
- 兜底 → `ease-out`

**「必须」：UI 上永不使用 `ease-in`** —— 它起步慢，恰好拖慢了用户最关注的开头瞬间。同样的 300ms，`ease-out` 感觉比 `ease-in` 快。

**「必须」：使用强自定义曲线，不要用浏览器内置缓动**（太弱）。本项目已在 `styles.css` 定义并必须沿用：

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* 强 ease-out，UI 交互默认 */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* 强 ease-in-out，屏上移动 */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS 抽屉曲线（如需要） */
```

新曲线参考 [easing.dev](https://easing.dev/) / [easings.co](https://easings.co/)，不要凭空手写。

### 2.4 时长（Duration）

| 元素 | 时长 |
| --- | --- |
| 按钮按下反馈 | 100–160ms |
| Tooltip、小弹层 | 125–200ms |
| 下拉、选择框 | 150–250ms |
| 弹窗、抽屉 | 200–500ms |
| 营销/说明类 | 可更长 |

**「必须」：UI 动画控制在 300ms 以内**。180ms 的下拉比 400ms 的"更跟手"。

### 2.5 感知性能

动画速度直接影响用户对性能的感知：转得快的 spinner 让人觉得加载快；第一个 tooltip 打开后，后续 tooltip **跳过延迟 + 跳过动画**，整个工具栏会感觉更快。

---

## 3. 物理感与反馈（Physicality）

1. **「必须」所有可按下元素加按压反馈**：`:active { transform: scale(0.97) }`，`transition: transform 160ms ease-out`，缩放幅度 0.95–0.98。本项目 `.ctrl-btn`、`.tb-btn`、`.card-checkbox` 已遵循。
2. **「必须」从不从 `scale(0)` 进场** —— 现实中没有东西凭空出现。从 `scale(0.9~0.97)` + `opacity: 0` 开始。
3. **Popover 从触发点缩放（origin-aware）**：`transform-origin` 应指向触发元素，而不是默认的 center。**例外：模态框保持 center**（它们居中于视口，不锚定任何触发点）。
4. **Tooltip**：首次延迟出现防误触；一旦打开过一个，后续相邻 tooltip 应即时出现且无动画。
5. **非对称时序**：用户"决定"时慢（如按住删除 2s linear），系统"响应"时快（松开 200ms ease-out）。

---

## 4. 中断性与进入动画

- **「必须」动态 UI 用 CSS transition 而非 keyframes**：transition 可被中断并重新定向，keyframes 被中断会从零重来。快速重复触发的场景（增删 toast、切换状态）用 transition。
- 元素入场动画优先用 CSS `@starting-style`（现代浏览器），无需 JS 挂载状态；兼容方案是 `data-mounted` 属性模式。
- 本应用当前使用 `.hidden { display: none !important }` 切换显示 —— 若需要平滑过渡，改用 transition + 非 display 手段（如 `max-height` / `opacity` / `visibility`），并在满足性能规则的前提下处理。

---

## 5. 性能规则（Performance）

1. **「必须」只动画 `transform` 和 `opacity`** —— 它们跳过布局与绘制、跑在 GPU 上。动画 `padding`/`margin`/`height`/`width`/`top`/`left` 会触发全部三步渲染。
2. **不要在父元素上用 CSS 变量驱动子元素 transform** —— 会触发所有子元素重算样式。直接在目标元素上设 `transform`。
3. 预定的动画用 CSS（主线程外执行）；动态、可中断的动画才用 JS（WAAPI 兼具 JS 控制力与 CSS 性能）。
4. blur 用来掩盖不完美的交叉过渡：加 `filter: blur(2px)` 且 **blur < 20px**（过重模糊代价高）。交叉淡入显示两个重叠物体时用它融合。
5. 背景图图层（`bg-image-layer`）只动 `opacity` ✓（现有实现已符合）。

---

## 6. 无障碍（Accessibility）

1. **「必须」支持 `prefers-reduced-motion: reduce`**：保留辅助理解的 opacity/color 过渡，去掉位移类动画。
   ```css
   @media (prefers-reduced-motion: reduce) {
     /* 去掉 transform 位移，保留淡入 */
   }
   ```
2. hover 动效应放在 `@media (hover: hover) and (pointer: fine)` 内，避免触屏设备点按触发假 hover。本应用为桌面端，但新增 hover 效果时仍按此写。
3. 键盘可操作性：所有功能必须有键盘路径（本应用已有快捷键体系，新增 UI 时补充对应快捷键）。

---

## 7. 细节技巧（可选但推荐）

- **Stagger（交错）**：多个元素同时入场时依次错开，间隔 30–80ms；交错只是装饰，绝不能在播放时阻塞交互。
- **`translate` 用百分比**（相对自身尺寸），优先于硬编码像素。
- **`scale()` 会连带缩放子元素**（字体、图标一起缩放）—— 这正是按压反馈想要的效果。
- **clip-path 是强力动画工具**：`inset(0 100% 0 0)` 从右隐藏 → 逐边展开，可用于揭示、长按删除等。
- **Spring**：需要真实物理感、可中断的手势（拖动、可打断的展开）时用 spring，bounce 保持 0.1–0.3 且尽量少用；纯 CSS 项目用 transition 模拟即可。
- 交互动效的进入/退出方向要一致（空间一致性），用户才不会"跟丢"元素。
- **第二天用新眼光审查自己的动画**：慢放或逐帧检查时序问题。

---

## 8. 本项目现状对照（改动前先核对这里）

**已符合**（保持，不要回退）：
- `--ease-out` / `--ease-in-out` 自定义曲线已定义并全局使用 ✓
- `.ctrl-btn` / `.tb-btn` / `.card-checkbox` 有 `:active` 按压反馈 ✓
- `.card-toggle` 旋转动画使用 ease-out + 180ms ✓
- 背景图层只动 opacity ✓
- 动效时长大多 ≤ 220ms ✓

**已知偏差 / 待改进**（新改动不得扩大这些偏差，能顺手修复更好）：
- ⚠ `.card-note` 展开用 `max-height` 过渡 —— 属于布局属性动画，触发重排。可接受的折衷（内容高度不可预测），但**不得再新增**同类动画。
- ⚠ 全局没有 `prefers-reduced-motion` 处理 —— 新加入口动画时必须一并补上。
- ⚠ 部分 hover 动效未包在 `(hover: hover) and (pointer: fine)` 内 —— 桌面端影响小，新增时按规范写。
- ⚠ `.hidden` 用 `display:none` 硬切换 —— 如要给面板/搜索条加过渡，需改为可过渡方案。

---

## 9. UI 审查格式（必须遵守）

审查 UI/动画代码时，**必须用 Before/After 三列表格**输出，禁止用 "Before:" / "After:" 分行列表：

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | 指定确切属性，避免 `all` |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | 现实中没有东西凭空出现 |
| 下拉用 `ease-in` | `ease-out` 自定义曲线 | ease-in 感觉迟缓 |
| 按钮无 `:active` | `:active { transform: scale(0.97) }` | 按钮必须对按压有响应 |
| popover `transform-origin: center` | `transform-origin: var(--transform-origin)` | 从触发点缩放（模态框例外） |

---

## 10. 改动前检查清单（Checklist）

- [ ] 已通读本文件
- [ ] 该动效是否有必要？（频率表 + 目的）
- [ ] 缓动正确（进入/退出 → ease-out；移动 → ease-in-out；颜色 → ease）且用自定义曲线
- [ ] 时长 ≤ 300ms，按钮反馈 100–160ms
- [ ] 没有 `ease-in`、没有 `scale(0)`、没有 `transition: all`
- [ ] 只动 `transform` / `opacity`（新代码）
- [ ] 可按下元素有 `:active` 反馈
- [ ] popover 类从触发点缩放（模态框除外）
- [ ] 高频/键盘操作无动画
- [ ] `prefers-reduced-motion` 已考虑
- [ ] 新增 hover 动效已包在 `(hover: hover) and (pointer: fine)` 内
- [ ] 新 UI 有对应快捷键或键盘路径
- [ ] 与现有 7 套主题变量（`--bg`/`--accent`/`--ink` 等）协调，无硬编码颜色
- [ ] 危险/删除确认按钮使用 `.tb-btn.danger`，不自定义新危险类名（见 §11）

---

## 11. 危险/删除操作按钮样式约定（必须）

**「必须」：所有「删除 / 确定删除」等危险确认按钮统一使用 `class="tb-btn danger"`**，样式由 `styles.css` 中的 `.confirm-actions .tb-btn.danger` 提供：

```css
.confirm-actions .tb-btn.danger {
  background: var(--danger);   /* 实心危险红 */
  border-color: transparent;
  color: #fff;
  font-weight: 600;
}
```

规则要点：

1. **class 名必须写成 `tb-btn danger`（两个独立类）**，依赖复合选择器 `.tb-btn.danger`。
2. **禁止自创新危险类名**（如 `btn-danger`、`delete-btn danger-red` 等）——这类类名没有对应样式，按钮会退回普通外观，危险操作不再突出。
3. 危险按钮与「取消」并排时，危险按钮为实心红、取消按钮为常规描边样式，默认即可区分（不依赖 hover）。
4. 使用场景：主页删除确认弹窗、设置页删除背景图确认、归档窗口批量删除确认弹窗等一律遵循本条。
5. 若确实需要更强的视觉（图标 + 文字），在 `.tb-btn.danger` 基础上追加布局类，不要新增颜色类。

> 反面案例：归档窗口曾把确认删除按钮写成 `class="tb-btn btn-danger"`，因类名不匹配 `.tb-btn.danger` 规则而未套用实心红样式（已修复）。
