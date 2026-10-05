# MariaDB sidecar for Lane-3 Woo/Business sites.
# Runs alongside the site container in the same TenantDO namespace;
# web containers reach it via the DO's ws↔TCP proxy on :3306.
FROM mariadb:11-alpine
ENV MARIADB_RANDOM_ROOT_PASSWORD=1 \
    MARIADB_DATABASE=site \
    MARIADB_USER=wp \
    MARIADB_PASSWORD_FILE=/run/secrets/wp_db_pass
# datadir on the synced state volume so rclone's dump/restore path covers it
CMD ["mariadbd", "--datadir=/state/mysql", "--bind-address=0.0.0.0", "--port=3306"]
