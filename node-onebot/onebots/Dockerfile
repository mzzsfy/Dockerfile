FROM node:alpine

ADD ./docker-entrypoint.sh /
RUN npm i onebots -g && npm cache clean -f

ENV platform=3

VOLUME ["/data"]

CMD ["/docker-entrypoint.sh"]
ENTRYPOINT ["/bin/sh"]