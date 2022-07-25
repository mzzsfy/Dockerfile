FROM webhippie/php-nginx:7
ENV CNGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN bash -c 'composer install --ignore-platform-reqs' && chmod -R 777 /app
