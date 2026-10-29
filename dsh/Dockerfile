FROM ghcr.io/jdx/mise:2026.10.10@sha256:413d4a27f8a1a75edf87451b7a0e74a9c38a0348ce6760068fbcd0c3df6e0bad AS mise
FROM node:24-bookworm-slim

ENV TZ=Asia/Shanghai

COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata util-linux ca-certificates curl git xz-utils unzip libstdc++6 zlib1g \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g pnpm @deepseek-ai/dsh && npm cache clean -f

COPY environment.mjs toolchains.mjs /usr/local/lib/dsh-env/
COPY --chmod=0755 tool-proxy /usr/local/lib/dsh-env/tool-proxy
RUN mkdir -p /usr/local/lib/dsh-env/bin \
  && for command in go gofmt java javac jar javadoc jshell python python3 pip pip3; do ln -s ../tool-proxy /usr/local/lib/dsh-env/bin/$command; done
COPY --chmod=0755 dsh-env /usr/local/bin/dsh-env
COPY --chmod=0755 apt-persist /usr/local/bin/apt
RUN ln -s apt /usr/local/bin/apt-get \
  && rm -f /etc/apt/apt.conf.d/docker-clean \
  && /usr/local/bin/dsh-env baseline

VOLUME ["/root"]

EXPOSE 3080

COPY --chmod=0755 dsh-environment.sh /usr/local/bin/dsh-environment.sh
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
