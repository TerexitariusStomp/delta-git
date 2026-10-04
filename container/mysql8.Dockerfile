# MySQL 8 sidecar — for plugins that demand real MySQL (utf8mb4_0900
# collations, MySQL-8-only syntax, version checks that reject MariaDB).
# Same ws↔TCP proxy pattern as the MariaDB sidecar; datadir on synced volume.
FROM mysql:8.0
ENV MYSQL_RANDOM_ROOT_PASSWORD=1 \
    MYSQL_DATABASE=site \
    MYSQL_USER=wp \
    MYSQL_PASSWORD_FILE=/run/secrets/wp_db_pass
CMD ["mysqld", "--datadir=/state/mysql8", "--bind-address=0.0.0.0", "--port=3306"]
