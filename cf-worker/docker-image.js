'use strict'

//环境变量whitelist控制允许访问的Docker仓库,默认为空允许全部,格式为:"xxx/xxx",官方为library
//例: library/,mzzsfy/,abc/bcd 为允许访问官方和mzzsfy所有镜像,外加abc/bcd这个镜像

//环境变量 strictDomain=true 表示仅允许使用已知的域名访问
//环境变量 defaultIndex设置默认主页上游地址,如: https://hub.docker.com


// 在cf部署中,使用泛域名或多触发器可以让同一个脚本可以支持多个镜像仓库,
// 如: k8s.xxx.xxx为访问k8s镜像仓库,docker.xxx.xxx为访问docker主镜像仓库
const customizeRoutes = {
    "quay": "quay.io",
    "gcr": "gcr.io",
    "k8s-gcr": "k8s.gcr.io",
    "k8s": "registry.k8s.io",
    "ghcr": "ghcr.io",
    "cloudsmith": "docker.cloudsmith.io",
    "docker": "registry-1.docker.io",
};

// 默认使用的镜像仓库
const defaultHost = 'docker'

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
        if (!name.includes('/')) {
            name = 'library/' + name
        }
        if (!env['whitelist'].split(',').some(e => name.startsWith(e))) {
            console.log("非白名单镜像,拒绝访问", name)
            return new Response('access denied', {status: 404})
        }
    }
    let paths = url.pathname.split('/');
    if (paths[paths.length - 1].includes('.')) {
        let oldUrl = url.href;
        url.hostname = paths[paths.length - 1];
        url.pathname = paths.slice(0, paths.length - 1).join('/')
        console.log("修改host", oldUrl, url.href)
    }
    let token_parameter = {
        headers: {
            'User-Agent': getReqHeader("User-Agent"),
            'Accept': getReqHeader("Accept"),
            'Accept-Language': getReqHeader("Accept-Language"),
            'Accept-Encoding': getReqHeader("Accept-Encoding"),
            'Connection': 'keep-alive',
            'Cache-Control': 'max-age=0'
        }
    };
    return fetch(new Request(url.href, request), token_parameter)
}

export default {
    async fetch(request, env, ctx) {
        let url = new URL(request.url); // 解析请求URL
        let hostname = url.hostname.split('.')[0];
        let route = customizeRoutes[hostname];
        if (!route && env['strictDomain'] === 'true') {
            return new Response('access denied', {
                status: 401, headers: {},
            });
        }
        route = route || customizeRoutes[defaultHost]
        const getReqHeader = (key) => request.headers.get(key); // 获取请求头

        let workers_url = `https://${url.hostname}`;
        const pathname = url.pathname;
        //浏览器访问
        if (pathname === '/' || getReqHeader('Origin') || getReqHeader('Referer')) {
            if (env['defaultIndex']) {
                let url1 = new URL(env['defaultIndex']);
                if (url.pathname === "/" && url1.pathname !== '/') {
                    return new Response('', {
                        status: 302, headers: {
                            'location': url1.pathname,
                        }
                    })
                }
                url1.pathname = url.pathname
                url1.search = url.search
                return fetch(url1.href, {
                    redirect: 'follow',
                    headers: request.headers,
                    method: request.method,
                    body: request.body,
                })
            }
            return new Response('ok', {
                status: 200, headers: {},
            });
        }
        if (pathname.includes('/token') && url.searchParams.has('scope')) {
            return token(request, url, env, ctx)
        }
        if (env['whitelist']) {
            let l = 0
            if (pathname.endsWith('/manifests/latest')) {
                l = 17
            } else if (pathname.endsWith('/blobs/sha256:REDACTED')) {
                l = 22
            }
            let name = pathname.substring(4).substring(0, pathname.length - 4 - l);
            if (!name.includes('/')) {
                name = 'library/' + name
            }
            if (!env['whitelist'].split(',').some(e => name.startsWith(e))) {
                console.log("非白名单镜像,拒绝访问", name)
                return new Response('access denied', {status: 403})
            }
        }
        url.hostname = route;
        // 构造请求参数
        let parameter = {
            headers: {
                'User-Agent': getReqHeader("User-Agent"),
                'Accept': getReqHeader("Accept"),
                'Accept-Language': getReqHeader("Accept-Language"),
                'Accept-Encoding': getReqHeader("Accept-Encoding"),
                'Connection': 'keep-alive',
                'Cache-Control': 'max-age=0'
            }, cacheTtl: 3600 // 缓存时间
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
            let newAuth = auth.replace(/https?:\/\/([a-zA-Z0-9\-.]+)([\w/]+)/, workers_url + "$2/$1");
            newHeader.set("Www-Authenticate", newAuth);
            console.log("修改Authenticate", auth, "->", newAuth)
            if (pathname === '/v2/' && url.searchParams.size === 0) {
                let t = await res.text();
                console.log("res", t)
                return new Response(t, {
                    status: res.status, headers: newHeader
                })
            }
            return new Response(res.body, {
                status: res.status, headers: newHeader
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
    if (req.method === 'OPTIONS' && reqHdrRaw.has('access-control-request-headers')) {
        return new Response(null, PREFLIGHT_INIT)
    }

    let rawLen = ''

    const reqHdrNew = new Headers(reqHdrRaw)

    const urlObj = newUrl(pathname)

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method, headers: reqHdrNew, redirect: 'follow', body: req.body
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
                '--error': `bad len: ${newLen}, except: ${rawLen}`, 'access-control-expose-headers': '--error',
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
        status, headers: resHdrNew
    })
}
