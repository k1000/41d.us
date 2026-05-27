#!/usr/bin/env bash
# j01n local payload crypto (bash + openssl): AES-256-CTR + HMAC-SHA256.
# Usage: ./j01n-crypto.sh enc <passphrase> '{"text":"hello"}'
#        ./j01n-crypto.sh dec <passphrase> 'j01n1:...'
set -euo pipefail
[ "$#" -ge 3 ] || { echo 'usage: j01n-crypto.sh <enc|dec> <passphrase> <text-or-token>' >&2; exit 1; }
cmd="$1"; pass="$2"; input="$3"

keys() {
  openssl kdf -keylen 64 -kdfopt digest:SHA256 -kdfopt "pass:$pass" -kdfopt "hexsalt:$1" -kdfopt iter:200000 PBKDF2 | tr -d ':\n'
}
hmac_hex() {
  printf %s "$1" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$2" -binary | xxd -p -c 256
}

if [ "$cmd" = enc ]; then
  salt=$(openssl rand -hex 16); iv=$(openssl rand -hex 16); km=$(keys "$salt")
  enc_key=$(printf %s "$km" | cut -c 1-64); mac_key=$(printf %s "$km" | cut -c 65-128)
  ct=$(printf %s "$input" | openssl enc -aes-256-ctr -K "$enc_key" -iv "$iv" -nosalt -A -base64 | tr '+/' '-_' | tr -d '=')
  head="j01n1:$salt:$iv:$ct"
  echo "$head:$(hmac_hex "$head" "$mac_key")"
elif [ "$cmd" = dec ]; then
  IFS=: read -r v salt iv ct got <<< "$input"
  [ "$v" = j01n1 ] && [ -n "$salt" ] && [ -n "$iv" ] && [ -n "$ct" ] && [ -n "$got" ] || { echo 'bad token' >&2; exit 1; }
  km=$(keys "$salt"); enc_key=$(printf %s "$km" | cut -c 1-64); mac_key=$(printf %s "$km" | cut -c 65-128); head="j01n1:$salt:$iv:$ct"; want=$(hmac_hex "$head" "$mac_key")
  [ "$want" = "$got" ] || { echo 'bad mac' >&2; exit 1; }
  b64=$(printf %s "$ct" | tr '_-' '/+') ; len=$(printf %s "$b64" | wc -c | tr -d ' '); pad=$(( (4 - len % 4) % 4 )); b64="$b64$(printf '=%.0s' $(seq 1 $pad))"
  printf %s "$b64" | openssl enc -d -aes-256-ctr -K "$enc_key" -iv "$iv" -nosalt -A -base64
  echo
else
  echo "unknown command: $cmd" >&2; exit 1
fi
