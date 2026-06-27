// bridge.js - 网页与扩展之间的消息桥接

// 接收页面发来的消息，转发给扩展
window.addEventListener('message', (event) => {
    if (event.data?.type !== 'WORMHOLE_MESSAGE') return;
    chrome.runtime.sendMessage(event.data.payload, (response) => {
        window.postMessage({ type: 'WORMHOLE_RESPONSE', payload: response }, '*');
    });
});
