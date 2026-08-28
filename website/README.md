# Crank 官网（静态页）

纯 HTML + CSS + 一段内联 JS，无构建步骤，双击 `index.html` 或任意静态服务器托管即可。

## 换素材

- **中间大图**：现在是操作演示视频（YouTube `FXM977ig0UY`）。换片只改
  `index.html` 里 `.hero-shot iframe` 的视频 ID；想换回静态图就把 `iframe`
  换成 `<img src="./hero.png">`，样式已经都写好了。
- **开始使用按钮**：`https://github.com/irrwood/Crank/releases/latest`。
- **GitHub 链接**：`https://github.com/irrwood/Crank`。
- **品牌图标**：`icon.svg` 来自 `public/app-icon.svg`。
- **流程图**：`screen-flow.png`，「页面怎么到达」那节卡片下面那张，截自一次真实
  扫描。换图直接替换文件；`<img>` 上的 `data-zh-alt` / `data-en-alt` 要一起改，
  切语言时 alt 会跟着换。

## 版块

- **支持什么**：能扫什么（Web / Electron / SwiftUI / 本地优先）。
- **图层去哪里**：扫完之后送到哪（Figma / Paper / HTML 交接页）。三栏用
  `.supports-grid--three`，Paper 标题后面那个「新」是 `.tag-new`。
- **常见问题**：`.faq`，用原生 `<details>` 折叠，不需要 JS。加一条就复制一个
  `<details>` 块；`summary` 和里面的 `<p>` 都要带 `data-zh` / `data-en`，否则
  切语言时那一条不会跟着变。

## 中英文

页面文案以 `data-zh` / `data-en`（标签列表用 `data-zh-html` / `data-en-html`）
成对写在元素上，右上角胶囊切换。选择存在 `localStorage`（`crank-site-lang`），
首次访问跟随浏览器语言，兜底中文。加新文案时记得两个属性都写。

## 风格

参考 rakazo.com：`#fdfdfd` 底、墨色文字、`#2563eb` 蓝色强调、大圆角卡片、
柔和阴影。所有颜色都集中在 `styles.css` 顶部的 `:root` 变量里。
