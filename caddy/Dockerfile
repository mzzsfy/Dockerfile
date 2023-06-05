FROM caddy:builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/${plugin}

FROM caddy

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
