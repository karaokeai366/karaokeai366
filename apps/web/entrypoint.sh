#!/bin/sh
set -eu

CERT_DIR="/etc/nginx/certs"
CERT_FILE="$CERT_DIR/karaokeai.crt"
KEY_FILE="$CERT_DIR/karaokeai.key"
LAN_IP="${KARAOKE_LAN_IP:-127.0.0.1}"

# Never allow an empty/invalid value into the OpenSSL SAN.
if ! printf '%s' "$LAN_IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  LAN_IP="127.0.0.1"
fi

mkdir -p "$CERT_DIR"

# Regenerate certificates when they are missing, invalid, or do not contain
# the current LAN IP. This also repairs certificates left by an earlier
# failed OpenSSL generation.
REGENERATE_CERT=0

if [ ! -s "$CERT_FILE" ] || [ ! -s "$KEY_FILE" ]; then
  REGENERATE_CERT=1
elif ! openssl x509 -in "$CERT_FILE" -noout >/dev/null 2>&1; then
  REGENERATE_CERT=1
elif ! openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName 2>/dev/null | grep -Fq "IP Address:$LAN_IP"; then
  REGENERATE_CERT=1
fi

if [ "$REGENERATE_CERT" = "1" ]; then
  rm -f "$CERT_FILE" "$KEY_FILE"

  cat > /tmp/karaokeai-openssl.cnf <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = KaraokeAI Local

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = karaokeai.local
IP.1 = 127.0.0.1
IP.2 = $LAN_IP
EOF

  openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 825     -keyout "$KEY_FILE"     -out "$CERT_FILE"     -config /tmp/karaokeai-openssl.cnf

  chmod 600 "$KEY_FILE"
fi

exec nginx -g "daemon off;"
