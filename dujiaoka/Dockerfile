FROM webhippie/php-nginx:7
ENV NGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN  composer -V && composer update --ignore-platform-reqs
