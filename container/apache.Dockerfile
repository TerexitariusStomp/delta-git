# Lane-3 Apache SAPI variant — for plugins that need REAL .htaccess behavior
# (Wordfence, iThemes Security) or assume an Apache environment.
# Auto-selected by the compat classifier when a site needs it.
# Same tooling contract as the FrankenPHP image: entrypoint, webhook agent,
# rclone, WP-CLI, ttyd, runit daemons.
ARG PHP_VERSION=8.2
FROM alpine:3.20

RUN apk add --no-cache bash curl sqlite unzip ca-certificates mariadb-client imagemagick runit jq \
    apache2 apache2-proxy apache2-ssl \
    php$(echo ${PHP_VERSION} | tr -d '.') \
    php$(echo ${PHP_VERSION} | tr -d '.')-apache2 \
    php$(echo ${PHP_VERSION} | tr -d '.')-mysqli \
    php$(echo ${PHP_VERSION} | tr -d '.')-sqlite3 \
    php$(echo ${PHP_VERSION} | tr -d '.')-curl \
    php$(echo ${PHP_VERSION} | tr -d '.')-gd \
    php$(echo ${PHP_VERSION} | tr -d '.')-mbstring \
    php$(echo ${PHP_VERSION} | tr -d '.')-openssl \
    php$(echo ${PHP_VERSION} | tr -d '.')-zip \
    php$(echo ${PHP_VERSION} | tr -d '.')-intl \
    php$(echo ${PHP_VERSION} | tr -d '.')-session \
    php$(echo ${PHP_VERSION} | tr -d '.')-phar \
    php$(echo ${PHP_VERSION} | tr -d '.')-ctype \
    php$(echo ${PHP_VERSION} | tr -d '.')-xml \
    php$(echo ${PHP_VERSION} | tr -d '.')-tokenizer \
    php$(echo ${PHP_VERSION} | tr -d '.')-dom \
    php$(echo ${PHP_VERSION} | tr -d '.')-simplexml \
    php$(echo ${PHP_VERSION} | tr -d '.')-iconv \
    php$(echo ${PHP_VERSION} | tr -d '.')-posix

# WP-CLI + tooling (same as FrankenPHP variant)
RUN curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
 && chmod +x /usr/local/bin/wp \
 && curl -fsSL https://rclone.org/install.sh | bash \
 && curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
 && curl -fsSL -o /usr/local/bin/webhook https://github.com/adnanh/webhook/releases/download/2.8.2/webhook-linux-amd64 \
 && chmod +x /usr/local/bin/ttyd /usr/local/bin/webhook \
 && curl -fsSL -o /srv/adminer.php https://github.com/vrana/adminer/releases/download/v4.8.1/adminer-4.8.1.php

# WordPress + platform plugins (identical to FrankenPHP variant)
RUN mkdir -p /srv/site && cd /srv/site \
 && curl -fsSL https://wordpress.org/latest.tar.gz | tar -xz --strip-components=1 \
 && cd wp-content/plugins \
 && for p in sqlite-database-integration s3-uploads fluent-smtp sqlite-object-cache; do \
      curl -fsSL -o /tmp/$p.zip https://downloads.wordpress.org/plugin/$p.latest-stable.zip && unzip -q /tmp/$p.zip; \
    done \
 && mkdir -p /srv/site/wp-content/mu-plugins \
 && sed -e "s|{SQLITE_IMPLEMENTATION_FOLDER_PATH}|/srv/site/wp-content/plugins/sqlite-database-integration|" \
        -e "s|{SQLITE_PLUGIN}|sqlite-database-integration/load.php|" \
        /srv/site/wp-content/plugins/sqlite-database-integration/db.copy > /srv/site/wp-content/db.php

# Apache: real .htaccess via AllowOverride All — the whole point of this variant
COPY apache.conf /etc/apache2/conf.d/wpcloud.conf
RUN mkdir -p /run/apache2 && sed -i 's|^Listen 80|Listen 80|' /etc/apache2/httpd.conf \
 && sed -i 's|^#LoadModule rewrite_module|LoadModule rewrite_module|' /etc/apache2/httpd.conf \
 && sed -i 's|^DocumentRoot .*|DocumentRoot "/srv/site"|' /etc/apache2/httpd.conf \
 && sed -i 's|^<Directory ".*">|<Directory "/srv/site">|' /etc/apache2/httpd.conf \
 && sed -i 's|AllowOverride None|AllowOverride All|g' /etc/apache2/httpd.conf

COPY wpcloud-mu.php /srv/site/wp-content/mu-plugins/wpcloud-mu.php
COPY entrypoint.sh /entrypoint.sh
COPY hooks.json /etc/webhook/hooks.json
COPY sync-out.sh restore.sh cron.sh daemon-svc.sh compat-scan.sh /usr/local/bin/
RUN chmod +x /entrypoint.sh /usr/local/bin/*.sh && mkdir -p /state/daemons

ENV WP_ENV=production SITE_SAPI=apache
EXPOSE 80 8080 7681
ENTRYPOINT ["/entrypoint.sh"]
