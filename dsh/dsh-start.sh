#!/bin/sh
if [ "$1" = --prepare ]; then
home="${DSH_HOME:-/root/.dsh}"
pkg="$home/profiles/web/package.json"
default_age=$((60 * 6))
orig=$(pnpm config get minimumReleaseAge --global)
pnpm config set minimumReleaseAge 0 --global || echo "warning: failed to clear minimumReleaseAge, plugin versions may lag behind dsh"
for p in dshmarket dsh-web-startup-auth @mzzsfy/dsh-auto-trust-all; do
  node -e '
    const fs = require("fs")
    try {
      const bundles = ((JSON.parse(fs.readFileSync(process.argv[1])).dsh || {}).profile || {}).bundles || []
      process.exit(bundles.includes(process.argv[2]) ? 0 : 1)
    } catch { process.exit(1) }
  ' "$pkg" "$p" || {
    echo "installing plugin: $p"
    dsh plugin --profile web add "$p" < /dev/null
  }
done
case $orig in
  "" | undefined | "$default_age") pnpm config set minimumReleaseAge "$default_age" --global || echo "warning: failed to restore minimumReleaseAge" ;;
  *) pnpm config set minimumReleaseAge "$orig" --global || echo "warning: failed to restore user minimumReleaseAge" ;;
esac
exit 0
fi
dsh_pkg="$(npm root -g)/@deepseek-ai/dsh/package.json"
case $(node -p "require(process.argv[1]).version" "$dsh_pkg") in
  0.2.0*)
    if [ -n "$DSH_HOST" ]; then exec dsh web --no-open --host "$DSH_HOST"; fi
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
