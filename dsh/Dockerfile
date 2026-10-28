FROM node:24-slim

ENV TZ=Asia/Shanghai

RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g pnpm @deepseek-ai/dsh && npm cache clean -f

COPY environment.mjs /usr/local/lib/dsh-env/environment.mjs
COPY --chmod=0755 dsh-env /usr/local/bin/dsh-env
COPY --chmod=0755 apt-persist /usr/local/bin/apt
RUN ln -s apt /usr/local/bin/apt-get \
  && rm -f /etc/apt/apt.conf.d/docker-clean \
  && /usr/local/bin/dsh-env baseline

VOLUME ["/root"]

EXPOSE 3080

COPY --chmod=0755 dsh-start.sh /usr/local/bin/dsh-start.sh
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
