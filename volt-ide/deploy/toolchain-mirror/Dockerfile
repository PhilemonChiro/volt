# Static file server for the Volt toolchain mirror. No app code — just nginx
# with a hardened read-only config. Toolchain tarballs + the signed manifest.json
# live in the mounted `mirror-data` volume (see docker-compose.yml), not the image.
FROM nginx:1.27-alpine

# Replace the stock default server with our read-only, cache-aware config.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY mirror.conf /etc/nginx/conf.d/default.conf

# Serve root — populated at runtime by the mirror-data volume. Created here so
# the server starts cleanly even before the first upload.
RUN mkdir -p /srv/toolchains

EXPOSE 80
