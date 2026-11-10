---
name: mzzsfy-dsh-help
description: 仅在 mzzsfy/dsh 镜像的容器内使用（/root 是持久卷、带 dsh-env 与 apt 自动恢复）。当需要安装语言工具链或系统依赖、命令在容器重建后消失、要加载容器内 PATH 或 JAVA_HOME、配置目录映射与启动钩子、判断哪些改动会持久化，或在容器里选择 DSH 工具以免破坏环境时，先读本 skill。
---

# mzzsfy/dsh 容器环境

先确认前提，不匹配就不要套用本文结论：

```sh
test -f /usr/local/bin/dsh-env && echo mzzsfy/dsh
```

这个镜像与普通 Linux 容器的区别只有两点：`/root` 是持久卷，重建后保留；系统层每次重建换新，所以工具链由 `dsh-env` 管理、apt 安装由包装器记录并在启动后恢复。下面的决策都从这两点推出来。

## 安装什么、用什么装

| 需要 | 用什么 | 结果 |
|---|---|---|
| Go、Java、Python | `dsh-env install go`、`dsh-env install java@21`、`dsh-env install python@3.13` | 装在 `/root/.local/share/mise`，卷内保留，重建直接可用 |
| 系统包、编译依赖、命令行工具 | PATH 中的 `apt-get install` | 记录新增包名，重建后后台恢复 |
| 临时验证、不需要保留 | `/tmp` 或 `/usr/bin/apt`（绕过记录） | 重建后消失；PATH 的 apt 会被记录并恢复，`/root` 下的文件也会保留 |
| 主目录外的软件 | 先配 `paths.txt` 再安装 | 否则不在卷内 |

不要做的事：

- 不要用 `/usr/bin/apt`、`/usr/bin/apt-get`、`dpkg`、`apt-mark` 做常规安装或卸载；它们不会新增恢复记录，重建后不保证恢复。只有修复半配置包时才用 `/usr/bin/dpkg --configure -a`。
- 不要用裸 `mise` 改 `dsh-env` 管理的安装，也不要用 apt 装 Go/JDK/Python 后指望 `dsh-env` 管理它们。
- 不要假设 `npm -g`、手工解压到 `/usr`、写 `/etc` 会保留。

工具链的常用操作：

```sh
dsh-env install java@21
dsh-env install go@1.24.3
dsh-env list
dsh-env upgrade java
dsh-env use java@21
dsh-env remove java@25
```

白名单只有 Go、Temurin Java、Python，`jdk` 是 Java 别名。`use` 只在已登记版本间切换，不下载；`remove` 拒绝删除当前默认版本，先切到别的版本再删。升级不会自动清理旧版本。

## 执行命令时的环境

`docker exec` 启动的新进程不继承入口脚本补充的 PATH。按需要选择：

```sh
# 只需要 PATH 中的托管工具
. /usr/local/bin/dsh-environment.sh
go version

# 需要 JAVA_HOME 和完整工具环境（Gradle、Maven 等构建）
dsh-env exec java@21 -- ./gradlew build
```

项目自己的 mise 配置不会被包装器加载，也没有隐式安装；不要用项目里的版本文件覆盖容器管理的版本。

## 重建后的状态

容器启动顺序是服务先起来，apt 和工具链在后台恢复。网页可访问不代表软件已恢复，依赖某个工具的任务先确认：

```sh
dsh-env status
```

三段状态分别对应 apt 恢复、工具检查和后置钩子；另有 `aptSourcesSnapshot` 和 `interrupted` 两个字段。具体含义：

- `interrupted` 非空表示存在未完成的 apt 事务（进行中或已中断）；先确认没有正在运行的 apt，再按下面「apt 事务中断」一条处理。
- `tools` 的 `ready` 是上次维护检查的快照，不是实时健康证明；真正要跑命令时直接执行一次。
- 后台只恢复已登记的当前默认版本，不查询最新版、不自动升级；apt 恢复按包名重新安装，需要源可达或本地缓存，不保证离线。
- 某个工具恢复失败不阻止服务，也不重跑你自己的任务。
- apt 事务中断会暂停自动恢复：先 `/usr/bin/dpkg --configure -a`，再 `dsh-env reconcile`，请用户在宿主执行 `docker restart <container>` 重试。
- 宿主侧可以用 `docker logs <container>` 看恢复日志。

## 持久化边界

保留：`/root` 下的所有文件、`/root/.dsh`（会话、配置、用户 AGENTS.md）、`/root/.local/share/mise`、`/root/.persist`、已记录的 apt 包（按包名重装，需要源可达或缓存）、`paths.txt` 映射的源目录。

不保留：`/usr`、`/opt`、`/etc` 中的手工改动，未映射的主目录外文件，系统服务数据，未配置持久目录的 `npm -g` 安装，以及第三方 apt 源（只有源和密钥快照会被尽力恢复）。

主目录以外的项目需要用户另行挂载；没有挂载就要接受重建后丢失。

## 目录映射与钩子

在 `/root/.dsh/container/paths.txt` 写映射，每行 `源:目标`：

```text
/root/software/mytool:/opt/mytool
```

源与目标都必须是规范化绝对路径（不以 `/` 结尾、不含控制字符），父路径不能是软链接；源必须在 `/root` 下，不能是 `/root` 本身，也不能使用 `/root/.dsh/container`、`/root/.persist` 及其祖先或子路径，已存在时必须是普通目录。目标不能是系统、镜像运行目录或 `/root` 及其子路径，不能重复或父子重叠；目标已存在普通文件、目录或不同链接时启动会直接失败，需要在宿主侧清理或改配置，容器起不来时先看 `docker logs`。这是软链接而不是内核挂载：安装器如果删除目标再重建目录，链接会被破坏，所以先建映射再装软件。修改后需要用户在宿主执行 `docker restart <container>` 生效；删除配置不会删除源数据，也不会清理已有链接。

固定钩子每次启动执行，必须可重复运行：

- `/root/.dsh/container/before-start.sh`：映射恢复后、DSH 启动前，失败会阻止启动。
- `/root/.dsh/container/after-start.sh`：服务进程创建后，失败只记录，不影响服务。

钩子在独立 shell 中执行，里面的 `export` 不会改变 DSH 的环境。

## 在这个容器里用 DSH 工具

工具集由 profile 决定，下面是容器语境下的取舍，仍以当前会话实际提供的工具为准：

- 文件操作优先用 `read`、`write`、`edit`、`glob`、`grep`，不要用 `cat`、`find`、`sed -i` 绕开文件后端；容器内项目同样适用。
- `bash` 每次调用都是新 shell，cwd、变量和函数不保留。固定目录先用 `working_directory`，或在同一次调用里 `cd ... && ...`。
- 长任务用 `run_in_background`，拿 job id 后用 `job_output` 收结果、`job_kill` 停止；前台命令超时也会转成 job，不要在会话里空等。
- 多步任务先用 `todo_write` 记录；独立的调研或可并行的子任务交给 `subagent`，不要串行做完再补汇报。
- 需要专门流程时先用 `skill` 加载对应 skill，不要凭记忆复述步骤。
- `web_fetch` 通过匿名 HTTP 抓取，不需要凭证，受容器网络影响；`web_search` 依赖与模型共用的凭证：API Key 会话读 `DEEPSEEK_API_KEY`（Web UI 凭证或环境变量），账号登录会话用账号凭证；两者都没有时该次模型请求不提供 `web_search`。凭证不在镜像内。
- 切换目录用 `working_directory`，它不影响已经运行的进程和 shell。
- 容器内已经运行着 DSH 服务；不要为了"修复环境"重启服务或杀掉入口进程，那会连带终止后台恢复任务。

## 典型组合

- 项目需要 JDK 21 构建：`dsh-env install java@21`，再用 `dsh-env exec java@21 -- ./gradlew build`；环境脚本只补 PATH，不设置 `JAVA_HOME`。
- 需要系统库（例如 Chromium、数据库客户端）：`apt-get update && apt-get install -y ...`，重建后由后台恢复，不写进 Dockerfile。
- 软件要装到 `/opt`：先在 `paths.txt` 配好 `/root/software/xxx:/opt/xxx`，请用户重启容器后再安装。
- 长构建或下载：`bash` 的 `run_in_background` 拿 job id，同时用 `todo_write` 或 `subagent` 推进其他部分，最后 `job_output` 收尾。

## 反模式

| 想法 | 现实 |
|---|---|
| "apt 装了 Go/JDK 也算持久" | 记录的是 apt 包，按包名恢复，版本会漂移，也不受 `dsh-env` 管理 |
| "下载 tar 到 `/opt` 就行" | 重建后 `/opt` 回到镜像内容 |
| "服务起来了，环境就好了" | 恢复在后台进行，先看 `dsh-env status` |
| "删掉 `paths.txt` 就清理干净了" | 只停止新建链接，已有链接和源数据都还在 |
| "`docker exec` 里能看到 go 就说明没问题" | 新进程不继承入口脚本补充的 PATH，要先加载 `dsh-environment.sh` |
