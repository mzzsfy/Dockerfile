# dsh

DeepSeek Harness CLI 的 docker 镜像

镜像内置 web profile 及 dshmarket、dsh-web-startup-auth 插件

```
docker run -d --name dsh -p 3080:3080 -v dsh-data:/root/.dsh mzzsfy/dsh
```

- Web UI: http://0.0.0.0:3080
- 会话与配置持久化在 /root/.dsh,项目请自行挂载
- 插件在首次启动时在线安装,容器需能访问 npm registry,离线环境不适用
- 插件安装期间 pnpm 发布冷静期临时置 0,消除冷静期导致的插件版本滞后;安装完成后还原原有配置,未设置时写为 6h,约束运行期手动安装
- API Key 等凭证在 Web UI 内配置
