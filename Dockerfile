FROM oven/bun:1-slim

WORKDIR /app

COPY proxy.js ./proxy.js

ENV PORT=3000 \
    IP_ALLOWLIST=

EXPOSE 3000

CMD ["bun", "proxy.js"]
