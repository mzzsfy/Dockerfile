#!/bin/sh
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}:/usr/local/go/bin:/opt/java/bin"
exec /usr/local/bin/node /usr/local/lib/dsh-env/environment.mjs start /usr/local/bin/dsh-start.sh
