FROM node:alpine

ADD ./docker-entrypoint.sh /
RUN chmod +x /docker-entrypoint.sh && npm i oicq@1 -g && npm cache clean -f

CMD ["/docker-entrypoint.sh"]
ENTRYPOINT ["/bin/sh"]