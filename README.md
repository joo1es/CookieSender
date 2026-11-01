# CookieSender

A cookie sending plug-in base on chrome manifest v3.

## 站内下载状态角标（site-status）

在 X / 小红书 / hentaiclub 的页面里，给每条帖子挂一个「是否已经下载过」的角标。

- 实现方式：`site-status.js` 只扫 `a[href]` 里的**帖子永久链接**，不解析站点卡片结构
  （class 是构建产物、X 还是虚拟列表，解析结构一改版就废）。
  链接先本地归一到统一形态（X → `/i/status/{id}`，小红书 → `/explore/{noteId}`）再查询。
- 请求：内容脚本不直连后端（会被 CORS 拦），统一交给 `background.js` 的
  `checkStatus` 转发到 `POST /api/get/status`，并在 service worker 内存里做短 TTL 缓存。
- 样式：走 `manifest.json` 的 `content_scripts.css` 注入，不使用内联样式
  （X 的 CSP `style-src` 会拦掉内联样式）。

### 状态口径

| 角标 | 含义 | 数据来源 |
| --- | --- | --- |
| 已收录 @图库 | 图库里还收着这篇 | `addon` 表（`checkCollected`） |
| 下载中 / 排队中 / 下载失败 | 队列运行态 | `downloadQueue` 表 |
| 已下载过 | 下过但图库已删，或当时判定跳过 | `downloadRecord`（success/skipped） |
| 已跳过 | 自动下载时判定跳过 | `downloadQueue` |
| ↓ 下载（可点） | 没下载过 | 无记录 |

**X 上的形态是「一个图标」而不是文字药丸**：挂在帖子底部操作栏
（回复 / 转帖 / 喜欢 / 查看 / 书签 / 分享）的**最后**，定位方式是「回复按钮最近的 `role="group"`」，
不依赖本地化的 `aria-label` 文案，也不依赖编译出来的 class 名。
未下载时是**两个**图标：闪电（自动下载）+ 下载箭头（打开详情），其余状态左移成一个图标。
尺寸是 CSS 里固定写死的 **38.5×38.5 方形**，不按旁边的「回复」按钮量 ——
那个按钮的 rect 是「图标 + 计数文字」的整宽（约 70px），量出来图标会变成一条宽药丸。
图标形态没有文字，所以状态说明放在 `title` 和 `aria-label` 里。

### 各站点挂在哪

| 站点 | 位置 | 说明 |
| --- | --- | --- |
| X | 帖子底部操作栏的最后（回复 / 转帖 / 喜欢 / 查看 / 书签 / 分享 之后） | 固定 38.5×38.5 方形图标按钮 |
| 小红书 | **仅笔记详情页**，日期右边 | 列表页 / 主页的卡片不挂：拿不到页面源码，点了也解析不了 |
| hentaiclub 列表 | 「[28P]」左边（`.item-num` 内最前） | 深底白图标，压在封面图上也能看清 |
| hentaiclub 详情 | 右侧浮动按钮栏 `#side-button ul` 最上方（新增一个 `li`） | 尺寸照抄站点自己的圆形按钮 |
| 微博 | 帖子底部「来源 / 时间」那一行末尾 | 时间链接本身就是指向自己的链接，最稳 |

小红书的「下载」点击时会把 `document.documentElement.outerHTML` 一起交给 background，
再经 `openDetailPage` 传给前端选人 / 详情 —— 这个站后端没有登录态，只能靠页面源码解析。
源码只在这条消息里走，不落盘。

前端**没开着**时深链带不动几 MB 的 HTML，所以 background 会先把它暂存到内存
（`pendingSources`，5 分钟 TTL），前端页面起来后通过 bridge 发 `takeSource` 取回
（`bridge.js` → `WORMHOLE_MESSAGE` → background）。页面内打开则直接随消息传递，
不再走这一趟。

| 图标 | 动作 |
| --- | --- |
| ⚡ 闪电 | 选人 → **直接入队自动下载**（`/get/queue/enqueue`），不打开详情 |
| ⬇ 下载箭头 | 选人 → 打开 browser 详情，人工确认后再推 |

两个按钮都会把**帖子作者**一起交出去（`user`），选人面板据此默认匹配图库。
必须由扩展取：帖子永久链接归一化后是 `x.com/i/status/{id}`，里面没有作者，
DOM 的 `[data-testid="User-Name"]` 里才有 —— 页面里取一下，比让后端反查推文接口快得多。

优先级：已收录 > 下载中 > 排队中 > 失败 > 跳过 > 已下载过 > 未下载（显示下载按钮）。

「下载」按钮点了会跳到前端，**先弹选人面板确认目标图库**，确认后才进 browser 详情：

- 已经开着 kan.tu：注入 `window.__openBrowserDetail(url, source, user)` 在页面内打开，不刷新；
- 没开着：新标签打开 `https://kan.tu/?browserDetail=<帖子链接>&browserUser=<作者>`，
  前端启动时自己弹出，并把参数从地址栏抹掉（前端 `components/Browser/Index.vue` +
  `router/index.ts` 的根路径 redirect）。

「已经开着」只认 **kan.tu**：`localhost` / `127.0.0.1` 只当本机开发页（vite 在 5000）
的可注入备选，注不进去就另开新标签，绝不把它导航去深链 —— 否则别的电脑上随便一个本地服务
都会被当成前端抢走。换机器、换网络都只有 `https://kan.tu/` 这一条路。

选人面板（`components/Browser/Components/TargetPicker.vue`）直接复用站内已有的 `o-user-select`
（搜索 / 拼音 / 虚拟列表 / 勾选态都是它的），这里只提供候选数据、标题和「中转站」入口。
候选来自 `/api/gallery/users`，选中后写进 store 的 `browser.targetGallery`，详情推送就用它，
关掉弹层即清空。

**默认匹配**：面板拿 `user` 问一次 `POST /api/gallery/resolve`（后端按订阅源 url ↔ folder、
图库 username / folder / title / 别名 / 关键词逐级匹配），命中的置顶高亮，顶部还会列几个
候选供一键切换；没命中就退回原来的「上次选过的排第一」。

### 用户主页的「打开列表」

在某个人的主页（X 的 `/{用户名}`，含 `/with_replies`、`/media` 等；小红书的 `/user/profile/{id}`），
右下角会出现一个「打开列表」浮动按钮，点了把这个主页送进前端的 browser **列表**模式，
可以整页勾选 / 自动下载：

- 同样先过选人面板，决定列表里自动下载的目标图库（标题会变成「列表下载到哪个图库」）；
- 小红书这条路会就地取当前页源码一起传过去 —— 后端没有登录态，抓不到该页面；
- X 的按钮会**按右下角 Grok / 聊天抽屉的实际位置动态上移**（`avoidBottomDock` 读 `#layers`
  里那两个底部抽屉的矩形，抽屉收起就自动回落），不再写死 px，避免压住 Grok 按钮；
- 前端入口：`window.__openBrowserList(url, source, user)`，深链是
  `?browserList=<主页链接>&browserUser=<账号>`（X 取 handle，小红书取 uid，同样用于默认匹配）。

### 调试

- 后端：`POST /api/get/status`，body `{ "hrefs": ["https://x.com/i/status/123456"] }`，
  返回 `{ code, success, data: { items: [{ href, state, gallery, ... }] } }`。
- 扩展：chrome://extensions 重新加载后打开目标站点，角标由内容脚本注入；
  排查时看页面的控制台（内容脚本日志）与扩展 service worker 的控制台（请求日志）。
