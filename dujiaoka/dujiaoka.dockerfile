FROM webhippie/php-nginx:7
ENV CNGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN composer -V && composer update --ignore-platform-reqs && chmod -R 777 /app
