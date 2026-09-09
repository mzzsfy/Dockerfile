#!/usr/bin/env bash
# check-upstream.sh 单元测试: bash check-upstream.test.sh <被测脚本路径>
set -u

SCRIPT="${1:-$(dirname "$0")/check-upstream.sh}"
if [ ! -f "$SCRIPT" ]; then
    echo "usage: $0 <check-upstream.sh path>" >&2
    exit 1
fi

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
export GITHUB_OUTPUT="$OUT"

pass=0
fail=0

run_case() {
    local desc="$1" expect="$2" trigger="$3" ours="${4:-}"
    if [ $# -gt 4 ]; then
        shift 4
    else
        shift $#
    fi
    : > "$OUT"
    TRIGGER="$trigger" bash "$SCRIPT" "$ours" "$@" >/dev/null 2>&1
    local got
    got=$(sed -n 's/^skip=//p' "$OUT")
    if [ "$got" = "$expect" ]; then
        pass=$((pass + 1))
        echo "PASS: $desc"
    else
        fail=$((fail + 1))
        echo "FAIL: $desc expect=$expect got=$got"
    fi
}

# 与各上游 API 实测格式一致的时间样本
hour=$((60 * 60))
t_now=$(date +%s)
fmt() { date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ'; }
t_old=$(fmt $((t_now - 2 * hour)))
t_new=$(fmt $((t_now - 30 * 60)))
t_older=$(fmt $((t_now - 3 * hour)))
ours_now=$(fmt "$t_now")
ours_old=$(fmt $((t_now - 2 * hour)))
hub_ms=$(date -u -d "$t_old" '+%Y-%m-%dT%H:%M:%S.%NZ')
npm_ms=$(date -u -d "$t_old" '+%Y-%m-%dT%H:%M:%S.000Z')

run_case "上游2h前更新,镜像刚构建,应跳过" true schedule "$ours_now" "$t_old"
run_case "上游30m前更新,不足余量,应构建" false schedule "$ours_now" "$t_new"
run_case "上游比镜像新,应构建" false schedule "$ours_old" "$t_now"
run_case "手动触发,无条件构建" false workflow_dispatch "$ours_now" "$t_old"
run_case "手动触发,上游全旧,仍构建" false workflow_dispatch "$ours_now" "$t_old" "$t_older"
run_case "镜像时间缺失,放行构建" false schedule "" "$t_old"
run_case "镜像时间畸形解析失败,放行构建" false schedule "not-a-time" "$t_old"
run_case "无上游实参,守卫放行,应构建" false schedule "$ours_now"
run_case "上游时间全缺失,放行构建" false schedule "$ours_now" "" ""
run_case "上游部分缺失,任一缺失即放行,应构建" false schedule "$ours_now" "" "$t_old"
run_case "上游部分缺失含新时间,应构建" false schedule "$ours_now" "" "$t_new" "$t_older"
run_case "畸形时间串解析失败,放行构建" false schedule "$ours_now" "not-a-time"
run_case "上游早余量1秒,已足余量,应跳过" true schedule "$ours_now" "$(fmt $((t_now - hour - 1)))"
run_case "上游恰好整余量,不足严格小于,应构建" false schedule "$ours_now" "$(fmt $((t_now - hour)))"
run_case "Hub毫秒格式可解析,应跳过" true schedule "$ours_now" "$hub_ms"
run_case "npm毫秒格式可解析,应跳过" true schedule "$ours_now" "$npm_ms"
run_case "多上游取max:全旧,应跳过" true schedule "$ours_now" "$t_old" "$t_older"
run_case "多上游取max:含新,应构建" false schedule "$ours_now" "$t_old" "$t_new"
run_case "空参调用不崩溃,放行构建" false schedule

# 真零参调用,覆盖 $#=0 分支
: > "$OUT"
TRIGGER=schedule bash "$SCRIPT" >/dev/null 2>&1
if [ "$(sed -n 's/^skip=//p' "$OUT")" = "false" ]; then
    pass=$((pass + 1))
    echo "PASS: 真零参调用不崩溃,放行构建"
else
    fail=$((fail + 1))
    echo "FAIL: 真零参调用不崩溃,放行构建"
fi

echo "----"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
