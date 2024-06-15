'use strict'

//环境变量whitelist控制允许访问的Docker仓库,默认为空允许全部,格式为:"xxx/xxx",官方为library
//例: library/,mzzsfy/,abc/bcd 为允许访问官方和mzzsfy所有镜像,外加abc/bcd这个镜像

// Docker镜像仓库主机地址
const hub_host = 'registry-1.docker.io'
// Docker认证服务器地址
const auth_url = 'auth.docker.io'

/** @type {RequestInit} */
const PREFLIGHT_INIT = {
    // 预检请求配置
    headers: new Headers({
        'access-control-allow-origin': '*', // 允许所有来源
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS', // 允许的HTTP方法
        'access-control-max-age': '1728000', // 预检请求的缓存时间
    }),
}

/**
 * 构造响应
 * @param {any} body 响应体
 * @param {number} status 响应状态码
 * @param {Object<string, string>} headers 响应头
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*' // 允许所有来源
    return new Response(body, {status, headers}) // 返回新构造的响应
}

/**
 * 构造新的URL对象
 * @param {string} urlStr URL字符串
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr) // 尝试构造新的URL对象
    } catch (err) {
        return null // 构造失败返回null
    }
}

function token(request, url, env, ctx) {
    const getReqHeader = (key) => request.headers.get(key);
    if (env['whitelist'] && url.searchParams.get('scope')) {
        let name = url.searchParams.get('scope').split(':')[1];
        if (!env['whitelist'].split(',').some(e => name.startsWith(e))) {
            console.log("非白名单镜像,拒绝访问", name)
            return new Response(
                'access denied',
                {status: 404}
            )
        }
    }
    let token_parameter = {
        headers: {
            'Host': auth_url,
            'User-Agent': getReqHeader("User-Agent"),
            'Accept': getReqHeader("Accept"),
            'Accept-Language': getReqHeader("Accept-Language"),
            'Accept-Encoding': getReqHeader("Accept-Encoding"),
            'Connection': 'keep-alive',
            'Cache-Control': 'max-age=0'
        }
    };
    return fetch(new Request('https://' + auth_url + url.pathname + url.search, request), token_parameter)
}

export default {
    async fetch(request, env, ctx) {
        const getReqHeader = (key) => request.headers.get(key); // 获取请求头

        let url = new URL(request.url); // 解析请求URL
        let workers_url = `https://${url.hostname}`;
        const pathname = url.pathname;
        if (pathname === '/token') {
            return token(request, url, env, ctx)
        }
        if (!pathname.startsWith('/v2/')) {
            return new Response('404 Not Found', {
                status: 404,
                headers: {},
            });
        }
        if (env['whitelist']) {
            let l = 0
            if (pathname.endsWith('/manifests/latest')) {
                l = 17
            } else if (pathname.endsWith('/blobs/sha256:REDACTED')) {
                l = 22
            }
            let name = pathname.substring(4).substring(0, pathname.length - 4 - l);
            if (!env['whitelist'].split(',').some(e => name.startsWith(e))) {
                console.log("非白名单镜像,拒绝访问", name)
                return new Response(
                    'access denied',
                    {status: 403}
                )
            }
        }
        // 更改请求的主机名
        url.hostname = hub_host;

        // 构造请求参数
        let parameter = {
            headers: {
                'Host': hub_host,
                'User-Agent': getReqHeader("User-Agent"),
                'Accept': getReqHeader("Accept"),
                'Accept-Language': getReqHeader("Accept-Language"),
                'Accept-Encoding': getReqHeader("Accept-Encoding"),
                'Connection': 'keep-alive',
                'Cache-Control': 'max-age=0'
            },
            cacheTtl: 3600 // 缓存时间
        };

        // 添加Authorization头
        if (request.headers.has("Authorization")) {
            parameter.headers.Authorization = getReqHeader("Authorization");
        }

        // 发起请求并处理响应
        let res = await fetch(new Request(url, request), parameter)

        // 修改 Www-Authenticate 头
        let auth = res.headers.get("Www-Authenticate");
        if (auth) {
            const newHeader = new Headers(res.headers)
            newHeader.set("Www-Authenticate", auth.replace(/https?:\/\/[a-zA-Z0-9\-.]+/, workers_url));
            return new Response(res.body, {
                status: res.status,
                headers: newHeader
            })
        }
        // 处理重定向
        if (res.headers.get("Location")) {
            console.log('重定向', res.headers.get("Location"));
            return httpHandler(request, res.headers.get("Location"))
        }
        return res
    }
};

/**
 * 处理HTTP请求
 * @param {Request} req 请求对象
 * @param {string} pathname 请求路径
 */
function httpHandler(req, pathname) {
    const reqHdrRaw = req.headers

    // 处理预检请求
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    let rawLen = ''

    const reqHdrNew = new Headers(reqHdrRaw)

    const urlObj = newUrl(pathname)

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'follow',
        body: req.body
    }
    return proxy(urlObj, reqInit, rawLen)
}

/**
 * 代理请求
 * @param {URL} urlObj URL对象
 * @param {RequestInit} reqInit 请求初始化对象
 * @param {string} rawLen 原始长度
 */
async function proxy(urlObj, reqInit, rawLen) {
    const res = await fetch(urlObj.href, reqInit)
    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    // 验证长度
    if (rawLen) {
        const newLen = resHdrOld.get('content-length') || ''
        const badLen = (rawLen !== newLen)

        if (badLen) {
            return makeRes(res.body, 400, {
                '--error': `bad len: ${newLen}, except: ${rawLen}`,
                'access-control-expose-headers': '--error',
            })
        }
    }
    const status = res.status
    resHdrNew.set('access-control-expose-headers', '*')
    resHdrNew.set('access-control-allow-origin', '*')
    resHdrNew.set('Cache-Control', 'max-age=1500')

    // 删除不必要的头
    resHdrNew.delete('content-security-policy')
    resHdrNew.delete('content-security-policy-report-only')
    resHdrNew.delete('clear-site-data')

    return new Response(res.body, {
        status,
        headers: resHdrNew
    })
}