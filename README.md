# Crank

**把正在运行的应用，扫成一份可编辑的 Figma 图层。**

不是截图——是真的文字、矢量、图片和布局，选中就能改。第二次扫描会更新同一批画框，而不是在旁边再画一份。

*Crank walks a running application, finds every screen it can reach, and hands you those screens as editable Figma layers — not screenshots. It runs the real interface in Chromium and reads what the browser actually laid out.*

---

## 下载

**[Crank 0.1.0 · macOS (Apple Silicon)](https://github.com/irrwood/Crank/releases/latest)** · 126MB

早期测试版。Intel Mac 暂时没有。

### 第一次打开

这个版本**没有签名和公证**，macOS 会拦下来，提示"已损坏，无法打开"——文件是好的，是 Gatekeeper。两种方式之一：

- 右键点 `Crank.app` → 打开 → 再点一次「打开」
- 或者终端里跑一次：

```bash
xattr -dr com.apple.quarantine /Applications/Crank.app
```

---

## 怎么用

**把项目文件夹拖进窗口。** Crank 会读项目自己的启动方式跑起来——npm 和 pnpm 项目用它自己的 dev 脚本，Electron 只起界面不弹窗口，Python、Ruby 这类读 Dockerfile、Procfile 或 README 里已经写好的命令。它不会自己编一条启动命令：跑歪了的项目产出的是一份误导人的扫描，不如老实报错。

然后它走遍每一个能到达的页面。路由、标签页、弹层各算一页；深色模式和切换语言不是新页面，会并进同一页的不同外观。每一页都记着"从头开始怎么再回到这里"，所以要点几下才到的页面不是只能撞见一次。

拿到结果后，导出一份自带图片的 HTML 交接页，或者把图层直接送进 Figma。

### 没有文件夹可拖的时候

- **拖一个装好的 `.app`** — 拿到构建版、没有源码的人（多数设计师）就是这种情况。Crank 会带调试端口打开它、扫完再替你关掉。目前支持基于 Electron 的桌面应用
- **扫一个地址** — 项目已经跑起来了就填地址。发现过程只说 HTTP，所以项目用什么写的无所谓
- **连上你正在用的那个应用** — 单独启动界面往往只有空壳，真正有数据的页面在你手上那个进程里。带调试端口启动它，Crank 连过去扫那一份
- **你点一遍，它记录** — 要登录、要填表单才到得了的页面，手动走一次就行

---

## 送进 Figma

Figma 那半边是一个插件。应用左下角「Figma 插件」里有完整步骤：

1. 拿一个配对码
2. 在 Figma 里导入插件（面板里有「在访达中显示插件」）
3. 把码输进去——这台 Mac 就记住了，之后不用再输

---

## 你的数据

扫描结果、项目清单、Figma 连接**全部留在本机**（`~/Library/Application Support/Crank/`），不上传任何地方。

捕获时只读页面已经画出来的东西：会写入的请求一律拦掉，第三方脚本和数据调用也拦掉，读起来像"删除""退出登录""支付"的按钮不点。**它不会改你的项目。**

---

## 现在的限制

- 只有 Apple Silicon 版本
- 目标是 web 和 Electron 应用；纯原生 macOS 应用（没有网页运行时的）扫不了，Crank 会直说
- 大项目扫一遍要几分钟
- 界面语言跟随系统，中英文都还在打磨
- 源码暂未公开

---

## 反馈

用出问题、扫出来不对、或者哪一页没抓到——[开个 issue](https://github.com/irrwood/Crank/issues)，把报错原文贴上。应用里的报错会尽量说清是哪一页、哪一步出的问题，那句话对定位很有用。

Apache-2.0
