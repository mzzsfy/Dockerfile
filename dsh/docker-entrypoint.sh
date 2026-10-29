#!/bin/sh
. /usr/local/bin/dsh-environment.sh

if [ "${1:-}" = --prepare ]; then
  home="${DSH_HOME:-/root/.dsh}"
  pkg="$home/profiles/web/package.json"
  default_age=$((60 * 6))
  orig=$(pnpm config get minimumReleaseAge --global)
  pnpm config set minimumReleaseAge 0 --global || echo "warning: failed to clear minimumReleaseAge, plugin versions may lag behind dsh"
  for p in dshmarket dsh-web-startup-auth @mzzsfy/dsh-auto-trust-all; do
    /usr/local/bin/node -e '
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

exec /usr/local/bin/node /usr/local/lib/dsh-env/environment.mjs start-dsh
