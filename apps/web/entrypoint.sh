#!/bin/sh
set -eu

CERT_DIR="/etc/nginx/certs"
CERT_FILE="$CERT_DIR/karaokeai.crt"
KEY_FILE="$CERT_DIR/karaokeai.key"
LAN_IP="${KARAOKE_LAN_IP:-127.0.0.1}"

mkdir -p "$CERT_DIR"

if [ ! -s "$CERT_FILE" ] || [ ! -s "$KEY_FILE" ]; then
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

  openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 825 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -config /tmp/karaokeai-openssl.cnf

  chmod 600 "$KEY_FILE"
fi

exec nginx -g "daemon off;"
