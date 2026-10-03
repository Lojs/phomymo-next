#!/bin/sh
set -e

# The three paths below are overridable only so the script can be tested outside a container.
CERT_DIR="${CERT_DIR:-/certs}"
CONF_TEMPLATE="${CONF_TEMPLATE:-/etc/nginx/conf.d/default.conf.template}"
CONF_OUT="${CONF_OUT:-/etc/nginx/conf.d/default.conf}"

CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"
# Written next to a certificate WE generated: line 1 is the domain it was issued for, line 2 its
# fingerprint. If the marker is missing, or the fingerprint no longer matches the certificate on disk
# (the user copied their own over ours), the certificate is the user's and we never touch it.
#
# The fingerprint is what makes this safe. Checking only that the files exist cannot tell a
# certificate we generated from one the user supplied, and regenerating over a real certificate
# would break a working HTTPS setup in a way the browser presents as a hijack.
MARKER="$CERT_DIR/.self-signed-for"
DOMAIN="${PHOMYMO_DOMAIN:-localhost}"
RENEW_BEFORE_SECONDS=2592000   # 30 days

mkdir -p "$CERT_DIR"

fingerprint() {
  openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null || true
}

generate_cert() {
  # An IP address must appear as an IP: entry in subjectAltName. Chromium ignores a DNS: entry for an
  # IP literal, so a certificate for 192.168.x.x written as DNS: reports a name mismatch on every
  # device — which reads as a hijack rather than as a stale file.
  case "$DOMAIN" in
    *[!0-9.]*|"") SAN="DNS:$DOMAIN" ;;
    *)             SAN="IP:$DOMAIN" ;;
  esac
  [ "$DOMAIN" = "localhost" ] || SAN="$SAN,DNS:localhost"
  SAN="$SAN,IP:127.0.0.1"

  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=$SAN" \
    2>/dev/null
  chmod 600 "$KEY"
  printf '%s\n%s\n' "$DOMAIN" "$(fingerprint)" > "$MARKER"
}

# True only for a certificate this script generated and that has not been replaced since.
is_ours() {
  [ -f "$MARKER" ] && [ "$(sed -n 2p "$MARKER")" = "$(fingerprint)" ]
}

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[phomymo] No certificate found at $CERT_DIR — generating a self-signed one for '$DOMAIN'."
  echo "[phomymo] Your browser will show a warning the first time; that's expected for a"
  echo "[phomymo] self-signed cert. To use a real certificate instead, mount cert.pem and"
  echo "[phomymo] key.pem into /certs (see the README)."
  generate_cert
elif is_ours; then
  # Ours: keep it in step with PHOMYMO_DOMAIN, and renew it before it stops being accepted rather
  # than on the day the printer app breaks.
  if [ "$(sed -n 1p "$MARKER")" != "$DOMAIN" ]; then
    echo "[phomymo] PHOMYMO_DOMAIN changed to '$DOMAIN' — regenerating the self-signed certificate."
    generate_cert
  elif ! openssl x509 -in "$CERT" -noout -checkend "$RENEW_BEFORE_SECONDS" >/dev/null 2>&1; then
    echo "[phomymo] The self-signed certificate expires within 30 days — renewing it."
    generate_cert
  fi
elif ! openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null 2>&1; then
  echo "[phomymo] WARNING: the certificate at $CERT has expired and browsers will refuse it."
  echo "[phomymo] Replace it, or delete it to have a self-signed one generated."
fi

# The HTTP->HTTPS redirect has to carry the port the browser actually used when HTTPS is not published
# on 443 (e.g. 8444:443), otherwise it sends the user to a port nothing listens on. $host has no port
# in it, which is exactly how the old redirect lost it.
case "${PHOMYMO_HTTPS_PORT:-}" in
  ""|443) PHOMYMO_REDIRECT_PORT="" ;;
  *[!0-9]*) echo "[phomymo] PHOMYMO_HTTPS_PORT must be a number, got '$PHOMYMO_HTTPS_PORT'." >&2; exit 1 ;;
  *) PHOMYMO_REDIRECT_PORT=":$PHOMYMO_HTTPS_PORT" ;;
esac
export PHOMYMO_DOMAIN PHOMYMO_REDIRECT_PORT

# Bluetooth/USB printing requires a secure context, so HTTP just redirects to HTTPS.
envsubst '${PHOMYMO_DOMAIN} ${PHOMYMO_REDIRECT_PORT}' < "$CONF_TEMPLATE" > "$CONF_OUT"

exec "$@"