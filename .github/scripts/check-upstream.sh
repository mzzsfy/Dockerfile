#!/usr/bin/env bash
# 定时构建上游更新检查
# 用法: check-upstream.sh <本地镜像时间> [上游时间...]
# 输出: skip=true 表示上游未更新应跳过构建推送
# 本地镜像时间取自 Docker Hub tag 的 tag_last_pushed,上游时间来自各上游源
# 时间比较方向: 上游时间加余量后仍早于本地镜像时间才跳过,保证不漏构建
set -u

# 余量覆盖 GitHub/npm/Docker Hub 跨服务时钟偏差
margin=$((60 * 60))

to_epoch() {
    date -d "$1" +%s 2>/dev/null || echo 0
}

skip=false
ours_time="${1:-}"
if [ $# -gt 0 ]; then
    shift
fi

# 仅定时触发时检查;手动触发视为强制构建
if [ "${TRIGGER:-}" = "schedule" ] && [ -n "$ours_time" ]; then
    ours_epoch=$(to_epoch "$ours_time")
    upstream_epoch=0
    upstream_complete=true
    for t in "$@"; do
        # 任一上游时间缺失或解析失败均视为查询失败,放行构建,检查机制故障不导致任务停摆
        if [ -z "$t" ]; then
            upstream_complete=false
            continue
        fi
        e=$(to_epoch "$t")
        if [ "$e" -eq 0 ]; then
            upstream_complete=false
        fi
        if [ "$e" -gt "$upstream_epoch" ]; then
            upstream_epoch=$e
        fi
    done
    if [ "$upstream_complete" = true ] && [ "$upstream_epoch" -gt 0 ] && [ $((upstream_epoch + margin)) -lt "$ours_epoch" ]; then
        skip=true
    fi
fi

echo "skip=$skip" >> "$GITHUB_OUTPUT"
