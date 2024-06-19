//从 https://github.com/adysec/cf-mirror 修改

const custom = {
    //路径:[镜像地址,替换路径]
    'ubuntu/security': ['http://security.ubuntu.com', 'ubuntu'],
    'ubuntu': ['http://archive.ubuntu.com', 'ubuntu'],
    'centos': ['http://vault.centos.org', ''],
    'epel': ['http://mirrors.kernel.org', 'fedora-epel'],
    'deepin': ['https://community-packages.deepin.com', 'deepin'],
    'kali': ['http://http.kali.org', 'kali'],
    'debian-debug': ['https://community-packages.deepin.com', 'debian-debug'],
    'debian-ports': ['https://community-packages.deepin.com', 'debian-ports'],
    'debian-security-debug': ['https://community-packages.deepin.com', 'debian-security-debug'],
    'debian-security': ['https://community-packages.deepin.com', 'debian-security'],
    'debian': ['http://ftp.debian.org', 'debian'],
    'manjaro': ['http://ftp.tsukuba.wide.ad.jp', 'manjaro'],
    'gnu': ['https://lists.gnu.org', 'archive/html'],
    'openwrt': ['https://archive.openwrt.org', ''],
    'KaOS': ['https://ca.kaosx.cf', ''],
    'arch4edu': ['https://arch4edu.org', ''],
    'archlinuxcn': ['https://repo.archlinuxcn.org', ''],
    'bioarchlinux': ['https://repo.bioarchlinux.org', ''],
    'archlinuxarm': ['http://dk.mirror.archlinuxarm.org', ''],
    'archlinux': ['https://mirror.pkgbuild.com', ''],
    'fedora': ['https://ap.edge.kernel.org', 'fedora'],
    'OpenBSD': ['https://cdn.openbsd.org', 'pub/OpenBSD'],
    'opensuse': ['http://download.opensuse.org', ''],
    'freebsd': ['https://download.freebsd.org', ''],
    'pypi': ['https://pypi.org', 'simple'],
    'rust': ['https://static.rust-lang.org', 'simple'],
    'docker-ce': ['https://download.docker.com', ''],
}

function allPaths() {
    let paths = []
    for (const [path, [mirror, replace]] of Object.entries(custom)) {
        paths.push([path, mirror, replace])
    }
    return paths
}

function indexHtml(requestUrl) {
    let hostname = "https://"+requestUrl.hostname;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>聚合镜像源</title>
</head>
<body>
这是一个聚合镜像站，包含以下路径：
<pre>
${allPaths().map(([path, mirror, replace]) => "路径: /" + path + " 对应目标地址: " + mirror).join('\n')}
</pre>
<pre>

使用例子：

ubuntu22.04:
修改/etc/apt/sources.list为
deb ${hostname}/ubuntu jammy main restricted
deb ${hostname}/ubuntu jammy-updates main restricted
deb ${hostname}/ubuntu jammy-security main restricted

debian11:
修改/etc/apt/sources.list为
deb ${hostname}/debian/ bullseye main non-free contrib
deb-src ${hostname}/debian/ bullseye main non-free contrib
deb ${hostname}/debian-security/ bullseye-security main
deb-src ${hostname}/debian-security/ bullseye-security main
deb ${hostname}/debian/ bullseye-updates main non-free contrib
deb-src ${hostname}/debian/ bullseye-updates main non-free contrib
deb ${hostname}/debian/ bullseye-backports main non-free contrib
deb-src ${hostname}/debian/ bullseye-backports main non-free contrib

python pypi:
执行命令: pip config --global set global.index-url ${hostname}/pypi

</pre>
</body>
</html>
`}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url)

        // 处理根目录请求
        if (url.pathname === '/') {
            //返回更多说明
            return new Response(indexHtml(url), {status: 200, headers: {'Content-Type': 'text/html; charset=utf-8'}})
        }
        let path1 = url.pathname.substring(1)
        for (const [path, [mirror, replace]] of Object.entries(custom)) {
            if (path1.startsWith(path)) {
                return await fetch(mirror + path1.replace(path, replace)+url.search, {
                    headers: request.headers,
                    method: request.method,
                    body: request.body,
                    redirect: 'follow'
                })
            }
        }
        // 其他情况返回 404 Not Found
        return new Response('Not Found', {status: 404})
    }
}
