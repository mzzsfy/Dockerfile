FROM node:alpine

ADD ./docker-entrypoint.sh /
RUN chmod +x /docker-entrypoint.sh && npm i icqq -g && npm cache clean -f

ENV platform=3

VOLUME ["/data"]

CMD ["/docker-entrypoint.sh"]
ENTRYPOINT ["/bin/sh"]