FROM webhippie/php-nginx:7
ENV COMPOSER_ALLOW_SUPERUSER=true NGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN php -v && composer install --ignore-platform-reqs && chmod -R 777 /app
