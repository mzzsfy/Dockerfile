# dsh

DeepSeek Harness CLI 的 docker 镜像

镜像内置 web profile 及 dshmarket、dsh-web-startup-auth、@mzzsfy/dsh-auto-trust-all 插件

```
docker run -d --name dsh -p 3080:3080 -v dsh-data:/root/.dsh mzzsfy/dsh
```

- Web UI: http://0.0.0.0:3080
- 会话与配置持久化在 /root/.dsh,项目请自行挂载
- 插件在首次启动时在线安装,容器需能访问 npm registry,离线环境不适用
- 插件安装期间 pnpm 发布冷静期临时置 0,消除冷静期导致的插件版本滞后;安装完成后还原原有配置,未设置时写为 6h,约束运行期手动安装
- @mzzsfy/dsh-auto-trust-all 动态信任所有到达的 Host 头,经域名、内网 IP、反向代理远程访问免配置;仅放行可达性闸门,cookie 与 startup-auth 认证原样保留
- 时区默认 Asia/Shanghai,经 TZ 环境变量控制,运行时 `-e TZ=America/New_York` 覆盖为任意 IANA 时区
- API Key 等凭证在 Web UI 内配置
