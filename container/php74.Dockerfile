# Legacy PHP-7.4 variant — for plugins pinned to PHP <8 (declared via
# "Requires PHP: 7.x"). Alpine 3.15 is the last release shipping PHP 7.4.
# Enterprise/pro tier only; flagged in admin as a legacy-runtime site.
FROM alpine:3.15

RUN apk add --no-cache bash curl sqlite unzip ca-certificates mariadb-client imagemagick runit jq \
    apache2 php7 php7-apache2 \
    php7-mysqli php7-sqlite3 php7-curl php7-gd php7-mbstring php7-openssl \
    php7-zip php7-intl php7-session php7-phar php7-ctype php7-json \
    php7-xml php7-tokenizer php7-dom php7-simplexml php7-iconv php7-posix

RUN curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
 && chmod +x /usr/local/bin/wp \
 && curl -fsSL https://rclone.org/install.sh | bash \
 && curl -fsSL -o /usr/local/bin/webhook https://github.com/adnanh/webhook/releases/download/2.8.2/webhook-linux-amd64 \
 && chmod +x /usr/local/bin/webhook \
 && curl -fsSL -o /srv/adminer.php https://github.com/vrana/adminer/releases/download/v4.8.1/adminer-4.8.1.php

# WordPress 6.x is the last branch supporting PHP 7.4 — pin it
RUN mkdir -p /srv/site && cd /srv/site \
 && curl -fsSL https://wordpress.org/wordpress-6.7.2.tar.gz | tar -xz --strip-components=1 \
 && cd wp-content/plugins \
 && for p in sqlite-database-integration s3-uploads fluent-smtp sqlite-object-cache; do \
      curl -fsSL -o /tmp/$p.zip https://downloads.wordpress.org/plugin/$p.latest-stable.zip && unzip -q /tmp/$p.zip; \
    done \
 && mkdir -p /srv/site/wp-content/mu-plugins \
 && sed -e "s|{SQLITE_IMPLEMENTATION_FOLDER_PATH}|/srv/site/wp-content/plugins/sqlite-database-integration|" \
        -e "s|{SQLITE_PLUGIN}|sqlite-database-integration/load.php|" \
        /srv/site/wp-content/plugins/sqlite-database-integration/db.copy > /srv/site/wp-content/db.php

COPY apache.conf /etc/apache2/conf.d/wpcloud.conf
RUN mkdir -p /run/apache2 \
 && sed -i 's|^#LoadModule rewrite_module|LoadModule rewrite_module|' /etc/apache2/httpd.conf \
 && sed -i 's|^DocumentRoot .*|DocumentRoot "/srv/site"|' /etc/apache2/httpd.conf \
 && sed -i 's|^<Directory ".*">|<Directory "/srv/site">|' /etc/apache2/httpd.conf \
 && sed -i 's|AllowOverride None|AllowOverride All|g' /etc/apache2/httpd.conf

COPY wpcloud-mu.php /srv/site/wp-content/mu-plugins/wpcloud-mu.php
COPY entrypoint.sh /entrypoint.sh
COPY hooks.json /etc/webhook/hooks.json
COPY sync-out.sh restore.sh cron.sh daemon-svc.sh compat-scan.sh /usr/local/bin/
RUN chmod +x /entrypoint.sh /usr/local/bin/*.sh && mkdir -p /state/daemons

ENV WP_ENV=production SITE_SAPI=apache PHP_TRACK=7.4
EXPOSE 80 8080 7681
ENTRYPOINT ["/entrypoint.sh"]
