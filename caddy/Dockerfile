FROM caddy:builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/${plugin}

FROM caddy
RUN apk update && \
    apk add --no-cache tzdata ca-certificates && \
    update-ca-certificates && \
    rm -rf /var/cache/apk/*
ENV TZ=Asia/Shanghai

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
