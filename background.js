// background.js

const TARGET_DOMAINS = [
    'weibo.com',
    'x.com'
];

const API_ENDPOINT = 'https://kan.tu/api/manage/cookie';

// 站内角标用的批量状态查询（后端只查库，不触发站点抓取）
const STATUS_ENDPOINT = 'https://kan.tu/api/get/status';

// 创建基于域名的防抖函数
function debounceByDomain(func, wait) {
    const timeoutMap = new Map();

    return function (msg) {
        const domain = msg.domain;
        if (timeoutMap.has(domain)) {
            clearTimeout(timeoutMap.get(domain));
        }

        timeoutMap.set(domain, setTimeout(() => {
            func.call(this, msg);
            timeoutMap.delete(domain);
        }, wait));
    };
}

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.topic === 'sendCookies') {
        debouncedSendCookies(msg);
        sendResponse(true);
        return true;
    }

    if (msg.topic === 'getPageSource') {
        getSourceByTabId(msg.tabId).then(sendResponse).catch(() => sendResponse({ error: '获取失败' }));
        return true;
    }

    if (msg.topic === 'getAllTabs') {
        getAllTabs().then(sendResponse).catch(() => sendResponse([]));
        return true;
    }

    if (msg.topic === 'openLocalPage') {
        openLocalPage(msg).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (msg.topic === 'openAndGrab') {
        openAndGrab(msg, sender).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // 站点页面上的「是否已下载」角标：内容脚本只负责扫链接，请求统一由这里发
    // （background 有 <all_urls> 权限，不受 CORS 限制；内容脚本直接 fetch 会被拦）
    if (msg.topic === 'checkStatus') {
        checkStatuses(msg.hrefs || [])
            .then(items => sendResponse({ items }))
            .catch(e => sendResponse({ items: [], error: e.message }));
        return true;
    }

    // 未下载时点的「下载」按钮：跳到前端（kan.tu）的 browser 详情页
    // source：小红书这类只能靠页面源码解析的站点，会把整页 HTML 一起传过来
    if (msg.topic === 'openDetailPage') {
        console.log('[虫洞] openDetailPage', msg.href, 'source 长度:', (msg.source || '').length);
        openDetailPage(msg.href, msg.source)
            .then(sendResponse)
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // 前端页面启动后回来取源码：深链带不动几 MB 的 HTML，只能这样「先存后取」
    if (msg.topic === 'takeSource') {
        takeSource((msg.href || '').trim())
            .then(source => {
                console.log('[虫洞] takeSource', msg.href, '取到:', (source || '').length);
                sendResponse({ topic: 'takeSource', source });
            })
            .catch(() => sendResponse({ topic: 'takeSource', source: '' }));
        return true;
    }

    // 用户主页上的「打开列表」按钮：把整页帖子送进前端的 browser 列表模式
    // 小红书必须带页面源码才能解析，所以 source 由内容脚本在点击时上传
    if (msg.topic === 'openListPage') {
        openListPage(msg.href, msg.source)
            .then(sendResponse)
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // 「自动下载」按钮：前端选完人后直接入队，不打开详情
    if (msg.topic === 'openAutoPage') {
        openAutoPage(msg.href)
            .then(sendResponse)
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }
});

// 统计可用标签页数量并更新角标
function detectPageType(url) {
    try {
        const { hostname, pathname } = new URL(url);
        if (hostname.includes('douyin.com')) {
            if (pathname.startsWith('/user/') || pathname.startsWith('/video/')) return true;
        }
        if (hostname.includes('xiaohongshu.com')) {
            if (pathname.startsWith('/user/profile/') || pathname.startsWith('/explore/') || pathname.startsWith('/discovery/')) return true;
        }
    } catch {}
    return false;
}

async function updateBadge() {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(tab => tab.url && detectPageType(tab.url)).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#7C4DFF' });
}

chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) updateBadge();
    // 在本地页面注入 __wormhole 标记
    if (changeInfo.status === 'complete' && tab.url &&
        (tab.url.includes('kan.tu') || tab.url.includes('localhost') || tab.url.includes('127.0.0.1'))) {
        injectWormholeMark(tabId);
    }
});

// 启动时更新一次
updateBadge();

// 获取所有标签页列表
async function getAllTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(tab => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        active: tab.active,
        lastAccessed: tab.lastAccessed
    }));
}

// 获取指定标签页的源代码
async function getSourceByTabId(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.documentElement.outerHTML
        });
        if (!results?.[0]) return { error: '无法获取页面内容' };
        const tab = await chrome.tabs.get(tabId);
        return { source: results[0].result, url: tab.url, title: tab.title };
    } catch (error) {
        return { error: error.message };
    }
}

// 当扩展安装或更新时设置定时任务
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('checkTokens', {
        periodInMinutes: 1
    });
});

// 监听定时任务
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'checkTokens') {
        checkAndSendTokens();
    }
});

// 监听页面导航完成
chrome.webNavigation.onCompleted.addListener((details) => {
    const domain = new URL(details.url).hostname;
    if (TARGET_DOMAINS.some(target => domain.includes(target))) {
        sendCookiesForDomain(domain);
    }
}, {
    url: TARGET_DOMAINS.map(domain => ({ hostContains: domain }))
});

async function getAllCookies(msg) {
    const cookies = await chrome.cookies.getAll({ domain: msg.domain.replace('www.', '') });
    const cookieStrings = [];

    if (Array.isArray(cookies)) {
        for (const cookie of cookies) {
            cookieStrings.push(`${cookie.name}=${cookie.value}`);
        }
    }

    if (msg.cookie) {
        const documentCookies = msg.cookie.split('; ');
        for (const cookie of documentCookies) {
            const [name, value] = cookie.split('=');
            if (!cookies.find(singleCookie => singleCookie.name === name)) {
                cookieStrings.unshift(cookie);
            }
        }
    }
    return cookieStrings.join('; ');
}

async function sendCookies(msg) {
    const cookie = await getAllCookies(msg);
    const url = new URL(API_ENDPOINT);
    url.searchParams.set('domain', msg.domain);

    const formData = new FormData();
    formData.append('content', cookie);

    try {
        const response = await fetch(url, {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) {
            console.error(`Failed to send cookies for ${msg.domain}: ${response.status}`);
        }
    } catch (error) {
        console.error(`Error sending cookies for ${msg.domain}:`, error);
    }
}

// 创建基于域名的防抖版本（每个域名独立防抖，等待10秒）
const debouncedSendCookies = debounceByDomain(sendCookies, 10000);

async function sendCookiesForDomain(domain) {
    const msg = {
        topic: 'sendCookies',
        domain: domain,
        cookie: ''
    };
    debouncedSendCookies(msg);
}

async function checkAndSendTokens() {
    for (const domain of TARGET_DOMAINS) {
        sendCookiesForDomain(domain);
    }
}

// 向本地页面注入标记和事件（在页面主世界执行）
async function openLocalPage({ type, url, source }) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.url || (!activeTab.url.includes('kan.tu') && !activeTab.url.includes('localhost') && !activeTab.url.includes('127.0.0.1'))) {
        return { success: false, error: '请先切换到 kan.tu 或 localhost 页面' };
    }

    try {
        const action = type === 'COOKIESENDER_OPEN_LIST' ? 'openList' : 'openDetail';
        await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            world: 'MAIN',
            func: (actionName, targetUrl, sourceCode) => {
                window.dispatchEvent(new CustomEvent('cookieSender', {
                    detail: { action: actionName, url: targetUrl, source: sourceCode }
                }));
            },
            args: [action, url, source]
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 页面加载时注入 __wormhole 标记
async function injectWormholeMark(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => { window.__wormhole = true; }
        });
    } catch {}
}

// 在本地页面注入 cookieSender 事件
async function dispatchCookieSenderEvent(tabId, detail) {
    await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (d) => {
            window.dispatchEvent(new CustomEvent('cookieSender', { detail: d }));
        },
        args: [detail]
    });
}

// 推送状态到前端页面
async function pushStatus(tabId, status) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (s) => { window.dispatchEvent(new CustomEvent('wormholeStatus', { detail: s })); },
            args: [status]
        });
    } catch {}
}

// 打开新标签页，加载完成后自动抓取源码并发回前端
async function openAndGrab({ type, url }, sender) {
    const frontendTabId = sender?.tab?.id;
    if (!frontendTabId) {
        return { success: false, error: '无法确定前端标签页' };
    }

    const tab = await chrome.tabs.create({ url, active: true });
    pushStatus(frontendTabId, '等待页面加载...');

    // 抓取完成后切回原标签
    function switchBack() {
        chrome.tabs.update(frontendTabId, { active: true });
    }

    let cleaned = false;
    function cleanup() {
        if (cleaned) return;
        cleaned = true;
        chrome.tabs.onUpdated.removeListener(listener);
    }

    function listener(tabId, changeInfo) {
        if (tabId !== tab.id || changeInfo.status !== 'complete') return;
        cleanup();
        pushStatus(frontendTabId, '抓取源码中...');

        setTimeout(async () => {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => document.documentElement.outerHTML
                });
                const source = results?.[0]?.result;
                if (!source) return;

                const action = type === 'COOKIESENDER_OPEN_LIST' ? 'openList' : 'openDetail';
                const detail = { action, url, source };
                pushStatus(frontendTabId, '发送到前端...');

                try {
                    await chrome.tabs.sendMessage(frontendTabId, {
                        topic: 'cookieSenderEvent',
                        detail
                    });
                } catch {
                    await dispatchCookieSenderEvent(frontendTabId, detail);
                }
                // 抓取完成，关闭临时标签页并切回
                chrome.tabs.remove(tab.id);
                switchBack();
                pushStatus(frontendTabId, '');
            } catch (e) {
                console.error('[虫洞] 自动抓取失败:', e);
            }
        }, 1500);
    }

    chrome.tabs.onUpdated.addListener(listener);

    // 30秒超时清理
    setTimeout(cleanup, 30000);

    return { success: true };
}

/* ------------------------------------------------------------------ */
/* 站内角标：批量状态查询                                               */
/* ------------------------------------------------------------------ */

// 缓存放在 service worker 内存里：MV3 的 worker 会被回收，缓存随之消失 ——
// 最坏结果只是多查一次库，不影响正确性，所以不做持久化。
const statusCache = new Map();
const STATUS_TTL_HIT = 60 * 1000;   // 已有结论（已收录 / 已下载过 / 失败）一分钟内不重复问
const STATUS_TTL_NONE = 12 * 1000;  // 「没下载过」短一些：用户可能刚在别处下完
const STATUS_CACHE_LIMIT = 1500;
const STATUS_CHUNK = 200;           // 后端 MAX_HREFS 是 300，这里留余量

async function checkStatuses(hrefs) {
    const now = Date.now();
    const items = [];
    const need = [];

    for (const href of hrefs) {
        if (!href) continue;
        const cached = statusCache.get(href);
        const ttl = cached && cached.data.state === 'none' ? STATUS_TTL_NONE : STATUS_TTL_HIT;
        if (cached && now - cached.at < ttl) {
            items.push(cached.data);
            continue;
        }
        need.push(href);
    }

    if (need.length === 0) return items;

    const chunks = [];
    for (let i = 0; i < need.length; i += STATUS_CHUNK) {
        chunks.push(need.slice(i, i + STATUS_CHUNK));
    }

    for (const chunk of chunks) {
        try {
            const response = await fetch(STATUS_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ hrefs: chunk })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const payload = await response.json();
            // 后端统一包了一层 { code, success, message, data }
            const list = payload?.data?.items || payload?.items || [];
            for (const item of list) {
                if (!item || !item.href) continue;
                statusCache.set(item.href, { at: Date.now(), data: item });
                items.push(item);
            }
        } catch (e) {
            console.error('[虫洞] 状态查询失败:', e);
        }
    }

    if (statusCache.size > STATUS_CACHE_LIMIT) statusCache.clear();

    return items;
}

/* ------------------------------------------------------------------ */
/* 打开前端的 browser 弹层（详情页 / 列表页）                            */
/* ------------------------------------------------------------------ */

// 前端（kan.tu）的详情页和列表页都没有独立路由，是 Browser 组件里的弹层，
// 所以只能由前端自己打开 —— 这里提供两条路：
//   1) 已经开着前端：注入一个函数调用，页面内打开，不刷新（保留用户当前的浏览状态）
//   2) 没开着：带 ?browserDetail= / ?browserList= 新开一个标签，前端启动时自己弹出来
const FRONTEND_HOME = 'https://kan.tu/';
const FRONTEND_PATTERN = /^https?:\/\/(kan\.tu|localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

/** kind: 'detail' | 'list' | 'auto' */
const FRONTEND_KEY = { detail: 'browserDetail', list: 'browserList', auto: 'browserAuto' };

function buildFrontendUrl(kind, href) {
    const key = FRONTEND_KEY[kind] || FRONTEND_KEY.detail;
    return `${FRONTEND_HOME}?${key}=${encodeURIComponent(href)}`;
}

/* 前端没开着时，源码没法塞进深链（几 MB 的 HTML），
   先暂存在这里，等前端页面起来后通过 bridge 的 takeSource 来取。
   
   必须双写：MV3 的 service worker 空闲 30 秒就会被回收，模块级 Map 跟着清零 ——
   用户在选人面板上多停一会儿，内存里那份就没了。storage.session 跨 worker 重启保留，
   浏览器关闭才清。 */
const pendingSources = new Map();
const SOURCE_TTL = 5 * 60 * 1000;

const sourceKey = href => `whSource:${href}`;

async function stashSource(href, source) {
    if (!href || !source) return;
    const record = { source, at: Date.now() };
    pendingSources.set(href, record);
    try {
        await chrome.storage.session.set({ [sourceKey(href)]: record });
    } catch (e) {
        // 超过 storage.session 配额（10MB）时只留内存副本，至少本次可用
        console.warn('[虫洞] 源码写入 storage 失败:', e?.message || e);
    }
}

/** 取源码：先内存，再 storage.session（worker 重启过就只能靠后者） */
async function takeSource(href) {
    if (!href) return '';
    const now = Date.now();
    let source = '';

    const hit = pendingSources.get(href);
    if (hit) {
        pendingSources.delete(href);
        if (now - hit.at <= SOURCE_TTL) source = hit.source;
    }

    try {
        const key = sourceKey(href);
        const stored = await chrome.storage.session.get(key);
        const record = stored?.[key];
        if (record) {
            if (!source && now - record.at <= SOURCE_TTL) source = record.source;
            await chrome.storage.session.remove(key);
        }
    } catch (e) {
        console.warn('[虫洞] 源码读取失败:', e?.message || e);
    }

    return source;
}

async function openFrontend(kind, href, source) {
    const target = (href || '').trim();
    if (!target) throw new Error('缺少链接');

    const tabs = await chrome.tabs.query({});
    const existing = tabs.find(tab => tab.id != null && tab.url && FRONTEND_PATTERN.test(tab.url));

    if (existing) {
        const opened = await dispatchToFrontend(existing.id, kind, target, source);
        if (opened) {
            await focusTab(existing.id, existing.windowId);
            return { success: true, mode: 'inpage' };
        }
        // 前端还在加载 / 版本太旧没有这个入口 → 退化成深链跳转，源码先存着
        await stashSource(target, source);
        await chrome.tabs.update(existing.id, { url: buildFrontendUrl(kind, target), active: true });
        await focusTab(existing.id, existing.windowId);
        return { success: true, mode: 'navigate' };
    }

    await stashSource(target, source);
    await chrome.tabs.create({ url: buildFrontendUrl(kind, target), active: true });
    return { success: true, mode: 'created' };
}

function openDetailPage(href, source) {
    return openFrontend('detail', href, source);
}

function openListPage(href, source) {
    return openFrontend('list', href, source);
}

function openAutoPage(href) {
    return openFrontend('auto', href);
}

/** 在前端页面的主世界里调用它挂上来的入口函数；页面没准备好时返回 false */
async function dispatchToFrontend(tabId, kind, href, source) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (k, url, src) => {
                const fn = k === 'list'
                    ? window.__openBrowserList
                    : (k === 'auto' ? window.__openBrowserAuto : window.__openBrowserDetail);
                if (typeof fn !== 'function') return false;
                fn(url, src);
                return true;
            },
            args: [kind, href, source || '']
        });
        return results?.[0]?.result === true;
    } catch {
        return false;
    }
}

async function focusTab(tabId, windowId) {
    try { await chrome.tabs.update(tabId, { active: true }); } catch {}
    try { if (windowId != null) await chrome.windows.update(windowId, { focused: true }); } catch {}
}
