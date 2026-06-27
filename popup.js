// popup.js
document.addEventListener('DOMContentLoaded', () => {
    const tabList = document.getElementById('tabList');
    const status = document.getElementById('status');

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function detectPageType(url) {
        try {
            const { hostname, pathname } = new URL(url);
            if (hostname.includes('douyin.com')) {
                if (pathname.startsWith('/user/')) return 'list';
                if (pathname.startsWith('/video/')) return 'detail';
            }
            if (hostname.includes('xiaohongshu.com')) {
                if (pathname.startsWith('/user/profile/')) return 'list';
                if (pathname.startsWith('/explore/') || pathname.startsWith('/discovery/')) return 'detail';
            }
        } catch {}
        return null;
    }

    chrome.runtime.sendMessage({ topic: 'getAllTabs' }, (tabs) => {
        tabList.innerHTML = '';
        const filtered = tabs
            .filter(tab => tab.url && detectPageType(tab.url))
            .sort((a, b) => {
                if (a.active && !b.active) return -1;
                if (!a.active && b.active) return 1;
                return (b.lastAccessed || 0) - (a.lastAccessed || 0);
            });
        filtered.forEach(tab => {
            const item = document.createElement('div');
            item.className = 'tab-item';

            const pageType = detectPageType(tab.url);
            const favicon = tab.favIconUrl || '';
            const title = escapeHtml(tab.title || tab.url);

            item.innerHTML = `
                <img src="${favicon}" onerror="this.style.display='none'">
                <span class="title">${title}</span>
                <span class="tag tag-${pageType}">${pageType === 'list' ? '列表' : '详情'}</span>
            `;

            item.onclick = () => {
                const type = detectPageType(tab.url);
                showStatus('获取源码中...', 'success');

                chrome.runtime.sendMessage({ topic: 'getPageSource', tabId: tab.id }, (response) => {
                    if (response?.error) {
                        showStatus('获取源码失败', 'error');
                        return;
                    }

                    const msgType = type === 'list' ? 'COOKIESENDER_OPEN_LIST' : 'COOKIESENDER_OPEN_DETAIL';
                    chrome.runtime.sendMessage({
                        topic: 'openLocalPage',
                        type: msgType,
                        url: response.url,
                        source: response.source
                    }, (res) => {
                        if (res?.success) {
                            showStatus('已发送', 'success');
                        } else {
                            showStatus('发送失败: ' + (res?.error || ''), 'error');
                        }
                    });
                });
            };

            tabList.appendChild(item);
        });
    });

    function showStatus(msg, type) {
        status.textContent = msg;
        status.className = `status ${type}`;
    }
});
