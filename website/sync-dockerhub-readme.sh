#!/usr/bin/env bash
# Push website/DOCKERHUB.md to Docker Hub as the repository description.
# Safe to re-run — idempotent PATCH.
#
# Reads credentials from $DOCKERHUB_USERNAME / $DOCKERHUB_TOKEN, or the file
# passed as $1 (defaults to ~/.dockerhub-credentials).
#
# Usage: website/sync-dockerhub-readme.sh [creds-file]
set -euo pipefail

cd "$(dirname "$0")"

CREDS_FILE="${1:-$HOME/.dockerhub-credentials}"
if [ -z "${DOCKERHUB_USERNAME:-}" ] || [ -z "${DOCKERHUB_TOKEN:-}" ]; then
  [ -f "$CREDS_FILE" ] || { echo "no creds in env, and $CREDS_FILE missing" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$CREDS_FILE"
fi

REPO="${REPO:-danimoya/claude-b}"
SHORT="${SHORT:-Background-capable Claude Code: async workflows, Telegram bot, REST API, multi-host orchestration.}"

python3 - <<PY
import json, os, urllib.request, sys
user  = os.environ['DOCKERHUB_USERNAME']
token = os.environ['DOCKERHUB_TOKEN']
repo  = "$REPO"
short = "$SHORT"

if len(short.encode('utf-8')) > 100:
    sys.exit(f"short description is {len(short.encode('utf-8'))} bytes, max 100")

with open('DOCKERHUB.md') as f:
    full_desc = f.read()

req = urllib.request.Request(
    'https://hub.docker.com/v2/users/login/',
    data=json.dumps({'username': user, 'password': token}).encode(),
    headers={'Content-Type': 'application/json'}, method='POST')
with urllib.request.urlopen(req) as r:
    jwt = json.load(r)['token']

req = urllib.request.Request(
    f'https://hub.docker.com/v2/repositories/{repo}/',
    data=json.dumps({'description': short, 'full_description': full_desc}).encode(),
    headers={'Authorization': f'JWT {jwt}', 'Content-Type': 'application/json'},
    method='PATCH')
with urllib.request.urlopen(req) as r:
    d = json.load(r)
    print(f"OK — {repo}: description {len(d.get('description') or '')} chars, full_description {len(d.get('full_description') or '')} chars")
PY
