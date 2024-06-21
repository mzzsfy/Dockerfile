//从 https://github.com/adysec/cf-mirror 修改

//泛域名规则
const custom = {
    //路径:目标地址
    'ubuntu-security': 'http://security.ubuntu.com',
    'ubuntu': 'http://archive.ubuntu.com',
    'centos': 'http://vault.centos.org',
    'epel': 'http://mirrors.kernel.org',
    'deepin': 'https://community-packages.deepin.com',
    'kali': 'http://http.kali.org',
    'debian-debug': 'https://community-packages.deepin.com',
    'debian-ports': 'https://community-packages.deepin.com',
    'debian-security-debug': 'https://community-packages.deepin.com',
    'debian-security': 'https://community-packages.deepin.com',
    'debian': 'http://ftp.debian.org',
    'manjaro': 'http://ftp.tsukuba.wide.ad.jp',
    'gnu': 'https://lists.gnu.org',
    'openwrt': 'https://archive.openwrt.org',
    'kaos': 'https://ca.kaosx.cf',
    'arch4edu': 'https://arch4edu.org',
    'archlinuxcn': 'https://repo.archlinuxcn.org',
    'bioarchlinux': 'https://repo.bioarchlinux.org',
    'archlinuxarm': 'http://dk.mirror.archlinuxarm.org',
    'archlinux': 'https://mirror.pkgbuild.com',
    'fedora': 'https://ap.edge.kernel.org',
    'openbsd': 'https://cdn.openbsd.org',
    'opensuse': 'http://download.opensuse.org',
    'freebsd': 'https://download.freebsd.org',
    'pypi': 'https://pypi.org',
    'rust': 'https://static.rust-lang.org',
    'docker-ce': 'https://download.docker.com',
}

function allPaths() {
    let paths = []
    for (const [path, target] of Object.entries(custom)) {
        paths.push([path, target])
    }
    return paths
}

function indexHtml(requestUrl, baseHostname) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>聚合镜像源</title>
</head>
<body>
这是一个聚合镜像站，包含以下域名：
<pre>
${allPaths().map(([path, target]) => "域名: https://" + path + '.' + baseHostname + " 对应目标地址: " + target).join('\n')}
</pre>
<pre>

使用例子：

ubuntu22.04:
修改/etc/apt/sources.list为
deb https://ubuntu.${baseHostname}/ubuntu jammy main restricted
deb https://ubuntu.${baseHostname}/ubuntu jammy-updates main restricted
deb https://ubuntu.${baseHostname}/ubuntu jammy-security main restricted

debian11:
修改/etc/apt/sources.list为
deb https://debian.${baseHostname}/debian bullseye main non-free contrib
deb-src https://debian-security.${baseHostname}/debian-security bullseye main non-free contrib
deb https://debian.${baseHostname}/debian bullseye-security main
deb-src https://debian-security.${baseHostname}/debian-security bullseye-security main
deb https://debian.${baseHostname}/debian bullseye-updates main non-free contrib
deb-src https://debian-security.${baseHostname}/debian-security bullseye-updates main non-free contrib
deb https://debian.${baseHostname}/debian bullseye-backports main non-free contrib
deb-src https://debian-security.${baseHostname}/debian-security bullseye-backports main non-free contrib

python pypi:
执行命令: pip config --global set global.index-url https://pypi.${baseHostname}/simple
</pre>
</body>
</html>
`
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url)
        let hostnames = url.hostname.split('.');
        const name = hostnames[0]
        const baseHostname = hostnames.slice(1).join('.')
        let target = custom[name];
        if (target) {
            return await fetch(target + url.pathname + url.search, {
                headers: request.headers,
                method: request.method,
                body: request.body,
                redirect: 'follow'
            })
        }
        // 处理根目录请求
        if (url.pathname === '/') {
            //返回更多说明
            return new Response(indexHtml(url, baseHostname), {
                status: 200,
                headers: {'Content-Type': 'text/html; charset=utf-8'}
            })
        }
        // 其他情况返回 404 Not Found
        return new Response('Not Found', {status: 404})
    }
}
