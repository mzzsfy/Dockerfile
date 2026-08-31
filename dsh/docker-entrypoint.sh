#!/bin/sh
# 运行时自愈:profile 缺内置插件时从镜像内模板补齐,防止挂载卷覆盖 build 时数据
home="${DSH_HOME:-/root/.dsh}"
if [ ! -e "$home/profiles/web/node_modules/dsh-web-startup-auth" ]; then
  mkdir -p "$home"
  cp -a -n /opt/dsh-profile/. "$home/"
fi
exec dsh web --no-open --host 0.0.0.0
