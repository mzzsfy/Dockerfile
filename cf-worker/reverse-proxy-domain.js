// 泛域名反代
// 在环境变量中添加 @域名前缀，例如@github=https://github.com/,则访问https://github.xxxx.xxx/时，实际访问https://github.com/
// 添加blocked_region环境变量可以屏蔽某些地区访问,如@locked_region=US,CA,则屏蔽美国和加拿大访问
// 支持@blocked_region@域名前缀单独设置某个域名的规则,如@blocked_region@github=CN,则github.xxxx.xxx屏蔽中国访问
// 支持blocked_ip单独屏蔽某个ip,例如@blocked_ip=1.1.1.1,2.2.2.2,则屏蔽1.1.1.1和2.2.2.2访问
// 默认支持@blocked_ip@域名前缀单独设置某个域名的规则

export default {
    async fetch(request, env, ctx) {
        if (env['blocked_region']) {
            const region = request.headers.get('cf-ipcountry').toUpperCase();
            if (env['blocked_region'].split(',').some(s => s === region)) {
                return new Response('Access denied: Your region is blocked.', {
                    status: 403
                });
            }
        }
        if (env['blocked_ip']) {
            const ip = request.headers.get('cf-connecting-ip');
            if (env['blocked_ip'].split(',').some(s => s === ip)) {
                return new Response('Access denied: Your IP is blocked.', {
                    status: 403
                });
            }
        }
        const url = new URL(request.url);
        new URL(request.url)
        let name = url.hostname.split('.')[0];
        let target = env['@' + name];
        if (!target) {
            return new Response('Not Found', {
                status: 404
            });
        }
        if (env['@blocked_region@' + name]) {
            const region = request.headers.get('cf-ipcountry').toUpperCase();
            if (env['blocked_region'].split(',').some(s => s === region)) {
                return new Response('Access denied: Your region is blocked.', {
                    status: 403
                });
            }
        }
        if (env['@blocked_ip@' + name]) {
            const ip = request.headers.get('cf-connecting-ip');
            if (env['blocked_ip'].split(',').some(s => s === ip)) {
                return new Response('Access denied: Your IP is blocked.', {
                    status: 403
                });
            }
        }
        return fetch(new Request(target + url.pathname + url.search, {
            body: request.body,
            headers: request.headers,
            method: request.method,
            redirect: request.redirect
        }));
    }
};
