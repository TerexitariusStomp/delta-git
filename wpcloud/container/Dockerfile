# Lane-3 site image (FrankenPHP SAPI): web server + PHP worker-mode in one binary
# + WordPress + SQLite + WP-CLI + webhook agent + rclone + ttyd + Adminer + runit.
# Variant matrix: PHP_VERSION picks the FrankenPHP PHP track; Apache SAPI and
# PHP-7.4 are separate Dockerfiles; DB engines are sidecars, not baked in.
ARG PHP_VERSION=8.4
FROM dunglas/frankenphp:1-php${PHP_VERSION}-alpine AS php
FROM alpine:3.20

RUN apk add --no-cache bash curl sqlite unzip ca-certificates mariadb-client imagemagick runit jq

# FrankenPHP binary (includes Caddy web server + PHP)
COPY --from=php /usr/local/bin/frankenphp /usr/local/bin/frankenphp
COPY --from=php /usr/local/lib/php /usr/local/lib/php
COPY --from=php /usr/local/etc/php /usr/local/etc/php

# WP-CLI
RUN curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
 && chmod +x /usr/local/bin/wp

# rclone (uploads→R2 + backups), ttyd (browser shell), webhook (agent API) — binaries
RUN curl -fsSL https://rclone.org/install.sh | bash \
 && curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
 && curl -fsSL https://github.com/adnanh/webhook/releases/download/2.8.2/webhook-linux-amd64.tar.gz | tar -xz --strip-components=1 -C /usr/local/bin webhook-linux-amd64/webhook \
 && chmod +x /usr/local/bin/ttyd /usr/local/bin/webhook

# Adminer (single-file DB admin)
RUN curl -fsSL -o /srv/adminer.php https://github.com/vrana/adminer/releases/download/v4.8.1/adminer-4.8.1.php

# WordPress + plugins
RUN mkdir -p /srv/site && cd /srv/site \
 && curl -fsSL https://wordpress.org/latest.tar.gz | tar -xz --strip-components=1 \
 && cd wp-content/plugins \
 && for p in sqlite-database-integration fluent-smtp sqlite-object-cache; do \
      curl -fsSL -o /tmp/$p.zip https://downloads.wordpress.org/plugin/$p.latest-stable.zip && unzip -q /tmp/$p.zip; \
    done \
 && curl -fsSL -o /tmp/s3-uploads.zip https://github.com/humanmade/S3-Uploads/archive/refs/tags/3.0.13.zip \
 && unzip -q -d /tmp/s3u /tmp/s3-uploads.zip && mv /tmp/s3u/S3-Uploads-3.0.13 s3-uploads \
 && mkdir -p /srv/site/wp-content/mu-plugins \
 && cp sqlite-database-integration/db.copy /srv/site/wp-content/db.php \
 && sed -e "s|{SQLITE_IMPLEMENTATION_FOLDER_PATH}|/srv/site/wp-content/plugins/sqlite-database-integration|" \
        -e "s|{SQLITE_PLUGIN}|sqlite-database-integration/load.php|" \
        /srv/site/wp-content/plugins/sqlite-database-integration/db.copy > /srv/site/wp-content/db.php

# platform mu-plugin (webhook bridge + magic-login)
COPY wpcloud-mu.php /srv/site/wp-content/mu-plugins/wpcloud-mu.php

COPY Caddyfile /etc/frankenphp/Caddyfile
COPY entrypoint.sh /entrypoint.sh
COPY hooks.json /etc/webhook/hooks.json
COPY sync-out.sh restore.sh cron.sh daemon-svc.sh compat-scan.sh /usr/local/bin/
RUN chmod +x /entrypoint.sh /usr/local/bin/*.sh && mkdir -p /state/daemons

ENV WP_ENV=production
EXPOSE 80 8080 7681
ENTRYPOINT ["/entrypoint.sh"]
