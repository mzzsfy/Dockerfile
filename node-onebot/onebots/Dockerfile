FROM node:alpine

ADD ./docker-entrypoint.sh /
RUN npm i onebots -g && npm cache clean -f

VOLUME ["/data"]

CMD ["/docker-entrypoint.sh"]
ENTRYPOINT ["/bin/sh"]
