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
# The template lives OUTSIDE /etc/nginx/conf.d on purpose. compose.yaml mounts a tmpfs over conf.d so
# the rendered config can be written on a read-only root filesystem, and a tmpfs hides whatever the
# image put in that directory — a template stored there is gone before the entrypoint can read it.
COPY docker/nginx.conf /usr/share/phomymo/nginx.conf.template
COPY docker/security-headers.conf /etc/nginx/snippets/phomymo-security-headers.conf
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
#
# It checks the HTTPS port rather than port 80: the latter only issues a 301, and `curl -f` treats a
# redirect as a failure, so a check on 80 would report a perfectly healthy container as unhealthy.
# -k because the certificate is self-signed, which is the normal case here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsSk https://127.0.0.1:443/ -o /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]