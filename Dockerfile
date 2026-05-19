FROM alpine:3.22.2

WORKDIR /app

RUN apk add --no-cache ca-certificates libgcc libstdc++

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY proxy.js ./proxy.js

ENV PORT=3000 \
    ALLOWLIST= \
    BUN_INSTALL=/opt/bun \
    BUN_VERSION=latest

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["proxy.js"]
