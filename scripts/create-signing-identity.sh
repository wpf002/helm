#!/usr/bin/env bash
# Creates the stable self-signed code-signing identity Helm is signed with.
# Idempotent: does nothing if the identity already exists.
#
#   ./scripts/create-signing-identity.sh
#
# Why this exists: macOS keys the Full Disk Access grant to the code signature.
# electron-builder signs ad-hoc by default, producing a new signature on every
# build, so macOS silently drops the grant each time and Helm loses access to
# Documents, Desktop and Downloads until you re-grant it. Signing with one
# stable identity means the grant is given once.
#
# This does not need admin rights and does not add a trusted root. The
# certificate is never verified by anyone — codesign only needs the private key
# to produce a consistent signing identity, which is why `security find-identity
# -p codesigning` does not list it while `codesign --sign` still accepts it.

set -euo pipefail

IDENTITY="${HELM_SIGN_IDENTITY:-Helm Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "==> '$IDENTITY' already exists in the login keychain"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/req.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "==> generating a self-signed code-signing certificate"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/req.cnf" 2>/dev/null

openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/bundle.p12" -passout pass:helm -name "$IDENTITY" 2>/dev/null

echo "==> importing into the login keychain"
# -T grants codesign access without a prompt on every use.
security import "$WORK/bundle.p12" -k "$KEYCHAIN" -P helm \
  -T /usr/bin/codesign -T /usr/bin/security -A >/dev/null

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "==> '$IDENTITY' created."
  echo "    Note: it will not appear in 'security find-identity -p codesigning'"
  echo "    because it has no trust settings. codesign accepts it regardless,"
  echo "    which is all a stable signature requires."
else
  echo "error: import reported success but the certificate is not present." >&2
  exit 1
fi
