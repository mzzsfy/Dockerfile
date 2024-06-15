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
        const {pathname, search} = url;
        if (!env['upstream_url']){
            return new Response('环境变量upstream_url未设置,格式：https://xxxx.com')
        }
        return fetch(new Request(env['upstream_url'] + pathname + search, {
            body: request.body,
            headers: request.headers,
            method: request.method,
            redirect: request.redirect
        }));
    }
};
