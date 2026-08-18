# Community listing copy

Written to be pasted into the publishing form. Every claim here is something
the plugin and the app actually do today — if a capability changes, this file
changes with it.

---

## Tagline

> Every screen of your running app, as editable Figma layers.

Alternatives, same idea, different emphasis:

> Point it at the app you are already running. Get every screen in Figma.

> Your app walks itself into Figma.

---

## Description

**Crank is the desktop app. This plugin is the half that runs inside Figma —
it does nothing on its own.**

Crank starts your project, opens every screen it can reach, and sends them here
as real Figma layers: frames, text, vectors and images you can select and edit,
not screenshots.

**It finds the screens itself.** You give it a folder or an address, not a list
of URLs. Routes, tabs and overlays each come back as a page, and it records how
it reached each one — including the screens that take a click to get to. A theme
or language switch is treated as the same page wearing a different look.

**It runs the real thing.** Your project is started and rendered in Chromium, so
what arrives is what the browser actually laid out — the real typefaces, the
real spacing, the real wrapping. When a font cannot be loaded, Crank says which
one rather than quietly substituting it.

**It can use the app you already have open.** Screens that only exist behind a
login, or that draw their content from a running process, can be captured from
the app as it is rather than from an empty copy of its interface.

**A second run updates the same frames.** Each page remembers which frame it
became, so scanning again edits those frames instead of drawing a new set beside
them. Rename a heading or restyle a component and the page keeps its identity.

**It stays on your computer.** The plugin talks to `localhost` and nothing else.
Your code is never uploaded; the layers you see are what you chose to send.

### What you need

- The Crank desktop app, running on the same computer.
- A project it can start — npm and pnpm projects run their own dev script,
  Electron projects serve their renderer, and Python or Ruby projects use the
  command their Dockerfile, Procfile or README already declares. A folder of
  static HTML needs nothing at all.

### What it does not do

- It does not write to your Figma file beyond the frames it creates and updates.
- It does not read your source to guess a layout. It renders the project and
  measures the result.
- Some CSS does not survive the trip yet — gradients, backdrop blur and
  generated content among them. What arrives is what was measured, and what was
  substituted is named.

---

## Notes for whoever submits this

- The desktop app's interface is currently in Chinese. If the listing is in
  English, say so, or someone will install both and be surprised.
- Category and tags are chosen in the form, not here.
- `icon-128.png` is in this folder. The 1920×960 cover still has to be made.

---

## 中文版

### 一句话

> 你正在跑的应用，每一个界面都变成 Figma 里可编辑的图层。

### 描述

**Crank 是桌面端，这个插件是它在 Figma 里的另一半——单独装是不工作的。**

Crank 把你的项目跑起来，走遍它能到达的每一个界面，然后把它们送到这里，变成真正的
Figma 图层：可以选中、可以改的画框、文字、矢量和图片，不是截图。

**界面是它自己找的。** 你给的是一个文件夹或一个地址，不是一份 URL 清单。路由、标签页、
弹层各算一个页面，它还会记下自己是怎么到达每一页的——包括那些要点一下才出现的界面。
深色模式和切换语言不算新页面，会并进同一页的不同外观。

**跑的是真东西。** 项目在 Chromium 里真实渲染，所以送过来的就是浏览器真正排出来的样子：
真实的字体、真实的间距、真实的换行。某个字体加载不到时，Crank 会告诉你是哪一个，而不是
悄悄换掉。

**可以直接用你已经开着的那个应用。** 需要登录才能到达、或者内容来自某个运行中进程的界面，
可以从应用本身捕获，而不是从一个空壳界面里。

**再扫一次会更新同一批画框。** 每一页都记得自己变成了哪个画框，所以重新扫描是在改那些
画框，不是在旁边新画一套。改个标题、换个组件样式，这一页仍然是这一页。

**东西不出你的电脑。** 插件只和 `localhost` 通信。你的代码不会被上传，进到 Figma 的只有
你选择送过去的那些图层。

### 需要什么

- Crank 桌面端，跑在同一台电脑上。
- 一个它能启动的项目——npm 和 pnpm 项目读自己的 dev 脚本，Electron 项目只起渲染进程，
  Python、Ruby 这类读 Dockerfile、Procfile 或 README 里已经写好的命令。一个静态 HTML
  文件夹什么都不需要。

### 它不做什么

- 除了它创建和更新的那些画框，不动你 Figma 文件里的别的东西。
- 不去读你的源码猜版式。它把项目跑起来，量真实结果。
- 有些 CSS 目前还带不过来，比如渐变、背景模糊、伪元素生成的内容。送到的是量到的，
  被替换掉的会点名告诉你。
