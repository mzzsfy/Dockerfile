# dsh

DeepSeek Harness CLI 的 docker 镜像

镜像内置 web profile 及 dshmarket、dsh-web-startup-auth 插件

```
docker run -d --name dsh -p 3080:3080 -v dsh-data:/root/.dsh mzzsfy/dsh
```

- Web UI: http://0.0.0.0:3080
- 会话与配置持久化在 /root/.dsh,项目请自行挂载
- 插件在首次启动时在线安装,容器需能访问 npm registry,离线环境不适用
- API Key 等凭证在 Web UI 内配置
