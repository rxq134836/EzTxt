# EzTxt 便签

<div align="center">

**Language: 简体中文 | [English](README.en.md)**

</div>

<div align="center">

**桌面待办 · Markdown 便签 · 悬浮小球**

一个基于 Electron 的本地待办事项与 Markdown 笔记应用：待办卡片 + 所见即所得 Markdown 备注、拖拽贴边的悬浮小球、主题 / 材质 / 背景图个性化、独立设置窗口。

![Electron](https://img.shields.io/badge/Electron-31.x-47848F?logo=electron&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2020-F7DF1E?logo=javascript&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

![](./img/img1.png)

![](./img/img2.png)

---

## 📌 目录

- [✨ 功能特性](#-功能特性)
- [🖥️ 技术栈](#️-技术栈)
- [🚀 快速开始](#-快速开始)
- [🎮 使用说明](#-使用说明)
- [⌨️ 快捷键](#️-快捷键)
- [📦 项目结构](#-项目结构)
- [⚙️ 数据与配置](#️-数据与配置)
- [🔨 打包发布](#-打包发布)
- [🗓️ 更新记录](#️-更新记录)
- [📄 License](#-license)

---

## ✨ 功能特性

### 待办事项
- **卡片式待办列表**：新建 / 编辑 / 完成勾选 / 删除，支持批量选择与二次确认删除
- **分割线分组**：插入分割线并附加可选标题，便于按区域组织任务
- **实时搜索过滤**：顶部搜索框按关键字过滤任务
- **自动保存**：全局防抖自动保存（2s），`Ctrl+S` 立即保存，关闭前尽力保存

### Markdown 所见即所得备注
- 每张卡片可展开「备注」区域，**所见即所得**地编辑 Markdown（`marked` 渲染 + `turndown` 反序列化，往返无损）
- 支持**代码块语法高亮**（highlight.js）：JavaScript / TypeScript / Bash / SQL / C# (.NET) / Java / Python / Vue 等
- 代码块右下角自动标注语言徽标
- Typora 式代码块输入：输入 ` ```语言 ` + 回车即生成代码块，代码块内回车换行、空行回车退出
- 粘贴图片自动转内嵌 base64 图片，粘贴多行代码保持单个代码块不散块

### 悬浮小球（Mini 球）
- 工具栏一键收缩为**桌面悬浮小球**，或拖动窗口到屏幕边缘自动贴边
- 小球显示未完成数，点击展开 / 拖拽移动
- **macOS Genie 式缩放动画**：收起时内容向右上角收缩，展开时从贴近小球的边缘释放
- 小球固定经典实心主题色，不随材质切换

### 个性化外观
- **11 套主题色**：琥珀 / 深蓝 / 墨绿 / 砖红 / 棕金 / 酒红 / 草绿 / 纯黑 / 纯白 / 蕾米埃尔（粉紫）/ 蕾米埃尔·夜（深紫）
- **窗口材质**：经典（不透明）/ 半透明，亚克力（磨砂玻璃）预留
- **背景图**：自定义背景图片，可调透明度，保留最近 10 张上传历史
- **字体大小**：页面基础字号滑杆调节
- **窗口比例**：默认 / 宽横屏 / 横屏 / 窄竖屏 / 长竖屏 + **自定义尺寸**（弹窗输入宽高，实时跟随主窗口）

### 系统集成
- **系统托盘**：关闭时默认缩小到托盘，托盘菜单显示 / 退出；关闭按钮行为可在设置中切换（缩小到托盘 / 退出软件）
- **置顶**：`Ctrl+Shift+T` 窗口置顶
- **独立设置窗口**：外观 / 快捷键 / 关闭行为 / 数据保存位置均在此管理
- **可自定义数据存储位置**：默认本地 `data/`（开发）或 `userData/storage`（打包），可切换目录并迁移数据
- **编辑器快捷键**：加粗 / 斜体 / 行内代码 / 代码块 / 有序 / 无序列表，可开关、可改绑
- **干净卸载**：卸载时自动结束进程并清理缓存，仅保留待办数据

---

## 🖥️ 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | [Electron](https://www.electronjs.org/) 31.x（contextIsolation + preload 桥接） |
| Markdown 渲染 | [marked](https://github.com/markedjs/marked) 13.x |
| HTML → Markdown | [turndown](https://github.com/mixmark-io/turndown) 7.x |
| 代码高亮 | [highlight.js](https://highlightjs.org/) 11.x |
| 打包 | [electron-builder](https://www.electron.build/) 24.x（NSIS / Portable） |
| 样式 | 原生 CSS（设计规范见 `docs/UI-DESIGN-SPEC.md`） |

> 说明：渲染进程开启 `contextIsolation` 与 `sandbox: false`，所有 Node 能力（marked / turndown / highlight.js / IPC）均封装在 preload 中通过 `window.api` 暴露，渲染层不直接持有 Node 模块。

---

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) ≥ 18
- [npm](https://www.npmjs.com/)（或 pnpm / yarn）
- Windows 10 / 11（打包目标为 Windows x64）

### 安装与运行

```bash
# 1. 克隆仓库
git clone <your-repo-url>
cd easy-txt

# 2. 安装依赖
npm install

# 3. 开发运行（带日志）
npm start
# 或
npm run dev
```

> 国内网络可参考 `.npmrc` 中的镜像配置（electron / electron-builder 二进制走 npmmirror）。

### 开发调试

```bash
npm run dev          # electron . --enable-logging
npm run gen:icon     # 重新生成应用图标（src/icon.ico / icon.png）
```

---

## 🎮 使用说明

### 基本操作
1. **新建任务**：顶部「新建」按钮或 `Ctrl+N`，输入标题回车确认
2. **完成 / 删除**：点击卡片左侧勾选完成；「删除」进入批量模式，勾选多张后二次确认删除
3. **备注**：点击卡片右侧「展开备注」箭头，在编辑区输入 Markdown，内容所见即所得
4. **分割线**：工具栏「分割」插入分组线，可给分组起标题
5. **收缩为小球**：工具栏「缩为小条」，窗口收缩为桌面悬浮球（拖动到屏幕边缘也可自动贴边）
6. **设置**：工具栏「设置」打开独立设置窗口

### 数据存储
- 默认数据目录：开发模式为项目内 `data/`，打包后为 `%APPDATA%\EzTxt\storage`
- 数据文件：`note.json`（待办数据）、`settings.json`（设置）
- 可在「设置 → 数据保存」中查看当前位置、打开目录、修改存储目录（自动迁移数据）

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+S` | 立即保存 |
| `Ctrl+N` | 新建任务 |
| `Ctrl+Shift+T` | 切换窗口置顶 |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | 加粗 / 斜体 / 行内代码 |
| `Ctrl+D` | 删除线（~~文本~~，可重复切换） |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | 有序 / 无序列表 |
| `Ctrl+Shift+K` | 代码块 |
| `` ```语言 `` + `Enter` | 生成代码块（如 ` ```js `、` ```python `） |
| `Enter` | 列表内回车自动续项；代码块内换行；空代码块行回车退出 |
| `Shift+Enter` | 软换行 |
| `Tab` / `Shift+Tab` | 缩进 / 反缩进 |
| `Backspace` | 删除选中任务（非输入态） |
| `Ctrl+/` | 显示 / 隐藏快捷键帮助 |

> 编辑器快捷键可在「设置 → 快捷键设置」中逐个开关、重新绑定（需包含 Ctrl/Alt 组合键）。

---

## 📦 项目结构

```
easy-txt/
├── src/                     # 应用源码
│   ├── main.js              # Electron 主进程：窗口/托盘/贴边/存储/IPC
│   ├── preload.js           # preload：marked/turndown/highlight.js 封装 + contextBridge
│   ├── renderer.js          # 主窗口渲染逻辑：待办列表 + WYSIWYG 编辑器
│   ├── index.html           # 主窗口页面
│   ├── settings.html        # 独立设置窗口页面
│   ├── settings.js          # 设置窗口逻辑
│   ├── styles.css           # 全局样式（主题/材质/编辑器/滚动条等）
│   ├── custom-theme.*       # 自定义主题调色窗口（html/js）
│   ├── mini-gifs/           # mini 球动画 GIF（remi-1~4.gif，蕾米埃尔主题用）
│   ├── icon.ico / icon.png  # 应用图标
│   └── logo-0829-1.*        # 原始 Logo 素材（不参与打包）
├── scripts/
│   ├── gen-icon.js          # 图标生成脚本
│   ├── after-pack.js        # 打包后处理（rcedit 注入图标）
│   ├── uninstaller.nsh      # NSIS 自定义卸载脚本（清理缓存、保留数据）
│   └── rcedit-x64.exe       # 图标注入工具
├── docs/
│   └── UI-DESIGN-SPEC.md    # UI 设计规范
├── data/                    # 开发模式数据目录（自动生成）
├── dist/                    # 打包输出目录（自动生成）
├── .npmrc                   # npm 镜像配置
└── package.json
```

---

## ⚙️ 数据与配置

设置项（`settings.json`）：

| 配置 | 说明 |
| --- | --- |
| `theme` | 主题色 key |
| `material` | 窗口材质：`opaque`（经典）/ `translucent`（半透明）/ `acrylic`（预留） |
| `acrylicBlur` | 亚克力磨砂强度（预留） |
| `bgImage` / `bgHistory` | 当前背景图 / 最近 10 张背景图历史（dataURL） |
| `bgOpacity` | 背景图不透明度 |
| `fontSize` | 页面基础字号（px） |
| `closeAction` | 关闭按钮行为：`tray`（缩小到托盘）/ `quit`（退出软件） |
| `windowSize` / `customWindowSize` | 窗口比例预设 / 自定义尺寸 |
| `shortcuts` | 编辑器快捷键（开关与键位） |

---

## 🔨 打包发布

```bash
npm run dist           # 构建 NSIS 安装包 + Portable 便携版（win x64）
npm run dist:portable  # 仅 Portable 便携版
npm run dist:nsis      # 仅 NSIS 安装包
```

产物输出到 `dist/`：

- `EzTxt-<version>-x64.exe`（NSIS 安装包）
- `EzTxt-<version>-x64-portable.exe`（便携版）

> 卸载时：安装版会通过自定义 NSIS 脚本结束运行中的进程、清理缓存目录（Cache / logs 等），**保留待办数据**（`storage` 目录）。

---

## 🗓️ 更新记录

### 2026-08-30

**代码块与编辑体验**
- 新增代码块**语法高亮**（highlight.js）：JavaScript / TypeScript / Bash / SQL / C# (.NET) / Java / Python / Vue 等
- 代码块右下角自动标注**语言徽标**（取自 ` ```语言 ` 后的类型）
- 新增 Markdown **删除线** `~~text~~`（`marked` + `turndown` 往返无损），快捷键 **`Ctrl+D`**
- 删除线使用高对比红色、失焦后仍保留显示（不依赖浏览器保留 `<del>`）
- 折叠摘要（待办标题右侧备注预览）不再显示 `~~` 源码，只显示纯文本
- 备注输入框**取消最大高度**，内容多长就显示多长，卡片随内容撑开

**快捷键设置**
- 新增**删除线快捷键**（默认 `Ctrl+D`），可在设置页开关 / 改绑
- 新增**恢复默认快捷键**按钮（一键重置全部键位）
- 新增**快捷键冲突检测**：新组合被占用时弹出提示、自动恢复原键位、不保存
- 修复快捷键组合设置问题（修饰键误绑定 / 中文输入法干扰 / Ctrl+Backspace 误判清除）

**窗口与外观**
- 新增**窗口比例**预设：默认 / 宽横屏 / 横屏 / 窄竖屏 / 长竖屏（虚线方块预览）
- 支持**自定义窗口尺寸**：弹窗输入宽高，实时跟随主窗口（拖动主窗口数值自动同步）
- 窗口材质：经典（不透明）/ 半透明（亚克力预留，暂隐藏）
- 新增「**关闭按钮行为**」设置：缩小到托盘 / 退出软件，悬浮提示跟随设置
- mini 球**鼠标穿透**：球外透明区域不再拦截点击（可点到下层软件），移入球恢复交互
- mini 球展开/收起采用 macOS Genie 式缩放动画，球固定经典实心主题色

**系统集成**
- 新增**自动更新**（electron-updater + GitHub Releases）：启动自动检查、设置页「软件更新」显示版本 / 检查更新 / 下载进度 / 一键安装
- 新增**干净卸载**：NSIS 自定义脚本结束进程、清理缓存，仅保留待办数据

### 2026-09-01

**排序与任务管理**
- 新增**拖动排序**：卡片左侧拖动把手（HTML5 DnD），按住把手拖动调整待办顺序；搜索过滤时自动禁用，避免误拖
- 拖动中高亮目标位置，松开即完成排序并保存

**编辑体验**
- 删除线支持**重复添加 / 取消**：光标已在删除线内时按 `Ctrl+D` 解开标签恢复纯文本，否则包裹为删除线
- 新增**自定义主题颜色**：独立窗口调整配色（背景 / 强调 / 文字等），命名保存后立即应用到主窗口；支持多套自定义主题管理与切换

**主题与系统**
- 新增 **「蕾米埃尔」** 主题（柔和粉 + 薰衣草紫，浅色）与 **「蕾米埃尔·夜」** 主题（深紫 + 粉紫高光，深色）
- mini 球状态**隐藏任务栏图标**：收缩为小条时任务栏不显示 EzTxt，仅保留托盘图标；展开后恢复

**mini 球升级**
- 新增 mini 球**动画风格**：采用 4 张未压缩动画 GIF 轮换（仅蕾米埃尔 / 蕾米埃尔·夜主题生效），动画模式下隐藏数字角标、纯 GIF 球体；动画球为**正方形**（不裁剪画面）
- mini 球**单击**展开主页面，拖动移动球体

---

## 📄 License

本项目基于 [MIT License](./LICENSE) 开源。

---

<div align="center">

**Made with ❤️ by EzTxt**

</div>
