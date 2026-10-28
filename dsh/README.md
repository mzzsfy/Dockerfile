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

Go/JDK 若要直接保留工具目录，先下载并解包适合当前 Linux 架构的发行包，再执行：

```sh
# 参数为已经解包的发行目录，不是压缩包
# Go 目录应包含 bin/go，JDK 目录应包含 bin/java
dsh-env install go /tmp/go
dsh-env install jdk /tmp/jdk-21
```

升级时对新发行目录再次执行 `install`。需要卸载时再执行以下命令；它们取消当前入口，历史版本文件仍保留在持久卷内：

```sh
dsh-env remove go
dsh-env remove jdk
```

Go 入口为 `/usr/local/go`，JDK 入口为 `/opt/java`；DSH 启动环境包含相应 bin 路径，已注册 JDK 时设置 JAVA_HOME。运行中首次注册 JDK 后，需要 JAVA_HOME 的任务应重启容器或在当前终端显式设置。`docker exec` 新终端不继承入口脚本修改的环境，必要时使用 `/usr/local/go/bin/go`、`/opt/java/bin/java` 等完整路径。

这两个专用入口不会捕获任意 `tar` 或 `curl | sh` 安装。来源需满足工具运行依赖；目标已有普通目录时拒绝覆盖。工具升级保留旧版本，磁盘空间由用户按需清理。

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

DSH 可在后台 apt 完成前启动。状态中的 `ready` 仅表示记录的软件恢复目标和白名单运行检查通过，后置钩子结果单独显示，不代表任意项目都可运行。

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
- **启动命令按 dsh 版本自动选择**(入口脚本运行时判断,两代绑定面不兼容):
  - **0.2.0 线**:不传 `--host`,非回环绑定由旧版插件(<=0.3.x)的 bundle patch 翻转缺省值为 `0.0.0.0`——该线 CLI 拒 `--host 0.0.0.0` 且 schema 只收 `127.0.0.1`/`0.0.0.0`;`DSH_HOST` 仅支持 `127.0.0.1`
  - **0.2.1+ 线**:宿主拒通配绑定,插件不再碰绑定;`DSH_HOST` 显式指定优先,缺省取容器首个非内部 IPv4(`-p` 发布端口可达),无非内部地址回落 `127.0.0.1`
  - 注意耦合:0.2.0 宿主 + 插件升级到适配版(0.4 起)后不再翻转绑定,`-p` 将不可达——升级插件请配合重建镜像使用 0.2.1 线宿主
- 每个新入口(各域名/各 IP 形态)首访需各自铸一次会话 cookie:取启动日志 `token=` 拼 `http://<入口>/?token=<T>` 打开一次
- 时区默认 Asia/Shanghai,经 TZ 环境变量控制,运行时 `-e TZ=America/New_York` 覆盖为任意 IANA 时区
- API Key 等凭证在 Web UI 内配置
