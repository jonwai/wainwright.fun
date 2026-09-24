#!/usr/bin/env bash
# Generates a self-signed certificate for signing .mobileconfig profiles.
# Run once: bash scripts/generate-signing-cert.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/certificates"

mkdir -p "$CERT_DIR"

if [[ -f "$CERT_DIR/profile-signing.key" && -f "$CERT_DIR/profile-signing.crt" ]]; then
  echo "Certificate already exists at $CERT_DIR/"
  echo "  To regenerate, delete certificates/ and re-run this script."
  exit 0
fi

cat > "$CERT_DIR/openssl.cnf" << 'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca

[dn]
CN = Wainwright Family Profile Signing
O = Wainwright Family

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyCertSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
EOF

echo "Generating self-signed certificate for profile signing..."

openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERT_DIR/profile-signing.key" \
  -out "$CERT_DIR/profile-signing.crt" \
  -days 3650 -nodes \
  -config "$CERT_DIR/openssl.cnf"

echo ""
echo "Done! Certificate and key created at:"
echo "  $CERT_DIR/profile-signing.crt"
echo "  $CERT_DIR/profile-signing.key"
echo ""
echo "Profiles built with 'npm run build' will now be signed automatically."
echo ""
echo "To allow Apple Configurator to remove signed profiles, download the cert"
echo "from https://<child>.wainwright.fun/signing-certificate.crt and add it"
echo "to your Mac's login keychain with 'Always Trust'."
