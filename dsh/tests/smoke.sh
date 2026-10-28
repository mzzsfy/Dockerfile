#!/bin/sh
set -eu
image=${1:-dsh-persistence-test}
volume="dsh-test-$$"
container="dsh-test-$$"
fixtures=$(mktemp -d)
go_container="dsh-go-$$"
java_container="dsh-java-$$"
cleanup() {
  docker rm -f "$container" "$go_container" "$java_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$fixtures"
}
trap cleanup EXIT INT TERM
docker volume create "$volume" >/dev/null

docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  mkdir -p /root/.dsh/container
  printf "%s\n" /root/test1:/data/test1 > /root/.dsh/container/paths.txt
  printf "%s\n" "#!/bin/sh" "echo before > /data/test1/before" > /root/.dsh/container/before-start.sh
  printf "%s\n" "#!/bin/sh" "echo after > /data/test1/after" > /root/.dsh/container/after-start.sh
  apt-get update
  apt-get install -y --no-install-recommends ripgrep jq
  apt-get -ys remove ripgrep
  node -e '\''const t=require("/root/.persist/manifests/apt.json");if(!t.some(x=>x.startsWith("ripgrep:")))process.exit(1)'\''
  apt-get remove -y jq
'

docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  dsh-env prepare
  test -L /data/test1
  ! command -v rg
  dsh-env restore
  rg --version
  ! command -v jq
  apt-get remove -y ripgrep
'

docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  dsh-env restore
  ! command -v rg
  dsh-env prepare
  echo saved > /data/test1/file
'

# 使用真实发行目录验证白名单，测试镜像不预装工具链。
docker create --name "$go_container" golang:1.24-bookworm >/dev/null
docker cp "$go_container:/usr/local/go" "$fixtures/go"
docker create --name "$java_container" eclipse-temurin:21-jdk-jammy >/dev/null
docker cp "$java_container:/opt/java/openjdk" "$fixtures/jdk"
docker run --rm --entrypoint sh -v "$volume:/root" -v "$fixtures:/fixtures:ro" "$image" -ec '
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates libstdc++6 zlib1g
  dsh-env install go /fixtures/go
  dsh-env install jdk /fixtures/jdk
'
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  dsh-env restore
  dsh-env prepare
  /usr/local/go/bin/go version
  /opt/java/bin/java -version
  printf "%s\n" "package main" "func main() {}" > /root/hello.go
  /usr/local/go/bin/go run /root/hello.go
  printf "%s\n" "class Hello { public static void main(String[] args) {} }" > /root/Hello.java
  /opt/java/bin/javac /root/Hello.java
  /opt/java/bin/java -cp /root Hello
  test "$(cat /data/test1/file)" = saved
  dsh-env remove go
  dsh-env remove jdk
'

# 直接运行监督器，隔离 npm 插件下载与环境恢复验收。
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'trap "exit 0" TERM; while :; do sleep 1; done' >/dev/null
tries=0
until docker exec "$container" test -f /root/test1/after; do
  tries=$((tries + 1))
  test "$tries" -lt 60
  sleep 1
done
docker exec "$container" sh -ec 'test -f /root/test1/before; test -L /data/test1'
docker stop -t 10 "$container" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" != 137
docker rm "$container" >/dev/null

# 前置脚本失败必须阻止服务创建。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec 'printf "%s\n" "exit 7" > /root/.dsh/container/before-start.sh'
if docker run --rm --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'touch /root/should-not-start'; then
  echo '前置脚本失败未阻止启动' >&2
  exit 1
fi
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec 'test ! -e /root/should-not-start'
# 后置钩子路径形态错误仍保留服务。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  printf "%s\n" "exit 0" > /root/.dsh/container/before-start.sh
  rm /root/.dsh/container/after-start.sh
  mkdir /root/.dsh/container/after-start.sh
'
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'trap "exit 0" TERM; while :; do sleep 1; done' >/dev/null
tries=0
until docker exec "$container" node -e 'process.exit(require("/root/.persist/restore/after-hook.json").phase === "failed" ? 0 : 1)'; do
  tries=$((tries + 1))
  test "$tries" -lt 60
  sleep 1
done
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true
docker stop -t 10 "$container" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" != 137
docker rm "$container" >/dev/null

# 忽略TERM的前置脚本仍需在Docker超时强杀前退出。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  rmdir /root/.dsh/container/after-start.sh
  printf "%s\n" "trap '\'' '\'' TERM" "touch /root/hook-running" "while :; do sleep 1; done" > /root/.dsh/container/before-start.sh
'
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'touch /root/should-not-start' >/dev/null
tries=0
until docker exec "$container" test -f /root/hook-running; do
  tries=$((tries + 1))
  test "$tries" -lt 60
  sleep 1
done
docker stop -t 10 "$container" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" != 137
docker rm "$container" >/dev/null

# 中断日志来自旧容器时，核对不得清空其他待恢复目标。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  node -e '\''const f=require("fs"), p="/root/.persist/manifests/";f.writeFileSync(p+"apt.json",JSON.stringify(["ripgrep:amd64","jq:amd64"]));f.writeFileSync(p+"inflight.json",JSON.stringify({container:"previous",before:{installed:["ripgrep:amd64","jq:amd64"],manual:["ripgrep:amd64","jq:amd64"]},cancelled:["jq"]}))'\''
  dsh-env reconcile
  node -e '\''const t=require("/root/.persist/manifests/apt.json");if(!t.includes("ripgrep:amd64")||t.includes("jq:amd64"))process.exit(1)'\''
'
# 挂起的工具探测不能阻塞监督器响应停止信号。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  mkdir -p /root/.persist/tools/go/versions/hanging/bin
  printf "%s\n" "#!/bin/sh" "trap '\'' '\'' TERM" "touch /root/probe-running" "while :; do sleep 1; done" > /root/.persist/tools/go/versions/hanging/bin/go
  chmod +x /root/.persist/tools/go/versions/hanging/bin/go
  ln -s /root/.persist/tools/go/versions/hanging /root/.persist/tools/go/current
'
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'touch /root/should-not-start' >/dev/null
tries=0
until docker exec "$container" test -f /root/probe-running; do
  tries=$((tries + 1))
  test "$tries" -lt 60
  sleep 1
done
docker stop -t 10 "$container" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" != 137
docker rm "$container" >/dev/null

# 第二轮工具探测被停止后，不得继续创建服务。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  printf "%s\n" "exit 0" > /root/.dsh/container/before-start.sh
  rm -f /root/probe-running
  printf "%s\n" "#!/bin/sh" "if [ ! -f /root/probe-once ]; then touch /root/probe-once; exit 0; fi" "trap '\'' '\'' TERM" "touch /root/probe-running" "while :; do sleep 1; done" > /root/.persist/tools/go/versions/hanging/bin/go
'
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'touch /root/should-not-start; sleep 60' >/dev/null
tries=0
until docker exec "$container" test -f /root/probe-running; do
  tries=$((tries + 1))
  test "$tries" -lt 60
  sleep 1
done
docker stop -t 10 "$container" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" != 137
docker rm "$container" >/dev/null
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec 'test ! -e /root/should-not-start'

# 不可运行的白名单即使apt为空也不能报告ready。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  printf "%s\n" "#!/bin/sh" "exit 1" > /root/.persist/tools/go/versions/hanging/bin/go
  printf "%s\n" "[]" > /root/.persist/manifests/apt.json
  if dsh-env restore; then exit 1; fi
  node -e '\''if(require("/root/.persist/restore/status.json").phase !== "failed")process.exit(1)'\''
'
echo 'environment smoke tests passed'
