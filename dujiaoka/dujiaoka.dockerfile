FROM webdevops/php-nginx:7.4
COPY . /app
WORKDIR /app
RUN php -v && composer install --ignore-platform-reqs && chmod -R 777 /app
