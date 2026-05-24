#!/usr/bin/env python3
# 41d local payload crypto (no pip deps; requires openssl CLI): AES-256-CTR + HMAC-SHA256.
# Usage: python3 41d_crypto.py enc <passphrase> '{"text":"hello"}'
#        python3 41d_crypto.py dec <passphrase> '41d1:...'
import base64, hashlib, hmac, os, subprocess, sys

cmd, passphrase, text = (sys.argv[1:] + [None, None, None])[:3]
if not cmd or not passphrase or text is None:
    sys.exit("usage: 41d_crypto.py <enc|dec> <passphrase> <text-or-token>")

def keys(salt: bytes):
    km = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, 200_000, 64)
    return km[:32], km[32:]
def tag(mac_key: bytes, data: str):
    return hmac.new(mac_key, data.encode(), hashlib.sha256).hexdigest()
def openssl_crypt(mode, key, iv, data):
    args = ["openssl", "enc", "-aes-256-ctr", "-K", key.hex(), "-iv", iv.hex(), "-nosalt"]
    if mode == "dec": args.insert(2, "-d")
    return subprocess.check_output(args, input=data)

if cmd == "enc":
    salt, iv = os.urandom(16), os.urandom(16)
    enc_key, mac_key = keys(salt)
    ct = base64.urlsafe_b64encode(openssl_crypt("enc", enc_key, iv, text.encode())).decode().rstrip("=")
    head = f"41d1:{salt.hex()}:{iv.hex()}:{ct}"
    print(head + ":" + tag(mac_key, head))
elif cmd == "dec":
    parts = text.split(":")
    if len(parts) != 5 or parts[0] != "41d1": sys.exit("bad token")
    _, salt_hex, iv_hex, ct, got = parts
    enc_key, mac_key = keys(bytes.fromhex(salt_hex))
    head = ":".join(parts[:4])
    if not hmac.compare_digest(tag(mac_key, head), got): sys.exit("bad mac")
    padded = ct + "=" * (-len(ct) % 4)
    sys.stdout.buffer.write(openssl_crypt("dec", enc_key, bytes.fromhex(iv_hex), base64.urlsafe_b64decode(padded)) + b"\n")
else:
    sys.exit("unknown command: " + cmd)
`;

export const localCryptoSh = String.raw`#!/usr/bin/env bash
# 41d local payload crypto (bash + openssl): AES-256-CTR + HMAC-SHA256.
# Usage: ./41d-crypto.sh enc <passphrase> '{"text":"hello"}'
#        ./41d-crypto.sh dec <passphrase> '41d1:...'
set -euo pipefail
[ "$#" -ge 3 ] || { echo 'usage: 41d-crypto.sh <enc|dec> <passphrase> <text-or-token>' >&2; exit 1; }
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
  head="41d1:$salt:$iv:$ct"
  echo "$head:$(hmac_hex "$head" "$mac_key")"
elif [ "$cmd" = dec ]; then
  IFS=: read -r v salt iv ct got <<< "$input"
  [ "$v" = 41d1 ] && [ -n "$salt" ] && [ -n "$iv" ] && [ -n "$ct" ] && [ -n "$got" ] || { echo 'bad token' >&2; exit 1; }
  km=$(keys "$salt"); enc_key=$(printf %s "$km" | cut -c 1-64); mac_key=$(printf %s "$km" | cut -c 65-128); head="41d1:$salt:$iv:$ct"; want=$(hmac_hex "$head" "$mac_key")
  [ "$want" = "$got" ] || { echo 'bad mac' >&2; exit 1; }
  b64=$(printf %s "$ct" | tr '_-' '/+') ; len=$(printf %s "$b64" | wc -c | tr -d ' '); pad=$(( (4 - len % 4) % 4 )); b64="$b64$(printf '=%.0s' $(seq 1 $pad))"
  printf %s "$b64" | openssl enc -d -aes-256-ctr -K "$enc_key" -iv "$iv" -nosalt -A -base64
  echo
else
  echo "unknown command: $cmd" >&2; exit 1
fi
`;