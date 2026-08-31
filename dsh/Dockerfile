FROM node:24-slim

RUN npm i -g pnpm @deepseek-ai/dsh \
    && dsh plugin --profile web add dshmarket < /dev/null \
    && dsh plugin --profile web add dsh-web-startup-auth < /dev/null \
    && cp -a /root/.dsh /opt/dsh-profile \
    && npm cache clean -f

ADD --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

VOLUME ["/root/.dsh"]

EXPOSE 3080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
