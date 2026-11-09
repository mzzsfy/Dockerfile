# CloudFlare worker 相关脚本

- [docker 镜像加速仓库](./docker-image.js) 支持泛域名和单域名仓库前缀两种模式
- [聚合通用加速仓库](./custom-common-image.js) 用于 apt yum pipy 等依赖下载加速 [泛域名版本](./custom-common-image-domain.js)
- [通用反代](./reverse-proxy.js) 通过环境变量控制,反代任意网站,支持 ip,地域黑名单 [泛域名版本](./reverse-proxy-domain.js)
- [vless+ws](./vless-ws.js) 上游直连 [上游为 socks5 使用这个](./vless-ws-socks5upstream.js)

[泛域名教程.md](./泛域名教程.md)

## docker-image.js

单文件 Cloudflare Worker，按 Docker Registry HTTP API V2 透传。参考
[DaoCloud public-image-mirror](https://github.com/DaoCloud/public-image-mirror) 的仓库前缀方式和
registry 列表，但不做镜像存储、懒同步或摘要校验，只做边缘代理。

### 两种访问模式

host 模式，保留原有用法：

```bash
docker pull docker.example.com/library/nginx
docker pull ghcr.example.com/owner/repo:tag
```

把 `docker.example.com` 配到 Docker 的 `registry-mirrors` 只适用于 Docker Hub。

path 模式，单域名承载所有 registry，前缀位于 repository 内：

```bash
docker pull mirror.example.com/docker.io/library/nginx
docker pull mirror.example.com/ghcr.io/owner/repo:tag
docker pull mirror.example.com/mcr.microsoft.com/dotnet/runtime:8.0
```

Docker 客户端实际请求的是 `/v2/docker.io/library/nginx/manifests/...`，因此不需要为每个 registry
配置泛域名或证书。path 模式的中性域名 `/v2/` 由 Worker 直接返回 Docker Hub 等价的认证 challenge，
不依赖上游 Docker Hub 可达。

### push

Docker 凭据按 registry host 隔离，push 前必须登录 Worker 域名，而不是只登录 Docker Hub：

```bash
# host 模式，Docker Hub 凭据
docker login dockerimg.mzzsfy.eu.org
docker tag app dockerimg.mzzsfy.eu.org/<namespace>/app:tag
docker push dockerimg.mzzsfy.eu.org/<namespace>/app:tag

# path 模式，仍然登录 Worker 域名
docker login mirror.example.com
docker tag app mirror.example.com/docker.io/<namespace>/app:tag
docker push mirror.example.com/docker.io/<namespace>/app:tag

# GHCR 等私有 registry 建议用独立 host，避免一套凭据混用
docker login ghcr.example.com
docker tag app ghcr.example.com/<owner>/app:tag
docker push ghcr.example.com/<owner>/app:tag
```

设置 `whitelist` 时，必须把 push 的目标命名空间加进去，例如 `<namespace>/` 或
`docker.io/<namespace>/**`。path 模式一个域名只能保存一套 Docker 凭据，多个私有 registry
建议使用 host 模式分别登录。Cloudflare Workers 有请求体大小限制，超大镜像层可能失败。

### 支持的 registry

| path 前缀（完整域名） / host 首段（别名） | 上游 |
| --- | --- |
| `docker.io`、`docker` | `registry-1.docker.io` |
| `ghcr.io`、`ghcr` | `ghcr.io` |
| `gcr.io`、`gcr` | `gcr.io` |
| `k8s.gcr.io`、`k8s-gcr` | `k8s.gcr.io` |
| `registry.k8s.io`、`k8s` | `registry.k8s.io` |
| `quay.io`、`quay` | `quay.io` |
| `mcr.microsoft.com`、`mcr` | `mcr.microsoft.com` |
| `nvcr.io`、`nvcr` | `nvcr.io` |
| `docker.elastic.co`、`elastic` | `docker.elastic.co` |
| `dhi.io`、`dhi` | `dhi.io` |
| `docker.cloudsmith.io`、`cloudsmith` | `docker.cloudsmith.io` |

path 模式只接受上表中的已知 registry 完整域名前缀，不能写 `ghcr`、`mcr` 这类 host 别名；未知的带点前缀返回 403，避免变成任意 host 的开放代理。
host 模式未知首段默认 Docker Hub。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `whitelist` | 允许的仓库列表，逗号或空白分隔；为空表示不限制 |
| `strictDomain` | `true` 时，未知 host 只允许 ping、token、根路径和带已知 registry 前缀的 path 模式请求 |
| `defaultIndex` | 浏览器访问根路径时反代的上游地址，例如 `https://hub.docker.com` |
| `debug` | `true` 时错误响应携带上游错误信息 |

### 白名单

匹配的是 repository，Docker Hub 官方镜像已补全为 `library/`：

```text
library/                 官方镜像
mzzsfy/                  mzzsfy 下所有仓库
mzzsfy/tts               精确匹配该仓库
docker.io/library/*      Docker Hub 官方镜像，仅一层
ghcr.io/owner/**         GHCR owner 下任意层级
```

规则：

- 无通配符且不以 `/` 结尾：精确匹配，不会把 `abc/bcd` 匹配到 `abc/bcdx`。
- 单独的 `*` 或 `**` 匹配全部仓库。
- 以 `/` 结尾：前缀匹配。
- `/*`：只匹配一层；`/**`：匹配任意层。
- 首段是已知 registry 时，按 `<registry>/<repository>` 完整名匹配；否则只匹配 repository，对所有 registry 生效。
- 要限定某个 registry，写完整前缀，例如 `ghcr.io/owner/**`。
- 空白项会被忽略；只有空白或逗号而没有有效规则时拒绝所有仓库，不会退化成不限制。
- 只有未设置或空字符串才表示不限制。

建议公网部署时始终设置 `whitelist`。不设置时任何知道地址的人都能通过 Worker 拉取、推送公开可达的仓库。

### 行为说明

- 所有 `/v2/<repo>/...` 请求统一解析 repository，manifests、blobs、blob 上传、tags/list、referrers 都会做
  Docker Hub 短名补全和白名单检查。
- 上游 401 的 `Www-Authenticate` realm 会被编码为 Worker 的 token 路径；支持 quay 的 `/v2/auth`、
  elastic 的外部认证域等非标准路径。token 请求中的 scope 会剥离 path 模式前缀并按目标 registry
  发现认证端点。
- GET/HEAD 的上游 3xx 重定向在服务端代理；跨域时剥离 `Authorization`、`Cookie` 等请求头。其他方法的 3xx 保留给客户端处理。
- 上游 2xx 的同源 `Location` 会改写回 Worker；path 模式会补上 registry 前缀，保证 blob 上传的后续 PATCH/PUT 仍然经过 Worker。
- `mcr.microsoft.com` 的 `/v2/` 不返回认证 challenge，token 请求会得到匿名 token，公开镜像可正常拉取。
- 响应会移除上游的 CSP、HSTS、Alt-Svc、Set-Cookie 等 origin 相关头，避免污染 Worker 域名。

### 限制

- 不做镜像缓存、去重、懒同步、30 天保留；这些都是真正 registry mirror 的能力，Worker 只透传。
- 不校验摘要与源站一致；摘要由客户端和上游 registry 保证。
- 公开仓库直接可用。
- 同一 registry 的 Basic 凭据会转发给受信任的 token endpoint；跨 registry 发现时不会转发；token 请求中的 Bearer 不透传。
- `mcr.microsoft.com` 等无 challenge 的 registry 只保证公开镜像。
- Cloudflare Workers 有请求数、CPU、子请求和响应体限制；大流量场景应配置白名单并考虑自建 registry。
- 不支持未列出的 registry（例如 `registry.ollama.ai`）。

### 测试

```bash
node --test cf-worker/docker-image.test.mjs
```

测试使用 mock fetch 覆盖 host/path 路由、token、白名单、重定向、CORS、错误处理和严格域名模式；push 的
POST/PATCH/PUT 与 manifest 流程另外用真实匿名 registry 做过端到端验证。

### 部署

把 `docker-image.js` 作为 ES Module Worker 粘贴到 Cloudflare 控制台即可，无需构建步骤或 wrangler 配置。
host 模式需要为每个 registry 配置自定义域或路由；path 模式只需要一个域名。
