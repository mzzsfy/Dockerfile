#!/bin/sh
# 首次启动按 bundle 注册探测内置插件,缺失则在线安装,已装则跳过
home="${DSH_HOME:-/root/.dsh}"
pkg="$home/profiles/web/package.json"
# 运行期默认冷静期,用户未配置时启用
default_age=$((60 * 6))
# 安装前记录原始冷静期,用于完成后还原
orig=$(pnpm config get minimumReleaseAge --global)
# 插件经 pnpm 安装,pnpm 11 默认发布冷静期会使插件版本滞后于 npm 安装的主程序,安装阶段取消
pnpm config set minimumReleaseAge 0 --global || echo "warning: failed to clear minimumReleaseAge, plugin versions may lag behind dsh"
for p in dshmarket dsh-web-startup-auth @mzzsfy/dsh-auto-trust-all; do
  node -e '
    const fs = require("fs")
    try {
      const bundles = ((JSON.parse(fs.readFileSync(process.argv[1])).dsh || {}).profile || {}).bundles || []
      process.exit(bundles.includes(process.argv[2]) ? 0 : 1)
    } catch {
      process.exit(1)
    }
  ' "$pkg" "$p" || {
    echo "installing plugin: $p"
    dsh plugin --profile web add "$p" < /dev/null
  }
done
# 未设置或为脚本默认冷静期时写脚本值,否则保留用户配置
case $orig in
  "" | undefined | "$default_age")
    pnpm config set minimumReleaseAge $default_age --global || echo "warning: failed to restore minimumReleaseAge, runtime installs run unprotected"
    ;;
  *)
    pnpm config set minimumReleaseAge "$orig" --global || echo "warning: failed to restore user minimumReleaseAge, runtime installs run unprotected"
    ;;
esac
# 监听地址归部署层,按宿主代际选启动命令(两代绑定面不兼容):
# 0.2.0 线 CLI 拒 --host 0.0.0.0 且 schema 只收 127.0.0.1/0.0.0.0,不传 --host,
# 非回环绑定依赖旧版插件(<=0.3.x)的 bundle patch 翻转缺省值;
# 0.2.1+ 线拒通配绑定,插件不再碰绑定:DSH_HOST 显式指定优先,缺省取首个非内部
# IPv4(bridge -p 发布端口可达,host 网络绑 NAS LAN IP),无则回落回环
dsh_pkg="$(npm root -g)/@deepseek-ai/dsh/package.json"
case $(node -p "require(process.argv[1]).version" "$dsh_pkg") in
  0.2.0*)
    if [ -n "$DSH_HOST" ]; then
      exec dsh web --no-open --host "$DSH_HOST"
    fi
    exec dsh web --no-open
    ;;
  *)
    if [ -z "$DSH_HOST" ]; then
      DSH_HOST=$(node -e '
        const os = require("os")
        for (const name of Object.keys(os.networkInterfaces())) {
          for (const info of os.networkInterfaces()[name] || []) {
            if (!info.internal && info.family === "IPv4") { console.log(info.address); process.exit(0) }
          }
        }
        console.log("127.0.0.1")
      ')
    fi
    exec dsh web --no-open --host "$DSH_HOST"
    ;;
esac
