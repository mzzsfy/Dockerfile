# dsh

DeepSeek Harness CLI 的 docker 镜像

镜像内置 web profile 及 dshmarket、dsh-web-startup-auth、@mzzsfy/dsh-auto-trust-all 插件

```
docker run -d --name dsh -p 3080:3080 -v dsh-data:/root/.dsh mzzsfy/dsh
```

- Web UI: `http://<宿主IP>:3080`
- 会话与配置持久化在 /root/.dsh,项目请自行挂载
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
