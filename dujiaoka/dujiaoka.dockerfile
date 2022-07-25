FROM webhippie/php-nginx:7
ENV CNGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN  ls -la /usr/local/sbin/ && composer -V && composer update --ignore-platform-reqs && chmod -R 777 /app
