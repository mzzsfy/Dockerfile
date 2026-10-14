FROM webhippie/php-nginx:8.1
ENV NGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN  composer -V && composer update --ignore-platform-reqs
