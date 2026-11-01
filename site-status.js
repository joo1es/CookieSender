// site-status.js - 在站点页面上给帖子挂「是否已下载」角标
//
// 三条设计原则，改代码前先看：
// 1. 不解析站点的卡片结构（class 名是构建产物、X 还是虚拟列表，站点一改版就废）。
//    只认「帖子永久链接」这种多年不变的 URL 形态，扫 a[href] 即可，
//    图片卡 / 纯文字卡 / 转发卡一次全覆盖。
// 2. 链接先本地归一化再查：X 统一成 /i/status/{id}、小红书统一成 /explore/{noteId}。
//    这样同一条内容在时间线 / 搜索页 / 详情页拿到的是同一个缓存键，
//    也和后端归档里存的 postKey 口径一致。
// 3. 样式全部走 manifest 的 content_scripts.css（扩展注入的 CSS 不受页面 CSP 限制）。
//    这里只加 class，绝不写内联 style —— X 的 style-src 会把内联样式直接拦掉。

(() => {
    'use strict'

    /** 单次批量查询条数，与后端 MAX_HREFS 对齐 */
    const BATCH_SIZE = 200
    /** 攒批延迟：一次滚动会抖出几十个链接，攒一下只发一次请求 */
    const FLUSH_DELAY = 250
    /** DOM 扫描节流 */
    const SCAN_THROTTLE = 300
    /** 运行态（排队/下载中）的复查间隔 */
    const POLL_INTERVAL = 5000
    /** 「没下载过」的复查间隔：用户可能刚在别处下完，不能一直当它没有 */
    const STALE_NONE = 90 * 1000
    /** 缓存上限，超了整体丢弃——宁可重查一次，也不能让内容脚本常驻吃内存 */
    const MAX_CACHE = 800

    /**
     * X 上不是「用户主页」的一级路径。
     * 这些页面形如 /home、/explore，结构上和 /{用户名} 没法区分，只能列出来排除。
     */
    const RESERVED_X_PATHS = new Set([
        'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose',
        'i', 'login', 'logout', 'signup', 'jobs', 'tos', 'privacy', 'about', 'download',
        'account', 'premium', 'verified', 'lists', 'bookmarks', 'communities', 'topics',
        'connect_people', 'following', 'followers', 'help', 'rules', 'intent', 'share',
        'hashtag', 'search_advanced', 'community', 'moments', 'spaces', 'events', 'news'
    ])

    /* ------------------------------------------------------------------ */
    /* 站点配置                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 从 anchor 往上几层找某个选择器。
     *
     * hentaiclub 的 `[28P]` 不一定和帖子链接共用一个卡片容器（主题重写过几次），
     * 直接 `closest('.item').querySelector('.item-num')` 命中不了 —— 逐层向上找最稳。
     */
    function findNearby(anchor, selector, depth = 6) {
        let node = anchor
        for (let i = 0; i < depth && node; i++) {
            let found = null
            try {
                found = node.querySelector?.(selector) || null
            } catch {
                found = null
            }
            if (found) return found
            node = node.parentElement
        }
        return null
    }

    /**
     * 让详情页侧边栏里的按钮和站点自己的圆形按钮一样大。
     *
     * go-top / 随机那些 li 的尺寸是主题定的，我们新建的 li 只有图标那么点高，
     * 并排一眼就能看出是外挂的 —— 量第一个原生 li 的宽高照抄过去。
     */
    function matchSideButtonMetrics(bar, item, badge) {
        try {
            const sample = bar.querySelector('li:not(.wh-side-item)')
            const rect = sample?.getBoundingClientRect()
            if (!rect || rect.width < 16 || rect.height < 16) return
            const w = `${Math.round(rect.width)}px`
            const h = `${Math.round(rect.height)}px`
            const set = (el, prop, value) => el.style.setProperty(prop, value, 'important')
            set(item, 'width', w)
            set(item, 'height', h)
            set(item, 'padding', '0')
            set(item, 'box-sizing', 'border-box')
            set(badge, 'width', w)
            set(badge, 'height', h)
            set(badge, 'min-height', h)
            set(badge, 'padding', '0')
            set(badge, 'margin', '0')
        } catch {
            // 量不到就按样式表兜底
        }
    }

    const SITES = [
        {
            name: 'x',
            test: hostname => /(^|\.)(x|twitter)\.com$/.test(hostname),
            // 帖子永久链接：时间戳那个 <a> 里一定带 /status/<数字>
            selector: 'a[href*="/status/"]',
            /** 页面链接 → 归一化链接；认不出来返回 null */
            normalize(url) {
                const matched = url.match(/\/(?:[^/]+|i\/web)\/status\/(\d+)/)
                return matched ? `https://x.com/i/status/${matched[1]}` : null
            },
            /** 角标容器：挂到「日期行」（时间 · 查看数 那一整行）的末尾 */
            hostFor(anchor) {
                return findFlexRow(anchor) || anchor.parentElement || null
            },
            /**
             * 只认「时间戳链接」作为锚点。
             * 同一条帖子在 DOM 里有多个入口（媒体图 / 时间戳 / 查看数），
             * 媒体链接的父容器是整块图片区（flex-grow:1 + width/height:100%），
             * 角标挂进去等于扔进一个满屏盒子，肉眼看不到 —— 主帖就是这样丢的。
             */
            requireTime: true,
            iconOnly: true,
            /** 「自动下载」闪电按钮只给 X：别的站点详情页只有一个位置，两个图标会挤 */
            autoBadge: true,
            inline: true,
            /**
             * 挂载点：帖子底部操作栏（回复 / 转帖 / 喜欢 / 查看 / 书签 / 分享）的最后。
             *
             * 找法是「回复按钮最近的那个 role=group」—— 不依赖 aria-label 的文案
             * （它是本地化的：「6 回复、4 喜欢」），也不依赖编译产物里的 class。
             * 尺寸和间距统一由 CSS 负责（.wh-badge--icon.wh-badge--site-x）：
             * 这里量不到能用的值 —— 原生按钮的 rect 是「图标 + 计数文字」的整宽，
             * 照抄过来图标会变成一条宽药丸。
             */
            place(anchor, badge) {
                const article = anchor.closest('article')
                if (!article) return false

                const reply = article.querySelector('[data-testid="reply"]')
                const bar = reply?.closest('[role="group"]') || null
                if (!bar) return false

                // 「自动下载」按钮排在「下载」图标左边
                if (badge.dataset.whAuto === '1') {
                    const main = article.querySelector(
                        `[data-wh-badge="1"][data-href="${badge.dataset.href}"]:not([data-wh-auto="1"])`
                    )
                    if (main && main.parentElement === bar) {
                        main.insertAdjacentElement('beforebegin', badge)
                        return true
                    }
                    return false
                }

                bar.appendChild(badge)
                return true
            },
            /** 当前页是某个人的主页吗？是就返回可交给前端列表模式的 URL */
            profileUrl() {
                // 支持 /{user} 以及 /{user}/with_replies|media|likes 这几种「某个人的列表」
                const matched = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|media|likes|highlights|articles))?\/?$/)
                if (!matched) return null
                if (RESERVED_X_PATHS.has(matched[1].toLowerCase())) return null
                return `${location.origin}/${matched[1]}${matched[2] ? '/' + matched[2] : ''}`
            },
            /**
             * 这条帖子的作者 handle。
             *
             * 为什么要在页面里取：自动下载只把推文 id 交出去（`/i/status/<id>`），
             * 后端要拿账号只能反查一次推文接口 —— 而 DOM 里「显示名」那一块的结构里
             * 作者主页链接本来就是现成的，取一下比发请求快几个数量级，也不受反爬影响。
             *
             * 只在 `[data-testid="User-Name"]` 里找，不扫整篇文章：转推 / 引用会带进
             * 被引用者的名字，扫全文可能把别人的 handle 挂到这条帖子上。
             */
            authorOf(anchor) {
                const article = anchor?.closest('article')
                if (!article) return ''
                const scope = article.querySelector('[data-testid="User-Name"]') || article
                for (const link of scope.querySelectorAll('a[href]')) {
                    const href = link.getAttribute('href') || ''
                    // /handle、/handle/、/handle?x=1 都是主页链接；/handle/status/1 也算，
                    // 但它不会是这一块里的第一个链接（显示名和 @handle 排在前面）
                    const matched = href.match(/^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/)
                    if (!matched) continue
                    const handle = matched[1]
                    if (RESERVED_X_PATHS.has(handle.toLowerCase())) continue
                    return handle
                }
                return ''
            }
        },
        {
            name: 'xiaohongshu',
            test: hostname => /(^|\.)xiaohongshu\.com$/.test(hostname),
            selector: 'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"], a[href*="/user/profile/"]',
            normalize(url) {
                const matched =
                    url.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i) ||
                    // 用户主页里的笔记链接是 /user/profile/{uid}/{noteId}，必须两段都有，
                    // 否则头像链接（只有 uid）会被误判成一条笔记
                    url.match(/\/user\/profile\/[^/?#]+\/([0-9a-f]{24})/i)
                return matched ? `https://www.xiaohongshu.com/explore/${matched[1]}` : null
            },
            /**
             * 只在笔记详情页挂。
             * 列表页 / 主页的卡片点下载时拿不到页面源码，后端没有登录态也抓不到，
             * 解析必然失败 —— 与其给个点了没反应的按钮，不如不出现。
             */
            detailOnly: true,
            iconOnly: true,
            /** 点下载时把整页 HTML 一起交出去（这个站只能靠源码解析） */
            wantsSource: true,
            /** 当前是不是笔记详情页：是就返回可查询的笔记链接 */
            detailHref() {
                const matched = location.pathname.match(/^\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)
                if (!matched) return null
                return `https://www.xiaohongshu.com/explore/${matched[1]}`
            },
            /**
             * 笔记作者的 uid。
             *
             * 笔记链接 `/explore/<noteId>` 里没有作者（后端也只按 noteId 入库），
             * 想默认匹配图库只能从页面上取：作者区是 `.author-wrapper`，里面的头像和昵称
             * 都是 `/user/profile/<uid>` 链接。订阅源 url 存的正是这个 uid，能直接对上。
             *
             * 不能全页扫 `a[href*="/user/profile/"]`：评论区、推荐位都有一堆，
             * 页面先渲染到谁就命中谁。所以限定在作者区，取不到才退到整页第一个。
             */
            authorOf() {
                const scope = document.querySelector('.author-wrapper') ||
                    document.querySelector('.note-content') ||
                    document
                const matched = (scope.querySelector('a[href*="/user/profile/"]')?.getAttribute('href') || '')
                    .match(/\/user\/profile\/([0-9a-zA-Z]+)/)
                return matched ? matched[1] : ''
            },
            /**
             * 挂在日期（「6小时前 上海」）右边。
             *
             * 试过挂「更多」左边，要跟那个 span 的块级 div 斗布局（会换行 / 被 space-between
             * 甩到中间），而日期这一行是干净的 inline 结构，插在 <span class="date"> 后面
             * 就完事，不需要动任何站点布局。
             */
            place(anchor, badge) {
                const date = document.querySelector('.bottom-container .date') ||
                    document.querySelector('.bottom-left .date')
                if (!date || !date.parentElement) return false
                date.insertAdjacentElement('afterend', badge)
                return true
            },
            hostFor(anchor) {
                return anchor?.closest('section.note-item, .note-item, [data-note-id]') ||
                    anchor?.closest('section') ||
                    null
            },
            profileUrl() {
                const matched = location.pathname.match(/^\/user\/profile\/[^/?#]+/)
                if (!matched) return null
                return `${location.origin}${location.pathname}${location.search}`
            },
            inline: false
        },
        {
            name: 'hentaiclub',
            test: hostname => /(^|\.)hentaiclub\.(net|com)$/.test(hostname),
            // 列表页是 WordPress 瀑布流，帖子链接就是 .item-link
            selector: '.item .item-link, #masonry .item-link',
            normalize(url) {
                try {
                    const parsed = new URL(url)
                    if (!/hentaiclub\./i.test(parsed.hostname)) return null
                    // 这个站没有 urlRule，后端用「清洗后的 URL 取 md5」做键，
                    // 所以这里只去掉 hash，query 一律保留 —— 由后端统一清洗，
                    // 本地多删一个参数反而会和入库时算出的键对不上
                    parsed.hash = ''
                    return parsed.toString()
                } catch {
                    return null
                }
            },
            iconOnly: true,
            /** 详情页没有列表链接，直接拿当前地址当目标 */
            detailHref() {
                // 详情页 URL 形如 /r18/70915.html；列表页是 /r18/、/tag/xx/page/2 这种。
                // 按 URL 判定最稳 —— 靠 #side-button 判断会失败（有些主题详情页没有浮动栏）
                if (!/\/\d+\.html?$/i.test(location.pathname)) return null
                return `${location.origin}${location.pathname}${location.search}`
            },
            place(anchor, badge) {
                // 详情页（没有 anchor）：塞进右侧浮动按钮栏的最上方，多一个 li
                if (!anchor) {
                    const bar = document.querySelector('#side-button ul') || document.querySelector('#side-button')
                    if (!bar) {
                        // 浮动栏不在（部分主题只在列表页给）：挂到标题上，别让按钮凭空消失
                        const title = document.querySelector('.entry-title, .post-title, article h1, h1')
                        if (!title) return false
                        title.appendChild(badge)
                        return true
                    }
                    badge.dataset.whSlot = 'side'
                    if (bar.tagName === 'UL') {
                        let item = null
                        for (const node of bar.children) {
                            if (node.classList.contains('wh-side-item') && node.dataset.href === badge.dataset.href) {
                                item = node
                                break
                            }
                        }
                        if (!item) {
                            item = document.createElement('li')
                            item.className = 'wh-side-item'
                            item.dataset.href = badge.dataset.href
                            bar.insertBefore(item, bar.firstChild)
                        }
                        item.appendChild(badge)
                        // 尺寸照抄站点自己的圆形按钮（go-top / 随机），否则一眼就能看出是外挂的
                        matchSideButtonMetrics(bar, item, badge)
                    } else {
                        // 没有 ul 的极端情况：直接贴进栏里
                        bar.insertBefore(badge, bar.firstChild)
                    }
                    return true
                }

                // 列表页：放在「[34P] 🖼」这个 span 的末尾 —— 也就是图片图标的右侧。
                // 这一格压在封面图上，所以不用底色，靠白色图标 + 投影保证可读
                badge.dataset.whSlot = 'num'
                const num = findNearby(anchor, '.item-num')
                if (num) {
                    num.appendChild(badge)
                    return true
                }

                // 没找到张数标签：退一步贴在卡片链接前面（同一张卡片内，至少看得见）
                if (anchor.parentElement) {
                    anchor.insertAdjacentElement('beforebegin', badge)
                    return true
                }
                return false
            },
            /**
             * 归档 / 分类页把「打开列表」按钮直接放进标题里，
             * 比右下角的浮标更贴近站点自己的版式。
             */
            listJob() {
                // 主题版本不同，标题有时是 h3.archive-title、有时是 .archive-title > h3
                const title = document.querySelector('h3.archive-title') ||
                    document.querySelector('.archive-title h3') ||
                    document.querySelector('.archive-title')
                if (!title) return null
                return { url: `${location.origin}${location.pathname}${location.search}`, host: title }
            },
            hostFor(anchor) {
                return anchor?.closest('.item') || anchor?.parentElement || null
            },
            // place 失败时退回「封面左上角」的角标形态 —— 至少看得见，而不是悄悄不挂
            inline: false
        },
        {
            name: 'weibo',
            test: hostname => /(^|\.)(weibo\.com|weibo\.cn)$/.test(hostname),
            /**
             * 微博的帖子链接是 `weibo.com/{uid}/{bid}`（没有 /status/），
             * CSS 选择器写不出这种形态，所以先按域名粗筛，再在 normalize 里用正则校验；
             * 顺带覆盖 `m.weibo.cn/detail/{id}` 和 `/status/{id}`。
             */
            selector: 'a[href*="weibo.com/"], a[href*="weibo.cn/"]',
            normalize(url) {
                try {
                    const parsed = new URL(url, location.origin)
                    if (!/(^|\.)(weibo\.com|weibo\.cn)$/.test(parsed.hostname)) return null

                    // 只认帖子：/{uid}/{bid}、/detail/{id}、/status/{id}
                    const isPost =
                        /^\/\d{5,}\/[A-Za-z0-9]{5,}$/.test(parsed.pathname) ||
                        /^\/(?:detail|status)\/\d{6,}$/.test(parsed.pathname)
                    if (!isPost) return null

                    // 和 hentaiclub 一样：后端没有这个站的 urlRule，用「清洗后的 URL 取 md5」
                    // 当键。所以只去 hash，query（?pagetype=homefeed 这类）留给后端清洗
                    parsed.hash = ''
                    return parsed.toString()
                } catch {
                    return null
                }
            },
            iconOnly: true,
            /**
             * feed 里的帖子链接带 `?pagetype=homefeed`，详情页不带。
             * 后端清洗只删固定名单（utm / from / ref …），删不到 pagetype，
             * 两边算出来的 md5 键就不同 —— 所以两个形态都拿去查一次。
             */
            variants(href) {
                const bare = href.split('?')[0]
                return bare && bare !== href ? [href, bare] : [href]
            },
            /**
             * 挂在帖子底部「来源 / 时间」那一行的末尾。
             * 微博的时间本身就是一条指向自己的链接，它所在的容器就是最稳的锚点。
             */
            place(anchor, badge) {
                const from = anchor.closest('.from, .woo-box-flex, .card-footer') || anchor.parentElement
                if (!from) return false
                from.appendChild(badge)
                return true
            },
            hostFor(anchor) {
                return anchor?.closest('.card-wrap, .card, article') || anchor?.parentElement || null
            },
            inline: true
        }
    ]

    const site = SITES.find(item => item.test(location.hostname))
    if (!site) return

    /**
     * 排查开关：地址栏加 ?wh-debug=1 打开（例如 https://x.com/home?wh-debug=1）。
     * 站点改版导致角标不出现时，先开它看控制台里「扫到几条链接 / 挂到了哪个节点」。
     */
    const DEBUG = /(?:^|[?&])wh-debug=1/.test(location.search)
    const dbg = (...args) => { if (DEBUG) console.log('[虫洞]', ...args) }

    /* ------------------------------------------------------------------ */
    /* 状态                                                                */
    /* ------------------------------------------------------------------ */

    /** href -> 服务端返回的状态对象 */
    const results = new Map()
    /** href -> 拿到这条结论的时刻（「没有」的结论要到期复查） */
    const checkedAt = new Map()
    /** 已经问过（含在途）的 href，避免同一批里重复入队 */
    const asked = new Set()
    /** 待发请求 */
    const pending = new Set()
    /** href -> 角标元素 */
    const badges = new Map()
    /** href -> 「自动下载」按钮元素（只有图标形态的站点才有） */
    const autoBadges = new Map()
    /** href -> 挂载时用的锚点元素：锚点变了（媒体图 → 时间戳）就要重挂 */
    const badgeAnchors = new Map()

    let flushTimer = null
    let scanTimer = null
    let pollTimer = null
    let stopped = false
    /** 主页上的「打开列表」浮动按钮 */
    let listButton = null
    let listButtonUrl = ''

    /**
     * 扩展重载 / 更新后，旧页面里的脚本上下文立即失效（chrome.runtime.id 变 undefined），
     * 之后每次 sendMessage 都会抛 "Extension context invalidated."。
     * 这时应该整体停掉，而不是每 300ms 扫描一次、每 5s 轮询一次地反复报错。
     */
    function stop() {
        if (stopped) return
        stopped = true
        try { observer.disconnect() } catch { /* ignore */ }
        if (flushTimer) clearTimeout(flushTimer)
        if (scanTimer) clearTimeout(scanTimer)
        if (pollTimer) clearInterval(pollTimer)
        flushTimer = scanTimer = null
        if (listButton) {
            listButton.remove()
            listButton = null
        }
        for (const badge of autoBadges.values()) badge.remove()
        autoBadges.clear()
    }

    function extensionAlive() {
        try {
            return Boolean(chrome.runtime?.id)
        } catch {
            return false
        }
    }

    /* ------------------------------------------------------------------ */
    /* 角标文案                                                            */
    /* ------------------------------------------------------------------ */

    const LABELS = {
        collected: info => `已收录${info.gallery ? '　@' + clip(info.gallery, 12) : ''}`,
        downloading: () => '下载中',
        pending: () => '排队中',
        failed: () => '下载失败',
        skipped: () => '已跳过',
        archived: () => '已下载过',
        done: () => '已下载'
    }

    function clip(text, max) {
        const value = String(text || '')
        return value.length > max ? value.slice(0, max) + '…' : value
    }

    /** 悬浮提示：角标只有几个字，细节放 title 里 */
    function tooltip(info) {
        const parts = []
        const gallery = info.gallery ? `@${info.gallery}` : ''
        switch (info.state) {
            case 'collected':
                parts.push('图库里已收录这篇')
                if (info.galleryTitle) parts.push(`图库：${info.galleryTitle}`)
                if (gallery) parts.push(gallery)
                if (info.time) parts.push(info.time)
                break
            case 'archived':
                parts.push('下载过，但图库里已经没有这篇了（不会再自动下载）')
                if (gallery) parts.push(`当时下到 ${gallery}`)
                if (info.time) parts.push(formatDate(info.time))
                break
            case 'downloading':
                parts.push('正在下载' + (gallery ? ` → ${gallery}` : ''))
                break
            case 'pending':
                parts.push('已在下载队列里排队' + (gallery ? ` → ${gallery}` : ''))
                break
            case 'failed':
                parts.push('上次下载失败' + (info.gallery ? `（目标 ${gallery}）` : ''))
                break
            case 'skipped':
                parts.push('自动下载时判定跳过（图库中通常已有其它版本）')
                break
            case 'done':
                parts.push('刚下载完成')
                break
        }
        return parts.filter(Boolean).join(' · ')
    }

    function formatDate(value) {
        const seconds = Number(value)
        if (!Number.isFinite(seconds) || seconds <= 0) return ''
        const date = new Date(seconds * 1000)
        const pad = n => String(n).padStart(2, '0')
        return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    }

    /* ------------------------------------------------------------------ */
    /* 渲染                                                                */
    /* ------------------------------------------------------------------ */

    /* 下载图标：静态 SVG，一次性写进角标。
       innerHTML 只用于这段常量，动态文案一律走 textContent —— 图库名是库里的数据，
       拼进 HTML 就等于给自己开后门。 */
    const ICONS = {
        download: '<path d="M11 3h2v10.2l3.1-3.1 1.4 1.4L12 17l-5.5-5.5 1.4-1.4L11 13.2V3z"/><path d="M5 19h14v2H5z"/>',
        check: '<path d="M9.6 16.6 4.9 11.9l-1.4 1.4 6.1 6.1L20.5 8.5 19.1 7.1z"/>',
        clock: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm1 4v5.6l4.2 2.5-.8 1.4L11 13.2V7z"/>',
        cross: '<path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/>',
        loading: '<path d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6z"/>'
    }

    /** 只显示图标时，各状态用哪个图形 */
    const STATE_ICON = {
        collected: 'check',
        archived: 'check',
        done: 'check',
        skipped: 'clock',
        pending: 'clock',
        downloading: 'loading',
        failed: 'cross',
        none: 'download'
    }

    const ACTION_ICON = '<svg class="wh-badge-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        ICONS.download + '</svg>'

    function createBadge(href) {
        const el = document.createElement('span')
        el.className = 'wh-badge'
        el.setAttribute('data-wh-badge', '1')
        el.dataset.href = href
        el.innerHTML = ACTION_ICON + '<span class="wh-badge-text"></span>'
        el.addEventListener('click', onBadgeClick)
        el.addEventListener('keydown', onBadgeKeydown)
        return el
    }

    function onBadgeClick(event) {
        const badge = event.currentTarget
        if (!badge || badge.dataset.kind !== 'action') return
        // 角标在 XHS 上可能落在卡片 <a> 内部，不拦下去就会连带跳转原帖
        event.preventDefault()
        event.stopPropagation()
        openDetailPage(badge)
    }

    function onBadgeKeydown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return
        const badge = event.currentTarget
        if (!badge || badge.dataset.kind !== 'action') return
        event.preventDefault()
        event.stopPropagation()
        openDetailPage(badge)
    }

    /** 点「下载」= 打开前端（kan.tu）的 browser 详情页，由那边决定下到哪个图库 */
    async function openDetailPage(badge) {
        const href = badge.dataset.href
        if (!href || badge.dataset.busy === '1') return
        badge.dataset.busy = '1'

        const textEl = badge.querySelector('.wh-badge-text')
        const previous = textEl ? textEl.textContent : ''
        if (textEl) textEl.textContent = '打开中…'

        try {
            // 小红书这类只能靠页面源码解析的站点：点击时把整页 HTML 一起交出去。
            // 后端没有登录态，抓不到详情页；源码只在这条消息里走，不落盘。
            const source = site.wantsSource ? document.documentElement.outerHTML : ''
            if (DEBUG) dbg('源码', href, source.length)
            // user：这条帖子的作者（站点账号），选人面板据此默认匹配图库
            await sendMessage({ topic: 'openDetailPage', href, source, user: accountOf(badge, href) })
        } catch {
            if (textEl) textEl.textContent = '打开失败'
            setTimeout(() => {
                if (textEl && badge.dataset.kind === 'action') textEl.textContent = previous
            }, 1500)
        } finally {
            badge.dataset.busy = ''
        }
    }

    /**
     * 角标容器要 absolute 定位，但直接给站点元素加 position: relative 有风险
     * （可能改变它内部绝对定位元素的参照物），所以只在计算值确实是 static 时才加 class。
     */
    function ensurePositioned(host) {
        if (!host || host.classList.contains('wh-badge-host')) return
        try {
            if (getComputedStyle(host).position === 'static') {
                host.classList.add('wh-badge-host')
            }
        } catch {
            host.classList.add('wh-badge-host')
        }
    }

    /**
     * 往上找「日期行」：X 把时间、分隔点、查看数放在一个 flex 行里
     * （形如 `<div class="… r-18u37iz …"><div><a><time></a></div><div>·</div><a>2.4万 查看</a></div>`）。
     *
     * 不能把角标塞进时间戳所在的那个文字 div —— 那里为了省略号是 nowrap + overflow:hidden，
     * 角标会被裁掉。表现就是：评论行（结构更扁平）有角标，主帖那一行没有。
     */
    function findFlexRow(anchor) {
        let node = anchor.parentElement
        for (let depth = 0; node && depth < 4; depth++) {
            let display = ''
            try {
                display = getComputedStyle(node).display
            } catch {
                display = ''
            }
            // 要求至少两个子节点：只要一个子节点的那层是「包裹层」，不是行
            if ((display === 'flex' || display === 'inline-flex') && node.children.length > 1) return node
            node = node.parentElement
        }
        return null
    }

    function mount(anchor, badge) {
        // 站点指定了挂载点就优先用它（X 挂在帖子底部操作栏的最后）
        if (site.place) {
            try {
                if (site.place(anchor, badge)) {
                    if (DEBUG) {
                        const parent = badge.parentElement
                        dbg('挂载', badge.dataset.href, '→', parent ? String(parent.className).slice(0, 46) : '(?)')
                    }
                    return true
                }
            } catch (e) {
                if (DEBUG) dbg('place 失败', badge.dataset.href, e?.message || e)
                // 站点改结构了 → 落到下面的日期行兜底
            }
        }

        // 「自动下载」按钮必须和主角标挨着，place 失败就不挂，免得跑到日期行去
        if (badge.dataset.whAuto === '1') return false
        // 详情页模式（小红书 / hentaiclub）没有锚点，place 没成功就说明这个页面
        // 还没有可挂的位置，直接放弃 —— 别往下走 hostFor
        if (!anchor) return false

        const host = site.hostFor(anchor)
        if (!host) return false
        if (DEBUG) dbg('挂载', badge.dataset.href, host.className.slice(0, 48), getComputedStyle(host).display)

        if (site.inline) {
            if (host === anchor.parentElement) {
                // 退回父节点时只能紧跟链接后面，保持行内
                anchor.insertAdjacentElement('afterend', badge)
            } else {
                // 正常情况：追加到日期行末尾（时间 · 查看数 之后）
                host.appendChild(badge)
            }

            // 挂完量一下：宽高为 0 说明落进了被裁切/隐藏的盒子里（X 的时间戳外层就是
            // nowrap + overflow:hidden），退回紧跟链接的行内位置兜底
            if (host !== anchor.parentElement) {
                const rect = badge.getBoundingClientRect()
                if (!rect.width || !rect.height) {
                    badge.remove()
                    anchor.insertAdjacentElement('afterend', badge)
                }
            }
        } else {
            ensurePositioned(host)
            badge.classList.add('wh-badge--corner')
            host.appendChild(badge)
        }
        return true
    }

    /**
     * 把查询结果画到角标上。
     *
     * 两种形态：
     *   - status：有结论（已收录 / 下载中 / 已下载过 …），只读
     *   - action：没有结论（none），显示下载按钮，点了打开前端详情页
     */
    function applyBadge(anchor, href, info) {
        if (!info) return

        let badge = badges.get(href)
        // 站点重渲染会换掉节点；另外这次找到的锚点可能比上次更靠谱（媒体图 → 时间戳）。
        // 两种情况都拆掉重建，否则角标会留在旧位置或挂进被裁切的容器里。
        if (badge && (!badge.isConnected || badgeAnchors.get(href) !== anchor)) {
            badge.remove()
            badges.delete(href)
            badgeAnchors.delete(href)
            badge = null
        }

        if (!badge) {
            badge = createBadge(href)
            if (!mount(anchor, badge)) return
            badges.set(href, badge)
            badgeAnchors.set(href, anchor)
        }

        renderBadge(badge, info)
    }

    function renderBadge(badge, info) {
        const isAction = info.state === 'none'
        const state = isAction ? 'action' : info.state
        const label = isAction ? '下载' : (LABELS[state] || (() => state))(info)

        const classes = ['wh-badge', `wh-badge--${state}`, `wh-badge--site-${site.name}`]
        // 定位形态（inline / corner）是挂载时决定的，重绘必须原样保留
        if (badge.classList.contains('wh-badge--corner')) classes.push('wh-badge--corner')
        // 只显示图标的站点（X）：药丸样式让位给圆形图标按钮
        if (site.iconOnly) classes.push('wh-badge--icon')
        const className = classes.join(' ')
        if (badge.className !== className) badge.className = className

        // 图标随状态切换（已收录 → 对勾、下载中 → 转圈、失败 → 叉）
        const svg = badge.querySelector('svg.wh-badge-icon')
        if (svg) {
            const iconKey = STATE_ICON[info.state] || 'download'
            if (svg.dataset.icon !== iconKey) {
                svg.innerHTML = ICONS[iconKey]
                svg.dataset.icon = iconKey
            }
        }

        badge.dataset.kind = isAction ? 'action' : 'status'
        if (isAction) {
            badge.setAttribute('role', 'button')
            badge.setAttribute('tabindex', '0')
        } else {
            badge.setAttribute('role', 'note')
            badge.removeAttribute('tabindex')
        }

        const textEl = badge.querySelector('.wh-badge-text')
        if (textEl && textEl.textContent !== label) textEl.textContent = label

        badge.title = isAction && info.state === 'none'
            ? '未下载 · 点击选择图库并下载'
            : tooltip(info)
        // 图标形态没有文字，无障碍标签得单独给
        badge.setAttribute('aria-label', isAction ? '未下载，点击选择图库并下载' : (tooltip(info) || label))
    }

    /* ------------------------------------------------------------------ */
    /* 「自动下载」按钮（只有图标形态的站点有：点了选人后直接入队，不进详情） */
    /* ------------------------------------------------------------------ */

    /** 闪电：一眼和「下载」图标区分开，也暗示「直接跑」 */
    const AUTO_ICON = '<svg class="wh-badge-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M13.5 2 5 13h5l-1.5 9L18.5 11h-5z"/></svg>'

    function createAutoBadge(href, author) {
        const el = document.createElement('span')
        el.className = `wh-badge wh-badge--icon wh-badge--auto-badge wh-badge--site-${site.name}`
        el.setAttribute('data-wh-badge', '1')
        el.dataset.whAuto = '1'
        el.dataset.href = href
        // 作者 handle 随按钮一起带着：前端选人面板据此默认匹配图库
        el.dataset.whUser = author || ''
        el.setAttribute('role', 'button')
        el.setAttribute('tabindex', '0')
        el.title = '自动下载到所选图库（不打开详情）'
        el.setAttribute('aria-label', '自动下载到所选图库')
        el.innerHTML = AUTO_ICON
        el.addEventListener('click', onAutoClick)
        el.addEventListener('keydown', onAutoKeydown)
        return el
    }

    function onAutoClick(event) {
        event.preventDefault()
        event.stopPropagation()
        openAutoPage(event.currentTarget)
    }

    function onAutoKeydown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        openAutoPage(event.currentTarget)
    }

    async function openAutoPage(button) {
        const href = button?.dataset.href
        if (!href || button.dataset.busy === '1') return
        button.dataset.busy = '1'
        button.title = '已交给前端…'
        try {
            await sendMessage({ topic: 'openAutoPage', href, user: button.dataset.whUser || '' })
        } catch {
            button.title = '打开失败，稍后再试'
        } finally {
            setTimeout(() => {
                button.dataset.busy = ''
                if (button.isConnected) button.title = '自动下载到所选图库（不打开详情）'
            }, 1200)
        }
    }

    /**
     * 自动下载按钮只在「未下载 + 声明了 autoBadge 的站点」出现（目前只有 X）；
     * 一旦有了结论（已收录 / 下载中 / 失败）就撤掉，避免两个图标挤在一起。
     */
    function applyAutoBadge(anchor, href, info) {
        const wanted = Boolean(site.autoBadge) && Boolean(info) && info.state === 'none'
        let el = autoBadges.get(href)

        if (!wanted) {
            if (el) {
                el.remove()
                autoBadges.delete(href)
            }
            return
        }

        if (el && !el.isConnected) {
            autoBadges.delete(href)
            el = null
        }
        if (el) return

        el = createAutoBadge(href, accountOf(anchor, href))
        if (mount(anchor, el)) autoBadges.set(href, el)
    }

    /**
     * 帖子作者（站点账号）：优先问站点自己的 DOM 取法，取不到就从链接里退一步。
     *
     * 微博这类链接本身就带账号（`weibo.com/u/<uid>`、`weibo.com/<uid>/<bid>`），
     * 而订阅源 url 里存的也正是这个 uid，所以兜底足够用。
     */
    function accountOf(anchor, href) {
        const fromDom = site.authorOf ? site.authorOf(anchor) : ''
        if (fromDom) return fromDom
        try {
            const pathname = new URL(href).pathname
            const parts = pathname.split('/').filter(Boolean)
            if (site.name === 'weibo') {
                if (parts[0] === 'u' && parts[1]) return parts[1]
                if (/^\d+$/.test(parts[0] || '')) return parts[0]
            }
            // 主页链接里直接带 uid（小红书 /user/profile/<uid>、其它站同理）
            const profile = pathname.match(/\/user\/profile\/([0-9a-zA-Z]+)/)
            if (profile?.[1]) return profile[1]
        } catch {
            // 链接解析失败就是拿不到账号，前端退回「上次选择」
        }
        return ''
    }

    /* ------------------------------------------------------------------ */
    /* 主页「打开列表」按钮                                                 */
    /* ------------------------------------------------------------------ */

    function setListButtonText(button, text) {
        const textEl = button.querySelector('.wh-list-button-text')
        if (textEl) textEl.textContent = text
    }

    function createListButton() {
        const el = document.createElement('button')
        el.type = 'button'
        el.className = `wh-list-button wh-list-button--site-${site.name}`
        el.innerHTML = ACTION_ICON + '<span class="wh-list-button-text">打开列表</span>'
        el.addEventListener('click', onListButtonClick)
        return el
    }

    /**
     * 列表页面对应的账号：X 是 handle，小红书是首页 uid。
     *
     * 这两个站的列表 URL 本身就带着账号，直接取出来交给前端选人面板，
     * 面板就能默认匹配到这个人的图库（和单条「自动下载」同一个入口）。
     */
    function listAccountOf(url) {
        try {
            const path = new URL(url).pathname
            if (site.name === 'x') {
                const matched = path.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/)
                if (matched && !RESERVED_X_PATHS.has(matched[1].toLowerCase())) return matched[1]
            }
            if (site.name === 'xiaohongshu') {
                const matched = path.match(/^\/user\/profile\/([^/?#]+)/)
                if (matched?.[1]) return decodeURIComponent(matched[1])
            }
        } catch {
            // URL 解析失败就是没有账号，前端退回「上次选择」
        }
        return ''
    }

    async function onListButtonClick(event) {
        event.preventDefault()
        event.stopPropagation()
        const button = event.currentTarget
        const url = button?.dataset.href
        if (!url || button.dataset.busy === '1') return

        button.dataset.busy = '1'
        setListButtonText(button, '抓取中…')

        try {
            // 小红书只能靠页面源码解析（后端没有登录态，抓不到这个页面），
            // 就地取一份带过去；其它站点交给后端自己抓，别把一大坨 HTML 塞进消息通道
            const source = site.wantsSource ? document.documentElement.outerHTML : ''
            await sendMessage({ topic: 'openListPage', href: url, source, user: listAccountOf(url) })
            setListButtonText(button, '已发送')
        } catch {
            setListButtonText(button, '打开失败')
        } finally {
            button.dataset.busy = ''
            setTimeout(() => {
                if (button.isConnected) setListButtonText(button, '打开列表')
            }, 1600)
        }
    }

    /**
     * X 右下角常驻 Grok / 聊天抽屉（挂在 #layers 里，宽 400、贴底），
     * 固定 bottom 的按钮必然被它盖住。这里读抽屉的实际位置把按钮顶上去，
     * 抽屉收起 / 换布局时自动回落 —— 写死 px 会随 X 改版失效。
     *
     * 注意判据只看「x 方向是否和按钮同列」，不看当前是否已经重叠：
     * 否则按钮上移后不再重叠，下一轮又会落回原位，来回抖。
     */
    const BOTTOM_DOCKS = '#layers [data-testid="GrokDrawer"], #layers [data-testid="chat-drawer-root"]'
    const DOCK_COLUMN_LEFT = 160   // 按钮右对齐 20px，占位约 140px 宽

    function avoidBottomDock(button) {
        if (!button) return
        const vh = window.innerHeight
        const vw = window.innerWidth
        let top = vh

        let docks = []
        try {
            docks = document.querySelectorAll(BOTTOM_DOCKS)
        } catch {
            docks = []
        }

        for (const dock of docks) {
            const rect = dock.getBoundingClientRect()
            // 高度 0 是隐藏态；超过 140 的不是底部抽屉，是整块面板，别理
            if (rect.height <= 0 || rect.height > 140) continue
            if (rect.right < vw - DOCK_COLUMN_LEFT || rect.left > vw - 20) continue
            if (rect.top < top) top = rect.top
        }

        const bottom = top === vh ? 20 : Math.round(vh - top + 12)
        if (button.dataset.dockBottom === String(bottom)) return
        button.dataset.dockBottom = String(bottom)
        // 样式表里 bottom 带 !important，这里也得用 important 才盖得住
        button.style.setProperty('bottom', `${bottom}px`, 'important')
    }

    /** 按钮当前嵌在哪个容器里（null = 浮在右下角）；宿主变了要跟着挪 */
    let listButtonHost = null

    /**
     * 「打开列表」入口的来源：
     *   - X：用户主页（profileUrl）
     *   - hentaiclub：归档/分类页的标题（listJob 带 host，按钮直接嵌进标题里）
     */
    function resolveListJob() {
        if (site.listJob) return site.listJob()
        if (!site.profileUrl) return null
        const url = site.profileUrl()
        return url ? { url, host: null } : null
    }

    /** 每轮扫描顺手同步：当前是不是该出现、是不是换了个人 / 换了页、要不要撤掉按钮 */
    function syncListButton() {
        let job = null
        try {
            job = resolveListJob()
        } catch {
            job = null
        }

        if (!job || !job.url) {
            if (listButton) listButton.remove()
            listButton = null
            listButtonUrl = ''
            listButtonHost = null
            return
        }

        // 站点重渲染会把按钮一起干掉（WordPress 整页刷新、X 换人）
        if (listButton && !listButton.isConnected) {
            listButton = null
            listButtonHost = null
        }

        const host = job.host || null

        if (!listButton) {
            listButton = createListButton()
            listButtonHost = host
            mountListButton(host)
        } else if (listButtonHost !== host) {
            listButtonHost = host
            mountListButton(host)
        }

        // 浮动形态才需要避开右下角的抽屉；嵌进标题里的不需要
        if (!listButtonHost) avoidBottomDock(listButton)

        if (listButtonUrl !== job.url) {
            listButtonUrl = job.url
            listButton.dataset.href = job.url
            listButton.title = `把 ${job.url} 的整页帖子送进前端列表`
            setListButtonText(listButton, '打开列表')
        }
    }

    /** 放进站点自己的容器（内联），或退回右下角浮动 */
    function mountListButton(host) {
        if (!listButton) return
        if (host) {
            listButton.classList.add('wh-list-button--inline')
            host.appendChild(listButton)
        } else {
            listButton.classList.remove('wh-list-button--inline')
            document.body.appendChild(listButton)
        }
    }

    /* ------------------------------------------------------------------ */
    /* 扫描                                                                */
    /* ------------------------------------------------------------------ */

    function scan() {
        if (stopped || !document.body) return

        // 「详情页模式」的站点（小红书 / hentaiclub）：页面上并没有指向自己的链接，
        // 直接把当前地址当成唯一目标。拿不到就说明不是详情页。
        let detailHref = null
        if (site.detailHref) {
            try {
                detailHref = site.detailHref()
            } catch {
                detailHref = null
            }
        }

        const targets = new Map()

        if (detailHref) {
            targets.set(detailHref, { anchor: null, hasTime: false })
        } else if (site.detailOnly) {
            // 只在详情页挂的站点离开了详情页：旧角标一律收掉，也不再查任何链接
            for (const [href, badge] of [...badges]) {
                badge.remove()
                badges.delete(href)
                badgeAnchors.delete(href)
            }
            dbg('扫描', site.name, '非详情页，跳过')
            syncListButton()
            return
        } else {
            let anchors
            try {
                anchors = document.querySelectorAll(site.selector)
            } catch {
                return
            }

            // 同一条帖子在页面上有多个入口（媒体图 / 时间戳 / 查看数），都指向同一个 /status/<id>。
            // 先按 href 分组，并优先留下「带 <time> 的时间戳链接」——
            // 媒体链接的父容器是整块图片区，角标挂进去就看不见了。
            for (const anchor of anchors) {
                const href = site.normalize(anchor.href || '')
                if (!href) continue

                const hasTime = Boolean(anchor.querySelector('time'))
                const current = targets.get(href)
                if (!current || (!current.hasTime && hasTime)) {
                    targets.set(href, { anchor, hasTime })
                }
            }

            dbg('扫描', site.name, '链接', anchors.length, '帖子', targets.size)
        }

        for (const [href, target] of targets) {
            // X：没有时间戳链接就宁可不挂，也别挂到图片容器里
            if (site.requireTime && !target.hasTime) continue

            const info = results.get(href)
            if (info) {
                try {
                    applyBadge(target.anchor, href, info)
                    applyAutoBadge(target.anchor, href, info)
                } catch (e) {
                    // 单条渲染失败不能拖垮整轮扫描：站点改版时这里会一直报，日志里一眼能看出来
                    console.warn('[虫洞] 角标渲染失败:', href, e)
                }
                continue
            }
            if (asked.has(href)) continue

            asked.add(href)
            pending.add(href)
        }

        dbg('扫描', site.name, '结果', results.size, '角标', badges.size)

        syncListButton()

        if (pending.size > 0) scheduleFlush()
    }

    function scheduleScan() {
        if (stopped || scanTimer) return
        scanTimer = setTimeout(() => {
            scanTimer = null
            scan()
        }, SCAN_THROTTLE)
    }

    /* ------------------------------------------------------------------ */
    /* 查询                                                                */
    /* ------------------------------------------------------------------ */

    function scheduleFlush() {
        if (flushTimer) return
        flushTimer = setTimeout(flush, FLUSH_DELAY)
    }

    function sendMessage(message) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, response => {
                    const lastError = chrome.runtime.lastError
                    if (lastError) reject(new Error(lastError.message))
                    else resolve(response)
                })
            } catch (e) {
                reject(e)
            }
        })
    }

    async function flush() {
        flushTimer = null
        if (stopped) return
        const hrefs = [...pending].slice(0, BATCH_SIZE)
        for (const href of hrefs) pending.delete(href)
        if (hrefs.length === 0) return

        // URL 变体：同一个帖子在不同页面可能长得不一样（微博 feed 带 ?pagetype=homefeed，
        // 详情页不带）。后端清洗只删固定名单里的参数，删不到 pagetype，
        // 于是两边算出的键不同 —— 这里一次把变体都查了，命中哪个都算。
        const variants = new Map()   // 实际发出去的 href -> 页面上的原始 href
        for (const href of hrefs) {
            const list = site.variants ? site.variants(href) : [href]
            for (const variant of list.length > 0 ? list : [href]) variants.set(variant, href)
        }

        try {
            const response = await sendMessage({ topic: 'checkStatus', hrefs: [...variants.keys()] })
            const items = Array.isArray(response?.items) ? response.items : []
            for (const item of items) {
                if (!item || !item.href) continue
                const origin = variants.get(item.href) || item.href
                const prev = results.get(origin)
                // 已经查到「有结论」的就不被变体里的 none 覆盖
                if (!prev || (prev.state === 'none' && item.state !== 'none')) {
                    results.set(origin, { ...item, href: origin })
                }
                checkedAt.set(origin, Date.now())
            }
            // 服务端没回的那几条当成查不到，别一直重试
            for (const href of hrefs) {
                if (!results.has(href)) {
                    results.set(href, { href, state: 'none' })
                    checkedAt.set(href, Date.now())
                }
            }
        } catch {
            // 上下文失效（扩展被重载）：整体停掉，这个页面的角标要靠刷新才会回来
            if (!extensionAlive()) {
                stop()
                return
            }
            // 后端暂时不可达：把 href 放回去，下次扫描重试（此时不写 none，避免角标误消失）
            for (const href of hrefs) asked.delete(href)
        }

        if (results.size > MAX_CACHE) {
            results.clear()
            checkedAt.clear()
            for (const badge of badges.values()) badge.remove()
            for (const badge of autoBadges.values()) badge.remove()
            badges.clear()
            autoBadges.clear()
            badgeAnchors.clear()
            asked.clear()
        }

        scheduleScan()
        if (pending.size > 0) scheduleFlush()
    }

    /* ------------------------------------------------------------------ */
    /* 运行态复查 + 生命周期                                              */
    /* ------------------------------------------------------------------ */

    pollTimer = setInterval(() => {
        if (stopped) return
        const now = Date.now()
        let dirty = false
        for (const [href, info] of [...results]) {
            // 排队 / 下载中：状态随时会变，每轮都重新问
            const running = info.state === 'downloading' || info.state === 'pending'
            // 「没有」的结论会过期：用户可能在下载中心刚点了一条，或者别的设备刚下完
            const stale = info.state === 'none' && now - (checkedAt.get(href) || 0) > STALE_NONE
            if (running || stale) {
                results.delete(href)
                checkedAt.delete(href)
                asked.delete(href)
                dirty = true
            }
        }
        if (dirty) scan()
        // 抽屉开合是 CSS 动画，不产生 DOM 变化，这里顺手校正一次按钮位置
        else if (listButton) avoidBottomDock(listButton)
    }, POLL_INTERVAL)

    // 初次扫描 + 订阅 DOM 变化（X / 小红书都是 SPA，滚动和导航都会改 DOM）
    scan()

    const observer = new MutationObserver(() => {
        if (stopped) return
        scheduleScan()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    // 抽屉是 transform 动画（不触发 childList），窗口尺寸变化也不会重扫，
    // 这两个时机单独补一次，否则按钮会停在旧位置压住 Grok 按钮
    window.addEventListener('resize', () => {
        if (!stopped) syncListButton()
    })
})()
