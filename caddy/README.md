# auto build caddy with dns plugin

build log  
<https://github.com/mzzsfy/Dockerfile/actions/workflows/caddy.yml>

add more dns plugin see  
<https://github.com/mzzsfy/Dockerfile/blob/main/.github/workflows/caddy.yml#L10>

all tags: cloudflare,alidns,azure,dnspod,googleclouddns,duckdns

```shell
docker run -it -name caddy mzzsfy/caddy-dns:<tag> #not exist latest

docker run -it -name caddy mzzsfy/caddy-dns:alidns

docker run -it -name caddy mzzsfy/caddy-dns:cloudflare
```
