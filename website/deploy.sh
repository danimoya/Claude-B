#!/usr/bin/env bash
# Deploy the claude-b.danimoya.com / cb.danimoya.com landing container.
#
# Prerequisites:
#   - Docker daemon reachable
#   - NPM (Nginx Proxy Manager) running at http://localhost:81
#   - NPM credentials exported:
#       NPM_USER=daniel.moya@...
#       NPM_PASSWORD=...
#   - A record for claude-b.danimoya.com + cb.danimoya.com pointing at the server IP
#
# Usage:
#   cd website && ./deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

# Keep install.sh in sync with scripts/install.sh (single source of truth)
cp ../scripts/install.sh install.sh

IMAGE="claude-b-landing:latest"
CONTAINER="claude-b-landing"
NETWORK="management-network"
DOMAINS='["claude-b.danimoya.com","cb.danimoya.com"]'

echo "==> Building $IMAGE"
docker build -t "$IMAGE" .

echo "==> Replacing container $CONTAINER"
docker rm -f "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  --restart unless-stopped \
  "$IMAGE"

# Create/update NPM proxy host
: "${NPM_USER:?export NPM_USER (see ~/.npm-credentials)}"
: "${NPM_PASSWORD:?export NPM_PASSWORD (see ~/.npm-credentials)}"

echo "==> Authenticating with NPM"
TOKEN=$(curl -fsS -X POST "http://localhost:81/api/tokens" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$NPM_USER\",\"secret\":\"$NPM_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

echo "==> Creating/updating proxy host"
HOST_ID=$(curl -fsS "http://localhost:81/api/nginx/proxy-hosts" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import json, sys
hosts = json.load(sys.stdin)
for h in hosts:
    if 'cb.danimoya.com' in h['domain_names'] or 'claude-b.danimoya.com' in h['domain_names']:
        print(h['id']); break
")

PAYLOAD=$(cat <<EOF
{
  "domain_names": $DOMAINS,
  "forward_scheme": "http",
  "forward_host": "$CONTAINER",
  "forward_port": 80,
  "allow_websocket_upgrade": false,
  "block_exploits": true,
  "caching_enabled": true,
  "http2_support": true,
  "advanced_config": "add_header X-Content-Type-Options nosniff;"
}
EOF
)

if [ -n "$HOST_ID" ]; then
  echo "  → Updating existing proxy host $HOST_ID"
  curl -fsS -X PUT "http://localhost:81/api/nginx/proxy-hosts/$HOST_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" >/dev/null
else
  echo "  → Creating new proxy host"
  NEW=$(curl -fsS -X POST "http://localhost:81/api/nginx/proxy-hosts" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
  HOST_ID=$(printf '%s' "$NEW" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi

echo "==> Requesting Let's Encrypt cert"
# NPM's create-cert schema only accepts a minimal meta — letsencrypt_email / agree
# are pulled from settings, not the request body.
CERT_ID=$(curl -fsS -X POST "http://localhost:81/api/nginx/certificates" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"provider\":\"letsencrypt\",\"nice_name\":\"cb.danimoya.com\",\"domain_names\":$DOMAINS,\"meta\":{\"dns_challenge\":false}}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null || echo "")

if [ -n "$CERT_ID" ]; then
  echo "  → Attaching cert $CERT_ID to proxy host $HOST_ID"
  curl -fsS -X PUT "http://localhost:81/api/nginx/proxy-hosts/$HOST_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(printf '%s' "$PAYLOAD" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.update({'certificate_id': $CERT_ID, 'ssl_forced': True, 'hsts_enabled': True})
print(json.dumps(d))
")" >/dev/null
fi

echo
echo "✓ Deployed. Test with:"
echo "    curl -fsSL https://cb.danimoya.com | head"
