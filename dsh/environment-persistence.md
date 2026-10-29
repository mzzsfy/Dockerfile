# 软件环境、目录映射与启动钩子

## 状态与范围

本文对应当前工作树的新工具链包装，尚未发布。镜像固定 Debian bookworm，内置固定版本 mise 作为内部后端，不预装 Go、Java、Python，不修改现有 DSH 插件流程。用户通过 `dsh-env` 管理工具链，普通系统软件仍用 apt。

本地测试使用受控后端替身验证事务和版本行为；真实 Linux 安装、flock 和信号处理需通过容器测试验证。本机无 Docker，不能把测试脚本已编写当成容器验收通过。

## 数据卷与目录

在仓库根目录执行：

```sh
docker build -t dsh-local ./dsh
docker run -d --name dsh -p 3080:3080 -v dsh-home:/root dsh-local
```

重建时复用同一个卷，一个卷只供一个活跃容器使用。原先挂载 `/root/.dsh` 的卷不能直接改挂 `/root`，需备份并将数据放入新卷的 `.dsh` 子目录。主目录以外的项目和数据应另行挂载。

| 路径 | 用途 |
|---|---|
| `/root/.local/share/mise` | 后端安装的完整工具链文件 |
| `/root/.persist/toolchains` | 包装器版本要求、精确默认版本、隔离配置 |
| `/root/.cache/mise` | 工具安装缓存 |
| `/root/.persist/manifests` | apt 恢复目标、中断记录和协调锁 |
| `/root/.persist/apt-cache` | apt 下载缓存 |
| `/root/.persist/restore` | apt、工具、后置脚本各自的状态 |
| `/root/.dsh/container` | 用户路径映射和固定钩子 |

安装结果直接保留；重建不重新复制完整工具目录。DSH、宿主 Node、pnpm、mise 本体留在镜像内。不要手工修改内部注册表或用裸 mise 卸载包装器管理的工具。

## 工具链接口

```sh
dsh-env install go
dsh-env install java@21
dsh-env install python@3.13
dsh-env list
dsh-env upgrade java
dsh-env upgrade
```

白名单仅 Go、Temurin Java、Python；`jdk` 是 Java 别名。不接受任意插件后端、路径或 shell 表达式。Java 默认 Temurin 21；Go/Python 不指定版本时查询最新稳定版本，并把解析出的 major.minor 保存为维护范围。

一至两段数字为请求范围，三段及以上固定补丁；Java 构建号如 `temurin-21.0.9+11` 原样保存。Java 不带 build 的固定补丁可解析对应 build。`upgrade` 默认遵守当前记录的范围，固定补丁不升级；范围内更新仍属于用户主动升级，重建不会执行它。

安装流程为解析精确版本、安装、检查真实命令、原子保存默认选择。任何一步失败都不把新版本设为默认；后端可能留下未登记的文件，不自动删除。批量升级逐工具提交，某项失败不会回滚此前已成功项。

```sh
dsh-env install java@25
dsh-env use java@21
dsh-env remove java@25
dsh-env exec java@21 -- ./gradlew build
```

`use` 只选择已登记版本，不下载；范围匹配多个版本时选最高并提示。`remove` 拒绝当前默认版本，需先切换；本版没有清空最后一个默认版本的接口。卸载成功后才删除记录。旧版本不会自动清理，磁盘占用需用户管理。

写操作和后台工具恢复串行；命令执行使用同一个注册表快照构建环境和可执行路径。包装器启动的任务持有使用锁，`remove` 遇到任何包装任务正在运行时立即失败，防止删除正在使用的文件和嵌套调用死锁。直接执行安装目录二进制不受此保护。

`list` 返回版本、请求范围、current、安装路径和安装目录存在状态；不检查主二进制是否完整，也不执行运行检查。`status` 中的工具检查结果是上次维护快照，不是实时项目健康证明。

## 环境脚本与启动脚本

环境设置与服务启动分离：

```sh
# 在用户脚本中加载，只改变当前 shell 环境
. /usr/local/bin/dsh-environment.sh
```

环境脚本幂等补充 `/usr/local/lib/dsh-env/bin`、用户命令目录和 Cargo bin，保留原 PATH；不执行版本检查或启动服务。`docker-entrypoint.sh` 加载它，再启动监督器。用户自定义入口完成准备后可 `exec /usr/local/bin/docker-entrypoint.sh`。

`docker exec` 不继承入口修改的环境：

```sh
docker exec dsh sh -c '. /usr/local/bin/dsh-environment.sh; go version'
docker exec dsh dsh-env exec python -- python --version
```

代理支持 go/gofmt、java/javac/jar/javadoc/jshell、python/python3/pip/pip3。已管理工具优先使用精确默认版本，缺失时拒绝系统回退；未管理工具使用系统 PATH 中的真实程序。附带工具缺失不阻止目标工具执行。系统 `/usr/bin/java`、`/usr/bin/python3` 等不被替换。

代理与 `exec` 为所启动的子进程准备工具环境，包括 JAVA_HOME；环境脚本不把父 shell 的 JAVA_HOME 写死。需要完整环境的 Maven/Gradle 等任务用 `dsh-env exec java -- COMMAND`。切换不会重启已有进程或构建 daemon。

包装器禁用 mise 的外部配置和隐式安装，不加载当前项目的 mise 配置。用户项目执行保留原工作目录。用户传入的普通环境变量仍会影响工具；不要手动设置与所选版本矛盾的工具变量。

## 后台维护与服务优先

启动顺序：

1. 加载环境脚本，初始化本地状态，应用目录映射。
2. 执行用户前置钩子。
3. 按原有逻辑准备 DSH 插件。
4. 创建 DSH 服务进程。
5. 启动 apt 和工具后台任务，执行后置钩子。

工具检查、下载、依赖修复都不在服务创建前执行。服务进程创建不等于 HTTP 健康检查通过。工具任务失败不退出服务，工具状态与 apt 状态分开记录。

后台只恢复已记录的当前默认精确版本；文件存在则检查，不重新下载安装；文件缺失时尝试精确安装，不重新查询最新版本。旧的非默认版本保留，切换前检查，不在启动时逐个恢复。

后台已知基础依赖为 ca-certificates、libc6、libgcc-s1、libstdc++6、zlib1g，其他项目依赖不自动推断。镜像带常见安装组件及基础库，Python 原生扩展、CGO、GUI/字体或数据库客户端依赖仍可能需要用户 apt 安装。

后端元数据查询有期限，安装有较长期限；停止时转发信号并清理受管理进程组。包装任务退出后也回收其同组后代，不支持通过 setsid 等方式脱离管理。网页未新增工具进度，agent 调用未恢复工具可能失败，系统不会自动重跑用户任务。

## apt 自动记录和缓存

```sh
apt-get update
apt-get install -y ripgrep python3-venv build-essential
apt-get remove -y ripgrep
```

PATH 中的 apt/apt-get 包装完整事务并保存新增手工包目标。系统 `/usr/bin/apt*` 未改写；直接调用系统绝对路径、dpkg、apt-mark，不属于自动记录保证。支持精确包名与 `包名:架构`；复杂模式、自定义 APT_CONFIG/数据库路径不保证记录。

模拟或只下载不改目标；失败事务保留确认完成的变更，半配置不视为卸载。后台每包重新读取目标并与用户操作协调，避免已卸载的软件按旧快照装回。包按名称恢复，不锁旧版本，第三方源和签名密钥不自动迁移。

保留下载缓存减少下载；本轮未实现通用离线、全量依赖快照或缓存优先批量重放。apt 安装的 JDK/Go/Python仍由apt管理，不搬到mise。不得把工具链直接复用与apt重新安装混为一谈。

## 自定义目录映射

固定文件 `/root/.dsh/container/paths.txt`，每行 `持久源目录:容器内目标目录`，支持空行和整行注释：

```text
/root/test1:/data/test1
/root/software/mytool:/opt/mytool
```

这是软链接而非 Docker 内核挂载。源在 `/root` 下，不得使用内部配置/状态目录及其祖先；源不存在时创建。目标不得覆盖系统和镜像运行目录，不能重复或父子重叠，路径需规范化绝对路径，父路径不能借软链接绕转。

目标存在时仅接受正确链接，普通目录即使为空也拒绝覆盖。映射按行执行，后项失败不撤销前项。修改后重启生效；删除配置不删除源数据，也不清理同一容器已有链接。安装器删除并重建目标会破坏链接，用户应先建立映射再安装。

## 固定钩子

| 路径 | 时机 | 失败行为 |
|---|---|---|
| `/root/.dsh/container/before-start.sh` | 映射后，DSH 前 | 阻止启动 |
| `/root/.dsh/container/after-start.sh` | 服务进程创建后 | 记录失败，保留服务 |

不存在则跳过，存在则 `/bin/sh` 执行，不要求执行权限；每次启动运行，应保持幂等。前置示例：

```sh
#!/bin/sh
set -eu
. /usr/local/bin/dsh-environment.sh
mkdir -p /root/projects
```

后置示例：

```sh
#!/bin/sh
set -eu
printf '%s\n' 'service process started'
```

钩子为独立进程，export不改变DSH父环境；通用变量用Docker `-e`。前置钩子中的长任务会延迟服务启动；后置不表示工具恢复完成，依赖工具的脚本需自行检查。

## 服务启动与访问

默认启动参数为 `dsh web --no-open --host 0.0.0.0`，`DSH_HOST` 可覆盖。必须安装并加载支持通配绑定且与宿主兼容的 startup-auth；不能仅凭宿主版本判断插件已支持。已有持久卷不会自动升级插件，必要时执行 `dsh plugin --profile web add dsh-web-startup-auth@latest` 并重启。通过 `-p 3080:3080` 发布端口；本机免登录仍取决于插件对 TCP 对端、Host 和登录配置的判断，Docker 转发访问不保证免登录。

## 中断、旧数据与边界

```sh
docker exec dsh dsh-env status
docker logs dsh
```

apt事务中断会暂停自动恢复。检查后，必要时执行 `/usr/bin/dpkg --configure -a`，再执行 `dsh-env reconcile` 接受当前状态与中断前明确卸载意图，重启重试。跨容器核对不把新容器缺包误判成卸载。

旧 `install go|jdk DIRECTORY` 已移除；旧 `/root/.persist/tools` 保留但不自动转换或恢复旧专用入口。用新命令安装所需版本，确认后自行清理旧数据。不提供过时接口兼容层。

同一卷只用于同架构且兼容的基础系统。bookworm固定降低系统漂移，仍不保证任意升级后的ABI兼容。用户环境文件持久化不代表所有系统修改被保存；第三方源、任意/etc修改、系统服务数据和主目录外文件不自动备份。

## 验证

```sh
node --test dsh/tests/*.test.mjs
docker build -t dsh-local ./dsh
sh dsh/tests/smoke.sh dsh-local
```

本地测试覆盖原子选择、失败不切换、范围与精确版本、Java build、切换卸载、故障隔离、环境组合和环境脚本幂等。Linux脚本使用真实Go/Temurin/Python安装、断网重建、真实运行、固定钩子、挂起探测和服务先启动，以及apt重建/卸载和中断核对。

发布工作流先跑测试再推镜像；目前容器执行平台为amd64，arm64仅构建。实际DSH网页/插件健康、双架构运行、并发锁与复杂后代进程仍需真实Linux证据，不得以本地替身测试宣称全部验证。
