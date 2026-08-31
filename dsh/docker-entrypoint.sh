#!/bin/sh
# 首次启动按 bundle 注册探测内置插件,缺失则在线安装,已装则跳过
home="${DSH_HOME:-/root/.dsh}"
pkg="$home/profiles/web/package.json"
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
exec dsh web --no-open --host 0.0.0.0
