# dsh

DeepSeek Harness CLI 的 docker 镜像

首次启动默认为 web profile 安装 dshmarket、dsh-web-startup-auth、@mzzsfy/dsh-auto-trust-all 插件

当前工作树新增的环境恢复功能尚未发布，以下在仓库根目录执行，使用本地构建镜像；公共 `mzzsfy/dsh` 标签是否包含这些能力取决于后续发布。Linux 容器验收尚待 CI 执行。

```sh
docker build -t dsh-local ./dsh
docker run -d --name dsh -p 3080:3080 -v dsh-home:/root dsh-local
```

- Web UI: `http://<宿主IP>:3080`
- 整个 `/root` 持久化；重建复用同一个卷，一个卷只供一个活跃容器使用。主目录以外的项目需另外挂载
- 普通 `apt` / `apt-get` 安装自动记录，重建后后台恢复；`docker exec dsh dsh-env status` 查看状态。服务可访问不等于所有软件已恢复
- 原先挂载 `/root/.dsh` 的卷布局不能直接改挂 `/root`；更换部署前需自行备份并将数据放入新主目录的 `.dsh` 子目录

## 哪些内容默认持久化

前提是按上面的命令挂载整个 `/root`，重建时复用同一个卷。镜像不预装下面的语言工具链。

| 内容或安装方式 | 重建后的行为 |
|---|---|
| `/root/.dsh` 中的会话、配置和用户 AGENTS.md | 文件直接保留 |
| `/root` 中的项目、配置、依赖缓存 | 文件直接保留；主目录以外的项目不自动保留 |
| 安装在主目录的 Rust/rustup、uv、pyenv、用户目录中的 Python 虚拟环境等 | 文件直接保留；依赖的系统库仍需恢复，命令是否可找到取决于 PATH 配置 |
| 普通 `apt install` / `apt-get install` 安装的 JDK、Go、Python、ripgrep、编译工具等 | 自动记录安装目标，重建后后台重新安装软件及依赖，版本可能变化 |
| `dsh-env install go` / `dsh-env install jdk` 管理的工具链 | 工具目录保存在卷内，启动恢复入口和检查运行能力，无需重新下载工具目录 |
| `paths.txt` 配置的软件目录 | 源文件保留，启动重新建立目标路径软链接 |
| 普通 `npm -g`、未配置持久目录的手动解压、直接写入 `/usr` 或 `/opt` 的安装 | 不保证保留 |
| 镜像自带 DSH、Node、pnpm | 使用新镜像提供的版本 |

**保存文件不等于保存完整 Linux 系统。** 手工修改的系统配置、第三方软件源、任意安装脚本产生的系统文件不会自动备份；主目录中的工具也可能依赖新镜像尚未安装的系统库。

## 安装与恢复软件

以下命令在容器终端执行，也可先用 `docker exec -it dsh sh` 进入。

```sh
apt-get update
apt-get install -y ripgrep python3-venv build-essential
# 正常卸载会更新恢复清单，下次启动不会由恢复任务重新装回
apt-get remove -y ripgrep
```

正常使用 PATH 中的 `apt`、`apt-get` 即可。直接调用 `/usr/bin/apt`、`/usr/bin/apt-get`、`dpkg` 或 `apt-mark` 会绕过记录入口，不保证保存安装意图。恢复按包名进行，不锁定旧版本；缓存减少下载，但不保证离线恢复。

## 工具链安装、升级和多版本

镜像内置 mise 作为安装后端，用户统一通过 `dsh-env` 操作，无需手动下载或解压。首批白名单为 Go、Temurin Java、Python；`jdk` 是 `java` 的别名。

```sh
dsh-env install go
dsh-env install java@21
dsh-env install python@3.13
dsh-env list
```

- Go、Python 不指定版本时解析最新稳定版，保存实际版本和 major.minor 升级范围；Java 默认使用 Temurin 21 系列。
- 指定一至两段版本作为范围，三段及以上作为固定补丁版本；Java 支持 `temurin-21.0.9+11` 形式的构建号。
- 下载、安装和基础运行检查成功后才切换默认。失败保留原默认选择，磁盘上可能留下未登记的安装文件。
- 工具安装结果保存在 `/root/.local/share/mise`，管理记录保存在 `/root/.persist/toolchains`，缓存位于 `/root/.cache/mise`。重建复用卷后直接使用，默认不升级；后台仅对缺失的当前默认版本尝试精确恢复。

```sh
# 在当前请求范围内升级；无参数时逐个升级已管理工具
dsh-env upgrade java
dsh-env upgrade

# 安装另一系列并设为默认；原版本保留
dsh-env install java@25

# 切换回已安装的 21 系列，不下载；多个匹配版本选择最高版本
dsh-env use java@21

# 删除非当前默认版本；实际卸载成功后移除记录
dsh-env remove java@25
```

`remove` 拒绝删除当前默认版本，需先切换其他已安装版本；本版没有清空某工具全部版本的命令。升级不会自动清理旧版本，项目兼容性仍需用户验证。并发切换使用同一份版本记录构建命令与环境；通过包装器运行的任务持有使用锁，卸载遇到运行中的任务会立即拒绝，任务结束后可重试。用户直接执行安装目录内的二进制不受该锁保护。

## 环境设置与自定义启动脚本

环境设置与启动分开：

- `/usr/local/bin/dsh-environment.sh`：用 `.` 加载，只配置 PATH，保留原路径，重复加载不重复添加；不启动服务，也不执行安装。
- `/usr/local/bin/docker-entrypoint.sh`：唯一启动脚本，加载环境后交给监督器；插件准备保留在它的内部准备分支中，监督器随后直接启动 DSH，不再经过第三个 Shell 启动脚本。

用户自定义脚本示例：

```sh
#!/bin/sh
set -eu
. /usr/local/bin/dsh-environment.sh
go version
```

若自行替换容器入口，希望最后仍启动 DSH，可在自定义准备完成后执行：

```sh
exec /usr/local/bin/docker-entrypoint.sh
```

`docker exec` 新进程不继承入口脚本修改的环境，应主动加载：

```sh
docker exec dsh sh -c '. /usr/local/bin/dsh-environment.sh; go version'
```

需要一次命令使用指定工具版本及完整环境时：

```sh
dsh-env exec java@21 -- ./gradlew build
dsh-env exec python@3.13 -- python --version
```

这些命令要求版本已经登记且文件可用，不隐式安装。Java 代理和 `exec` 会为子进程设置对应 JAVA_HOME，环境脚本不会把父 shell 的 JAVA_HOME 写死到某个版本。运行中的进程不会因为切换版本自动重启。

已管理的命令优先使用选定工具；其版本缺失时明确失败，不悄悄改用 apt 版本。未管理的命令回退到原 PATH 中的系统安装。apt 安装的 Java、Go、Python 仍归 apt 管理；显式 `/usr/bin/java` 等系统入口不受工具链选择影响。不要用裸 mise 修改包装器管理的安装，项目 mise 配置不会被包装器自动加载。

旧 `dsh-env install go|jdk DIRECTORY` 接口已移除。旧 `/root/.persist/tools` 数据保留，不自动转换、删除或恢复旧专用入口；请用新命令安装所需版本，确认项目可用后再自行整理旧数据。

## 自定义软件目录

在容器内创建 `/root/.dsh/container/paths.txt`，每行写 `持久源目录:容器内目标目录`：

```text
# /data/test1 中的文件实际写入 /root/test1
/root/test1:/data/test1
/root/software/mytool:/opt/mytool
```

配置目录可先通过 `mkdir -p /root/.dsh/container` 创建。编辑后在宿主执行 `docker restart dsh`，确认映射生效后再向目标安装软件。

- 源必须在 `/root` 下，不存在则创建；不能使用内部配置和恢复状态目录。
- 这是软链接映射，不是 Docker 内核挂载，不需要额外权限。
- 目标已有普通文件、目录或不同链接时停止启动，不覆盖或搬走原内容。
- 不能映射整个系统目录或镜像运行目录，例如 `/usr`、`/etc`、`/usr/local/bin`；目标不得重复或父子重叠。
- 安装器若先删掉目标软链接再创建目录，会破坏持久化；软件的系统依赖也不随该目录自动保存。
- 删除配置不会删除源数据，也不会清理同一容器已有链接；新容器不再创建该映射。

## 启动前后钩子

固定两个脚本位置，**无需配置脚本路径**。文件不存在时跳过，存在时用 `/bin/sh` 执行，不要求可执行权限。

| 脚本 | 执行时间 | 失败处理 |
|---|---|---|
| `/root/.dsh/container/before-start.sh` | 自定义映射恢复后，DSH 启动前 | 停止启动 |
| `/root/.dsh/container/after-start.sh` | DSH 服务进程创建后 | 记录错误，DSH 继续运行 |

前置脚本示例，保存到 `/root/.dsh/container/before-start.sh`：

```sh
#!/bin/sh
set -eu
mkdir -p /root/projects /root/cache
printf '%s\n' 'startup preparation complete'
```

后置脚本示例，保存到 `/root/.dsh/container/after-start.sh`：

```sh
#!/bin/sh
set -eu
printf '%s\n' 'service process started'
```

保存后执行 `docker restart dsh`，用 `docker logs dsh` 查看输出。脚本每次启动都会执行，应写成可重复运行的操作；不要在钩子里启动无限期阻塞的前台任务。

**后置钩子不代表网页已经可访问，也不代表 apt 已恢复完成。** 依赖就绪状态的操作需要自行检查。钩子在独立 shell 中运行，里面的 `export` 不会修改 DSH 环境；通用环境变量请在 `docker run` 时通过 `-e NAME=value` 传入。

## 查看状态与处理失败

在宿主执行：

```sh
docker exec dsh dsh-env status
docker logs dsh
```

DSH 可在后台 apt 完成前启动。状态分为 `apt`、`tools`、`afterHook`：`apt`、`tools` 的 `ready` 表示该项恢复或检查通过，`afterHook` 的 `complete` 表示后置脚本成功，不代表任意项目都可运行。DSH 服务创建后才开始工具检查、依赖恢复和 apt 维护；一个工具失败不会退出服务。

若提示有未完成的用户 apt 事务，先检查日志与系统实际状态，再在容器内处理：

```sh
# 仅在 dpkg 提示有未配置包时先修复
/usr/bin/dpkg --configure -a
# 确认当前状态，并接受中断前明确的卸载意图
dsh-env reconcile
```

随后在宿主执行 `docker restart dsh` 重试恢复。目录映射冲突时，先修正配置或自行整理冲突目录，入口不会替用户覆盖数据。

完整限制、依赖范围与验收状态见 [软件环境、目录映射与启动钩子](environment-persistence.md)。

## Web、插件与时区

- 插件在首次启动时在线安装,容器需能访问 npm registry,离线环境不适用
- 插件安装期间 pnpm 发布冷静期临时置 0,消除冷静期导致的插件版本滞后;安装完成后还原原有配置,未设置时写为 6h,约束运行期手动安装
- @mzzsfy/dsh-auto-trust-all 动态信任所有到达的 Host 头,经域名、内网 IP、反向代理远程访问免改启动命令;仅放行可达性闸门,cookie 与 startup-auth 认证原样保留
- **默认绑定 `0.0.0.0`**，启动参数为 `web --no-open --host "${DSH_HOST:-0.0.0.0}"`；可通过 Docker `-e DSH_HOST=具体地址` 覆盖。前提是已安装并加载支持通配绑定、且与宿主版本兼容的 `dsh-web-startup-auth`。不再探测容器网卡或按宿主版本切换命令。
- 持久卷中的已有插件不会自动升级。如果旧插件不支持此绑定，先在容器内执行 `dsh plugin --profile web add dsh-web-startup-auth@latest`，再重启；单纯更新镜像不会替换卷里的旧插件。[上游使用说明](https://github.com/GDWhisper/dsh-web-startup-auth#readme)
- 支持认证桥接的 startup-auth 会为通过认证的请求补发上游 cookie，无需手动使用 token URL。远程访问首次设置管理员账号，之后登录；本机免登录要求 TCP 对端和 Host 都满足插件的回环判定，并且未启用本机登录校验。Docker 端口转发不保证被识别为回环请求。
- 时区默认 Asia/Shanghai,经 TZ 环境变量控制,运行时 `-e TZ=America/New_York` 覆盖为任意 IANA 时区
- API Key 等凭证在 Web UI 内配置
