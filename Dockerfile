# ---- build -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- serve (nginx + HTTPS) ----------------------------------------------------
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl gettext

COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# A self-signed cert is generated on first start if none is mounted at /certs.
# Mount your own cert.pem / key.pem at /certs to use a real one (see README).
VOLUME ["/certs"]

EXPOSE 80 443
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
