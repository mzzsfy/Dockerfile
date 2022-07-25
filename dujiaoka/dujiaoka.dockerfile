FROM webhippie/php-nginx:7
ENV CNGINX_WEBROOT=/app/public
COPY . /app
WORKDIR /app
RUN  if [ -f /usr/local/sbin/php ] ; then ln -s $(which php) /usr/local/sbin/php ; fi && composer install --ignore-platform-reqs && chmod -R 777 /app
