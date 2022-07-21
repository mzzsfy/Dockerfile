FROM webdevops/php-nginx:7.4
ENV COMPOSER_ALLOW_SUPERUSER=true WEB_DOCUMENT_ROOT=/app/public
COPY . /app
WORKDIR /app
RUN php -v && ( composer install --ignore-platform-reqs || composer update --ignore-platform-reqs || echo "over" ) && chmod -R 777 /app
