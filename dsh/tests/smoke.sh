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

# 真实后端安装；重建时断网，验证直接复用安装结果。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  dsh-env install go@1.24.3
  dsh-env install java@21
  dsh-env install python@3.13
  dsh-env list
  cp /root/.persist/toolchains/registry.json /root/registry-before.json
'
docker run --rm --network none --entrypoint sh -v "$volume:/root" "$image" -ec '
  . /usr/local/bin/dsh-environment.sh
  dsh-env prepare
  dsh-env maintain-tools
  cmp /root/registry-before.json /root/.persist/toolchains/registry.json
  go version
  java -version
  python --version
  printf "%s\n" "package main" "func main() {}" > /root/hello.go
  GOTOOLCHAIN=local go run /root/hello.go
  printf "%s\n" "class Hello { public static void main(String[] args) {} }" > /root/Hello.java
  javac /root/Hello.java
  java -cp /root Hello
  python -c "import ssl, sqlite3; print(ssl.OPENSSL_VERSION)"
  dsh-env exec java -- sh -ec '\''test -x "$JAVA_HOME/bin/java"'\''
  if dsh-env remove java@21; then exit 1; fi
  dsh-env exec go -- sh -c '\''dsh-env remove go@1.24.3; test "$?" -eq 75'\''
  test "$(cat /data/test1/file)" = saved
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
# 故意挂起已登记工具：服务必须先创建，停止时不能遗留安装进程。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  printf "%s\n" "exit 0" > /root/.dsh/container/before-start.sh
  printf "%s\n" "[]" > /root/.persist/manifests/apt.json
  mv /root/.local/share/mise/installs/go/1.24.3/bin/go /root/.local/share/mise/installs/go/1.24.3/bin/go.saved
  printf "%s\n" "#!/bin/sh" "test -f /root/service-started || exit 9" "touch /root/probe-running" "trap '\'' '\'' TERM" "while :; do sleep 1; done" > /root/.local/share/mise/installs/go/1.24.3/bin/go
  chmod +x /root/.local/share/mise/installs/go/1.24.3/bin/go
'
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'touch /root/service-started; trap "exit 0" TERM; while :; do sleep 1; done' >/dev/null
tries=0
until docker exec "$container" test -f /root/probe-running; do
  tries=$((tries + 1))
  test "$tries" -lt 60
  sleep 1
done
docker exec "$container" test -f /root/service-started
docker stop -t 10 "$container" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" != 137
docker rm "$container" >/dev/null

# 损坏工具报告失败，但不阻止其他工具执行。
docker run --rm --network none --entrypoint sh -v "$volume:/root" "$image" -ec '
  printf "%s\n" "#!/bin/sh" "exit 1" > /root/.local/share/mise/installs/go/1.24.3/bin/go
  if dsh-env maintain-tools; then exit 1; fi
  node -e '\''if(require("/root/.persist/restore/tools.json").phase !== "failed")process.exit(1)'\''
  dsh-env exec java -- java -version
'
echo 'environment smoke tests passed'
