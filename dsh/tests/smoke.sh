#!/bin/sh
set -eu
# 用法: smoke.sh [镜像] [full|lite]
# lite 跳过真实工具链下载与依赖已安装工具的段，供 qemu 慢速架构验证主流程。
image=${1:-dsh-persistence-test}
scope=${2:-full}
volume="dsh-test-$$"
container="dsh-test-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker volume create "$volume" >/dev/null

wait_for() {
  tries=0
  until docker exec "$container" "$@" >/dev/null 2>&1; do
    tries=$((tries + 1))
    test "$tries" -lt 120
    sleep 1
  done
}

stop_container() {
  docker stop -t 10 "$container" >/dev/null
  test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" != 137
  docker rm "$container" >/dev/null
}

# 镜像层固定模板；启动准备复制到用户 skill 根，已有用户版本不覆盖。
docker run --rm --entrypoint sh "$image" -ec '
  test -f /usr/local/share/dsh/skills/mzzsfy-dsh-help/SKILL.md
  test "$(tr -d "\\r" < /usr/local/share/dsh/skills/mzzsfy-dsh-help/SKILL.md | head -n 1)" = "---"
  tr -d "\\r" < /usr/local/share/dsh/skills/mzzsfy-dsh-help/SKILL.md | grep -q "^name: mzzsfy-dsh-help$"
'
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  test ! -e /root/.agents/skills/mzzsfy-dsh-help/SKILL.md
  dsh-env prepare
  test -f /root/.agents/skills/mzzsfy-dsh-help/SKILL.md
  cp /root/.agents/skills/mzzsfy-dsh-help/SKILL.md /tmp/SKILL.md
  printf user > /root/.agents/skills/mzzsfy-dsh-help/SKILL.md
  dsh-env prepare
  test "$(cat /root/.agents/skills/mzzsfy-dsh-help/SKILL.md)" = user
  cp /tmp/SKILL.md /root/.agents/skills/mzzsfy-dsh-help/SKILL.md
  rm /root/.agents/skills/mzzsfy-dsh-help/SKILL.md
  dsh-env prepare
  test ! -e /root/.agents/skills/mzzsfy-dsh-help/SKILL.md
  cp /tmp/SKILL.md /root/.agents/skills/mzzsfy-dsh-help/SKILL.md
'
# 用公开 apply 与真实构造器，按默认根解析；list 能发现释放到用户根的 skill。
docker run --rm --entrypoint node -v "$volume:/root" -w /usr/local/lib/node_modules/@deepseek-ai/dsh "$image" --input-type=module -e "
import { apply } from '@deepseek-ai/dsh-skill-filesystem'
let factory
const ctx = { skills: { registerProvider: (fn) => { factory = fn } }, effect: () => {}, on: () => {}, get: () => undefined, logger: { warn: () => {} } }
apply(ctx, { includeDefaultRoots: true, watch: false })
const provider = factory({ invalidate: () => {}, signal: new AbortController().signal })
const listed = await provider.list({ cwd: '/tmp/project' })
const candidates = Array.isArray(listed) ? listed : listed.candidates
console.log(JSON.stringify(candidates.map(({ name, source, rank }) => ({ name, source, rank }))))
const found = candidates.filter((candidate) => candidate.name === 'mzzsfy-dsh-help')
if (found.length !== 1 || found[0].source !== 'user-agents') process.exit(1)
"

# apt 包装记录新装目标，模拟与只下载不入清单，卸载取消目标；路径映射与钩子建立。
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

# 重建后恢复已记录目标，已卸载目标不再装回。
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

# apt 源快照：钩子已预置，快照包含新增源，缺失时恢复，已有内容保留，损坏快照不阻塞。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  test -f /etc/apt/apt.conf.d/99-dsh-source-snapshot
  printf "%s\n" "deb https://example.invalid/debian bookworm main" > /etc/apt/sources.list.d/custom.list
  dsh-env snapshot-apt-sources
  test -f /root/.persist/manifests/apt-sources.tar.gz
  tar -tzf /root/.persist/manifests/apt-sources.tar.gz | grep -q "etc/apt/sources.list.d/custom.list"
  node -e '\''if(require("/root/.persist/restore/status.json")===undefined)process.exit(0)'\''
  dsh-env status | grep -q "aptSourcesSnapshot"
  rm /etc/apt/sources.list.d/custom.list
  dsh-env restore
  test -f /etc/apt/sources.list.d/custom.list
  printf "%s\n" "deb https://keep.invalid/debian bookworm main" > /etc/apt/sources.list.d/custom.list
  dsh-env restore
  grep -q keep.invalid /etc/apt/sources.list.d/custom.list
  rm /etc/apt/sources.list.d/custom.list
  printf "%s\n" "corrupt" > /root/.persist/manifests/apt-sources.tar.gz
  dsh-env restore
  test -f /etc/apt/apt.conf.d/99-dsh-source-snapshot
  rm /root/.persist/manifests/apt-sources.tar.gz
'

# 修改镜像原有的源文件后重建，按快照恢复为改动后的内容；本容器内的新改动保留。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  printf "%s\n" "Types: deb" "URIs: https://mirror.invalid/debian" "Suites: bookworm" "Components: main" "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg" > /etc/apt/sources.list.d/debian.sources
  dsh-env snapshot-apt-sources
'
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  grep -q "deb.debian.org" /etc/apt/sources.list.d/debian.sources
  dsh-env restore
  grep -q "mirror.invalid" /etc/apt/sources.list.d/debian.sources
  rm /root/.persist/manifests/apt-sources.tar.gz
'

# 监督器：前置钩子、映射、服务创建与停止；重启后钩子仍生效。
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'trap "exit 0" TERM; while :; do sleep 1; done' >/dev/null
wait_for test -f /root/test1/after
docker exec "$container" sh -ec 'test -f /root/test1/before; test -L /data/test1'
stop_container

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
wait_for node -e 'process.exit(require("/root/.persist/restore/after-hook.json").phase === "failed" ? 0 : 1)'
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true
stop_container

# 忽略 TERM 的前置脚本仍需在 Docker 超时强杀前退出。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  rmdir /root/.dsh/container/after-start.sh
  printf "%s\n" "trap '\'' '\'' TERM" "touch /root/hook-running" "while :; do sleep 1; done" > /root/.dsh/container/before-start.sh
'
docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'touch /root/should-not-start' >/dev/null
wait_for test -f /root/hook-running
stop_container

# 中断日志来自旧容器时，核对不得清空其他待恢复目标。
docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
  node -e '\''const f=require("fs"), p="/root/.persist/manifests/", a=require("child_process").execSync("dpkg --print-architecture").toString().trim(), r="ripgrep:"+a, j="jq:"+a;f.writeFileSync(p+"apt.json",JSON.stringify([r,j]));f.writeFileSync(p+"inflight.json",JSON.stringify({container:"previous",before:{installed:[r,j],manual:[r,j]},cancelled:["jq"]}))'\''
  dsh-env reconcile
  node -e '\''const t=require("/root/.persist/manifests/apt.json"),a=require("child_process").execSync("dpkg --print-architecture").toString().trim();if(!t.includes("ripgrep:"+a)||t.includes("jq:"+a))process.exit(1)'\''
'

if [ "$scope" = full ]; then
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

  # 故意挂起已登记工具：服务必须先创建，停止时不能遗留安装进程。
  docker run --rm --entrypoint sh -v "$volume:/root" "$image" -ec '
    printf "%s\n" "exit 0" > /root/.dsh/container/before-start.sh
    printf "%s\n" "[]" > /root/.persist/manifests/apt.json
    mv /root/.local/share/mise/installs/go/1.24.3/bin/go /root/.local/share/mise/installs/go/1.24.3/bin/go.saved
    printf "%s\n" "#!/bin/sh" "test -f /root/service-started || exit 9" "touch /root/probe-running" "trap '\'' '\'' TERM" "while :; do sleep 1; done" > /root/.local/share/mise/installs/go/1.24.3/bin/go
    chmod +x /root/.local/share/mise/installs/go/1.24.3/bin/go
  '
  docker run -d --name "$container" --entrypoint dsh-env -v "$volume:/root" "$image" start /bin/sh -c 'touch /root/service-started; trap "exit 0" TERM; while :; do sleep 1; done' >/dev/null
  wait_for test -f /root/probe-running
  docker exec "$container" test -f /root/service-started
  stop_container

  # 损坏工具报告失败，但不阻止其他工具执行。
  docker run --rm --network none --entrypoint sh -v "$volume:/root" "$image" -ec '
    printf "%s\n" "#!/bin/sh" "exit 1" > /root/.local/share/mise/installs/go/1.24.3/bin/go
    if dsh-env maintain-tools; then exit 1; fi
    node -e '\''if(require("/root/.persist/restore/tools.json").phase !== "failed")process.exit(1)'\''
    dsh-env exec java -- java -version
  '
fi

echo "environment smoke tests passed ($scope)"
