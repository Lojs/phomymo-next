#!/bin/sh
set -e

CERT_DIR="/certs"
CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"
DOMAIN="${PHOMYMO_DOMAIN:-localhost}"

mkdir -p "$CERT_DIR"

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[phomymo] No certificate found at $CERT_DIR — generating a self-signed one for '$DOMAIN'."
  echo "[phomymo] Your browser will show a warning the first time; that's expected for a"
  echo "[phomymo] self-signed cert. To use a real certificate instead, mount cert.pem and"
  echo "[phomymo] key.pem into /certs (see the README)."
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1" \
    2>/dev/null
fi

# Bluetooth/USB printing requires a secure context, so HTTP just redirects to HTTPS.
envsubst '${PHOMYMO_DOMAIN}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

exec "$@"
