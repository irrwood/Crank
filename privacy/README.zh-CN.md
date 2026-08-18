# Crank 被允许做什么

Crank 有三条承诺：不往你的项目里写任何东西、扫描结果不离开你的机器、不向任何地方上报。承诺的价值取决于能不能被核对，所以真正执行这三条的文件都在这里。

这些是**应用实际运行的那份代码的副本**——不是摘要，也不是重写。[`verify.sh`](verify.sh) 会把它们和你下载的 `Crank.app` 里的副本逐字节对比：

```sh
./verify.sh /Applications/Crank.app
```

Electron 把代码以普通 JavaScript 的形式放在 `app.asar` 里，没有压缩也没有混淆，所以这个对比是精确的：这里和某个版本之间只要有出入，就会打印一行 `DIFFERS`。

[English](README.md)

---

## 每条承诺落在哪个文件

### 不往你的项目里写东西

[`electron/request-policy.cjs`](electron/request-policy.cjs) 决定一次扫描允许发出的每一个请求。不是 `GET` 或 `HEAD` 的一律取消——就这么一条，一个函数，一分钟能读完。第三方脚本和数据调用同样取消，所以页面没法在被扫描时跑别人的代码。

[`electron/state-discovery.cjs`](electron/state-discovery.cjs) 靠点击走遍应用，其中 `isDestructiveLabel` 是它拒绝点的词表——删除、退出登录、支付、发布，以及对应的中英文写法。一个风险配两道防线，因为爬的是别人真实的应用。

测试就是这些行为的断言：

```sh
node --test electron/request-policy.test.cjs electron/page-origin.test.cjs
```

### 不会跑到你机器的其它地方去

[`electron/page-origin.cjs`](electron/page-origin.cjs) 决定"什么算被扫的这个应用"。从磁盘加载的页面没有 origin——浏览器对所有这类页面都报 `null`——所以用"界面所在的那个文件夹"顶替，之外的一律拒绝。扫一个装好的应用，不可能顺着链接走进你的主目录。

### 数据不出本机

[`electron/figma-bridge.cjs`](electron/figma-bridge.cjs) 是 Crank 唯一启动的服务器。它只监听 `localhost`，只和一个对象说话：同一台电脑上的 Figma 插件。[`figma-plugin/manifest.json`](figma-plugin/manifest.json) 里声明插件唯一允许访问的地址是 `http://localhost:38457`——这条白名单是 **Figma 自己强制**的，不是我们说了算。

应用里没有遥测、没有统计、没有崩溃上报、没有更新检查。这句话你可以在这个目录里 grep 验证，也可以解开整个 `app.asar` 验证。

**一处必须说清的例外。** [`electron/html-snapshot.cjs`](electron/html-snapshot.cjs) 会重新抓取被扫页面**自己已经加载过**的字体和图片，好让交接页把它们带在身上，而不是指向某个字体托管站。所以一次扫描确实会向这些地址发请求——就是你用浏览器打开那个页面时它本来就会请求的那些，不多一个。

### 扫描结果存在哪

[`electron/inventory-registry.cjs`](electron/inventory-registry.cjs) 把一切写进 `~/Library/Application Support/Crank/`。把项目移出列表就会删掉它的扫描结果；删掉那个文件夹就等于全部删除。你的项目目录里不会被写入任何东西。

### 界面能调用什么

[`electron/preload.cjs`](electron/preload.cjs) 就是窗口被授予的全部能力——一个文件、一张清单。不在上面的，界面做不到。

### 从页面里读走什么

[`electron/browsing-session.cjs`](electron/browsing-session.cjs) 是一次扫描对页面做的全部动作：等待、滚动、读取、截图、点击。[`electron/figma-tree.cjs`](electron/figma-tree.cjs) 是从中读走的东西——几何、文字、颜色，以及页面画出来的图片。[`electron/cdp-session.cjs`](electron/cdp-session.cjs) 是同样的事，但针对你已经在运行的应用，走它的调试端口，请求策略一视同仁。

[`electron/app-bundle.cjs`](electron/app-bundle.cjs) 是拖进来的 `.app` 怎么被打开的：你真实的那个应用、带着你真实的数据，用调试端口启动，扫完关掉。它**故意不用干净的配置文件**——一个登出状态的应用只能扫出登录页——这也正是它扫出来的东西哪里都不发的原因。

---

## 这里没有什么

应用的其余部分：扫描流水线、界面、Figma 插件的渲染逻辑。那些暂未公开。这个目录是"关于你的数据的声明能被核对"的那一部分，就这个目的而言它是完整的——这里如果写着某个请求会被取消，那就是取消它的那段代码。
