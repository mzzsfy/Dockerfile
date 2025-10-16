# auto build caddy with dns plugin

build log  
<https://github.com/mzzsfy/Dockerfile/actions/workflows/caddy.yml>

more dns plugin
<https://github.com/mzzsfy/Dockerfile/blob/main/.github/workflows/caddy.yml#L10>

some tags: cloudflare,alidns,azure,tencentcloud

```shell
docker run -it -name caddy mzzsfy/caddy-dns:<tag> #not exist latest

docker run -it -name caddy mzzsfy/caddy-dns:alidns

docker run -it -name caddy mzzsfy/caddy-dns:cloudflare
```


