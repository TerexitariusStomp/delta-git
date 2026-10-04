# Lane-3 site image: FrankenPHP (web server + PHP worker-mode in one binary)
# + WordPress + SQLite + WP-CLI + webhook agent + rclone + ttyd + Adminer.
# MariaDB is a separate sidecar container for Woo sites (not baked in).
FROM dunglas/frankenphp:1-alpine AS php
FROM alpine:3.20

RUN apk add --no-cache bash curl sqlite ca-certificates mariadb-client

# FrankenPHP binary (includes Caddy web server + PHP)
COPY --from=php /usr/local/bin/frankenphp /usr/local/bin/frankenphp
COPY --from=php /usr/local/lib/php /usr/local/lib/php
COPY --from=php /usr/local/etc/php /usr/local/etc/php

# WP-CLI
RUN curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
 && chmod +x /usr/local/bin/wp

# rclone (uploads→R2 + backups) and ttyd (browser shell)
RUN curl -fsSL https://rclone.org/install.sh | bash \
 && curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
 && chmod +x /usr/local/bin/ttyd

# adnanh/webhook — in-container agent API (control plane → site ops)
RUN curl -fsSL -o /usr/local/bin/webhook https://github.com/adnanh/webhook/releases/download/2.8.2/webhook-linux-amd64.tar.gz \
 && tar -xzf /usr/local/bin/webhook -C /usr/local/bin --strip-components=1 && chmod +x /usr/local/bin/webhook

# Adminer (single-file DB admin)
RUN curl -fsSL -o /srv/adminer.php https://github.com/vrana/adminer/releases/download/v4.8.1/adminer-4.8.1.php

# WordPress + SQLite integration + plugins
RUN mkdir -p /srv/site && cd /srv/site \
 && curl -fsSL https://wordpress.org/latest.tar.gz | tar -xz --strip-components=1 \
 && curl -fsSL -o /tmp/sqlite.zip https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip \
 && cd /srv/site/wp-content/plugins && unzip -q /tmp/sqlite.zip \
 && curl -fsSL -o /tmp/s3u.zip https://downloads.wordpress.org/plugin/s3-uploads.latest-stable.zip && unzip -q /tmp/s3u.zip \
 && curl -fsSL -o /tmp/fsmtp.zip https://downloads.wordpress.org/plugin/fluent-smtp.latest-stable.zip && unzip -q /tmp/fsmtp.zip \
 && curl -fsSL -o /srv/site/wp-content/object-cache.php https://raw.githubusercontent.com/humanmade/S3-Uploads/master/inc/class-s3-uploads.php 2>/dev/null || true

COPY Caddyfile /etc/frankenphp/Caddyfile
COPY entrypoint.sh /entrypoint.sh
COPY hooks.json /etc/webhook/hooks.json
COPY sync-out.sh restore.sh cron.sh /usr/local/bin/
RUN chmod +x /entrypoint.sh /usr/local/bin/*.sh

ENV WP_ENV=production
EXPOSE 80 8080 7681
ENTRYPOINT ["/entrypoint.sh"]
