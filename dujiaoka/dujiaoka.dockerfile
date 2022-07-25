FROM webhippie/php-nginx:7
ENV CNGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN  mkdir -p /usr/local/sbin && ln "$(which php)" /usr/local/sbin/php && composer -V && composer update --ignore-platform-reqs && chmod -R 777 /app
