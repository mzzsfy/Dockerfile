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
for p in dshmarket dsh-web-startup-auth; do
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
exec dsh web --no-open --host 0.0.0.0
