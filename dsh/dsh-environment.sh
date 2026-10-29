#!/bin/sh
# 用 . 加载，只设置当前 shell 的环境，不启动服务。
: "${PATH:=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
case ":$PATH:" in
  *:/usr/local/lib/dsh-env/bin:*) ;;
  *) PATH="/usr/local/lib/dsh-env/bin:$PATH" ;;
esac
case ":$PATH:" in
  *:/root/.local/bin:*) ;;
  *) PATH="$PATH:/root/.local/bin" ;;
esac
case ":$PATH:" in
  *:/root/.cargo/bin:*) ;;
  *) PATH="$PATH:/root/.cargo/bin" ;;
esac
export PATH
