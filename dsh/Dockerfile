FROM node:24-slim

RUN npm i -g pnpm @deepseek-ai/dsh && npm cache clean -f

VOLUME ["/root/.dsh"]

EXPOSE 3080

ADD --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
