#!/bin/sh
set -eu
cat <<'COMMANDS'
# Run these commands yourself, once. This helper only prints them.
# The certificate and private key are for this Mac's local builds, not distribution.
mkdir -p "$HOME/.ao/local-signing"
chmod 700 "$HOME/.ao/local-signing"
umask 077
cat > "$HOME/.ao/local-signing/openssl.cnf" <<'CONFIG'
[req]
distinguished_name = subject
x509_extensions = code_signing
prompt = no
[subject]
CN = Noetaxis Local Code Signing
[code_signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CONFIG
/usr/bin/openssl req -new -newkey rsa:3072 -x509 -sha256 -days 3650 \
  -keyout "$HOME/.ao/local-signing/noetaxis.key" \
  -out "$HOME/.ao/local-signing/noetaxis.crt" \
  -config "$HOME/.ao/local-signing/openssl.cnf"
/usr/bin/openssl pkcs12 -export \
  -inkey "$HOME/.ao/local-signing/noetaxis.key" \
  -in "$HOME/.ao/local-signing/noetaxis.crt" \
  -name 'Noetaxis Local Code Signing' \
  -out "$HOME/.ao/local-signing/noetaxis.p12" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
/usr/bin/security import "$HOME/.ao/local-signing/noetaxis.p12" \
  -k "$HOME/Library/Keychains/login.keychain-db" -T /usr/bin/codesign
/usr/bin/security add-trusted-cert -r trustRoot -p codeSign \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.ao/local-signing/noetaxis.crt"
/usr/bin/security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db"
# Reuse this setting for EVERY build; a new certificate means a new identity.
export NOETAXIS_SIGN_IDENTITY='Noetaxis Local Code Signing'
node frontend/scripts/noetaxis-macos/build.mjs --ref HEAD --public-registry
COMMANDS
