// content.js
function sendCookies() {
    chrome.runtime.sendMessage({
        topic: 'sendCookies',
        domain: window.location.hostname,
        cookie: document.cookie
    });
}

// 页面加载时发送
document.addEventListener('DOMContentLoaded', sendCookies);

// 监听页面变化（针对单页应用）
const observer = new MutationObserver(() => {
    sendCookies();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});