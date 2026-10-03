# ---- build -------------------------------------------------------------------
# Build once on the native builder and reuse the result for every target platform. Without
# --platform=$BUILDPLATFORM this stage runs under QEMU emulation for linux/arm64, which is
# roughly an order of magnitude slower for an npm install plus a Vite build. The output is plain
# JavaScript and CSS, so it is identical whichever machine produced it.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- serve (nginx + HTTPS) ----------------------------------------------------
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl gettext curl

COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# A self-signed cert is generated on first start if none is mounted at /certs.
# Mount your own cert.pem / key.pem at /certs to use a real one (see README).
VOLUME ["/certs"]

# Port 80 only ever serves the redirect to HTTPS (Bluetooth/USB printing needs a secure context),
# so it is documented but the single published port is 443.
EXPOSE 443

# Reports unhealthy until nginx is actually serving. Without it a container that is up but wedged
# looks identical to a healthy one to anything watching the stack.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:80/ -o /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]