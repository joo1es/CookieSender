// content.js
let observer = null
let dead = false

/**
 * 扩展被重载 / 更新 / 卸载后，旧页面里的脚本上下文会立刻失效，
 * 此时 chrome.runtime.id 变成 undefined，任何 sendMessage 都会抛
 * "Extension context invalidated."。这不是 bug，是这个页面该退休了 ——
 * 停掉观察者即可，不要让它每改一次 DOM 就抛一次。
 */
function extensionAlive() {
    try {
        return Boolean(chrome.runtime?.id)
    } catch {
        return false
    }
}

function stopObserver() {
    dead = true
    if (observer) {
        observer.disconnect()
        observer = null
    }
}

function sendCookies() {
    if (dead) return
    if (!extensionAlive()) {
        stopObserver()
        return
    }
    try {
        chrome.runtime.sendMessage({
            topic: 'sendCookies',
            domain: window.location.hostname,
            cookie: document.cookie
        }, () => {
            // 必须读一下 lastError，否则控制台还会多一条 "Unchecked runtime.lastError"
            void chrome.runtime.lastError
        })
    } catch {
        stopObserver()
    }
}

// 页面加载时发送
document.addEventListener('DOMContentLoaded', sendCookies)

// 监听页面变化（针对单页应用）
observer = new MutationObserver(() => {
    sendCookies()
})

observer.observe(document.body, {
    childList: true,
    subtree: true
})
