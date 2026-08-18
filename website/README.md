# Crank 官网（静态页）

纯 HTML + CSS + 一段内联 JS，无构建步骤，双击 `index.html` 或任意静态服务器托管即可。

## 换素材

- **大图**：把应用截图存成 `hero.png`（1600×1000 左右即可，页面会自适应宽度），
  覆盖现在的占位图。占位源文件是 `hero-placeholder.svg`，可改后重新生成。
- **开始使用按钮**：`https://github.com/irrwood/Crank/releases/latest`。
- **GitHub 链接**：`https://github.com/irrwood/Crank`。
- **品牌图标**：`icon.svg` 来自 `public/app-icon.svg`。

## 中英文

页面文案以 `data-zh` / `data-en`（标签列表用 `data-zh-html` / `data-en-html`）
成对写在元素上，右上角胶囊切换。选择存在 `localStorage`（`crank-site-lang`），
首次访问跟随浏览器语言，兜底中文。加新文案时记得两个属性都写。

## 风格

参考 rakazo.com：`#fdfdfd` 底、墨色文字、`#2563eb` 蓝色强调、大圆角卡片、
柔和阴影。所有颜色都集中在 `styles.css` 顶部的 `:root` 变量里。
