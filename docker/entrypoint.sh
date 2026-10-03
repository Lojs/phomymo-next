#!/bin/sh
set -e

CERT_DIR="/certs"
CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"
DOMAIN_FILE="$CERT_DIR/domain"
DOMAIN="${PHOMYMO_DOMAIN:-localhost}"
DAYS=825   # the maximum a browser will accept for a self-signed leaf

mkdir -p "$CERT_DIR"

have_pair() { [ -f "$CERT" ] && [ -f "$KEY" ]; }

# Regenerate when the certificate is missing, or when it was issued for a different name.
#
# The old check was file existence only, so changing PHOMYMO_DOMAIN left a certificate for the old
# address in place: the browser reported a name mismatch, which looks like a hijack rather than a
# stale file. Recording the domain next to the certificate makes the mismatch detectable.
if have_pair && [ -f "$DOMAIN_FILE" ] && [ "$(cat "$DOMAIN_FILE")" = "$DOMAIN" ]; then
  :
elif have_pair && [ ! -f "$DOMAIN_FILE" ]; then
  # Pre-existing certificate from before the domain was tracked. Adopt it rather than replacing a
  # certificate the user may have supplied deliberately.
  echo "$DOMAIN" > "$DOMAIN_FILE"
  echo "[phomymo] Using the existing certificate at $CERT_DIR (issued by an earlier version)."
else
  if have_pair; then
    echo "[phomymo] PHOMYMO_DOMAIN changed to '$DOMAIN' — regenerating the certificate."
  else
    echo "[phomymo] No certificate found at $CERT_DIR — generating a self-signed one for '$DOMAIN'."
    echo "[phomymo] Your browser will show a warning the first time; that's expected for a"
    echo "[phomymo] self-signed cert. To use a real certificate instead, mount cert.pem and"
    echo "[phomymo] key.pem into /certs (see the README)."
  fi
  rm -f "$CERT" "$KEY"
  openssl req -x509 -nodes -newkey rsa:2048 -days "$DAYS" \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1" \
    2>/dev/null
  echo "$DOMAIN" > "$DOMAIN_FILE"
fi

# Warn before the certificate stops being accepted, rather than on the day the printer app breaks.
# -checkend returns 0 while the certificate is still valid for the given number of seconds.
if openssl x509 -in "$CERT" -checkend $((30 * 24 * 3600)) >/dev/null 2>&1; then
  :
elif openssl x509 -in "$CERT" -checkend 0 >/dev/null 2>&1; then
  echo "[phomymo] WARNING: the certificate at $CERT expires within 30 days."
  echo "[phomymo] Delete $CERT to have a fresh one generated on next start."
else
  echo "[phomymo] WARNING: the certificate at $CERT has EXPIRED and browsers will refuse it."
  echo "[phomymo] Delete $CERT to have a fresh one generated on next start."
fi

# Bluetooth/USB printing requires a secure context, so HTTP just redirects to HTTPS.
envsubst '${PHOMYMO_DOMAIN}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

exec "$@"