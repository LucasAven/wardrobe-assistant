#!/usr/bin/env bash
# Creates the Cloudflare resources this Worker needs and writes their ids into
# wrangler.jsonc. Safe to run more than once: it reuses anything that exists.
set -euo pipefail
cd "$(dirname "$0")/.."

D1_NAME=wardrobe
R2_NAME=wardrobe-photos
KV_NAME=OAUTH_KV

need() { command -v "$1" >/dev/null || { echo "missing $1"; exit 1; }; }
need node

wr() { npx wrangler "$@"; }

if ! wr whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: npx wrangler login"
  exit 1
fi

echo "==> D1"
# Look the database up by name via `d1 list`. `d1 info <name>` resolves the name
# through the binding in wrangler.jsonc, so while the id there is still a
# placeholder it queries the placeholder and fails no matter what exists.
d1_id() {
  wr d1 list --json 2>/dev/null | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j=[];try{j=JSON.parse(s)}catch{};const m=j.find(d=>d.name===process.argv[1]);console.log(m?m.uuid:"")})' "$D1_NAME"
}
D1_ID=$(d1_id)
if [ -z "$D1_ID" ]; then
  wr d1 create "$D1_NAME" >/dev/null
  D1_ID=$(d1_id)
fi
[ -n "$D1_ID" ] || { echo "could not read the D1 id"; exit 1; }
echo "    $D1_ID"

echo "==> R2"
wr r2 bucket create "$R2_NAME" >/dev/null 2>&1 || echo "    bucket already there"

echo "==> KV"
KV_ID=$(wr kv namespace list | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).find(x=>x.title.endsWith(process.argv[1]));console.log(n?n.id:"")})' "$KV_NAME")
if [ -z "$KV_ID" ]; then
  wr kv namespace create "$KV_NAME" >/dev/null
  KV_ID=$(wr kv namespace list | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).find(x=>x.title.endsWith(process.argv[1]));console.log(n?n.id:"")})' "$KV_NAME")
fi
[ -n "$KV_ID" ] || { echo "could not read the KV id"; exit 1; }
echo "    $KV_ID"

echo "==> writing ids into wrangler.jsonc"
node -e '
const fs = require("fs");
const p = "wrangler.jsonc";
let s = fs.readFileSync(p, "utf8");
s = s.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${process.argv[1]}"`);
s = s.replace(/("binding":\s*"OAUTH_KV",\s*\n\s*"id":\s*)"[^"]*"/, `$1"${process.argv[2]}"`);
fs.writeFileSync(p, s);
' "$D1_ID" "$KV_ID"

echo "==> schema"
wr d1 execute "$D1_NAME" --remote --file=src/db/schema.sql --yes >/dev/null
wr d1 execute "$D1_NAME" --local  --file=src/db/schema.sql --yes >/dev/null 2>&1 || true

cat <<'NEXT'

Resources are ready. Three secrets left, each will prompt you to paste a value:

  npx wrangler secret put ANTHROPIC_API_KEY
  npx wrangler secret put APP_PASSWORD
  npx wrangler secret put SESSION_SECRET      # any long random string

For SESSION_SECRET:  openssl rand -base64 32

For local dev, put the same three in .dev.vars (gitignored):

  ANTHROPIC_API_KEY="sk-ant-..."
  APP_PASSWORD="whatever you want"
  SESSION_SECRET="..."

One thing the CLI cannot do: Cloudflare Images has to be turned on for the
account in the dashboard, under Images. Background removal is an Images
transform, so without it every upload keeps the original and skips the cutout.

Then:  npx wrangler deploy
NEXT
