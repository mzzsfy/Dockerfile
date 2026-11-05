#!/bin/sh
set -eu
# 用法: ci.sh [镜像] [full|lite]
# 单元测试在镜像内运行，容器行为与产物保持一致；随后执行 smoke。
image=${1:-dsh-persistence-test}
scope=${2:-full}
root=$(cd "$(dirname "$0")/../.." && pwd)
docker run --rm --entrypoint sh -v "$root/dsh:/source:ro" "$image" -c 'node --test /source/tests/*.test.mjs'
sh "$root/dsh/tests/smoke.sh" "$image" "$scope"
