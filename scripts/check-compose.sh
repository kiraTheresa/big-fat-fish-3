#!/usr/bin/env bash
set -euo pipefail

export FISH_SMOKE_SOURCE
FISH_SMOKE_SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d)
project="fish-compose-smoke-$$"
compose=(docker compose --project-name "$project" --project-directory "$scratch" --env-file "$scratch/.env" -f "$scratch/docker-compose.yml" -f "$scratch/build.yml")

cleanup() {
  status=$?
  if (( status != 0 )); then docker logs "$project" >&2 || true; fi
  docker rm -f "$project" >/dev/null 2>&1 || true
  "${compose[@]}" down --rmi local >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$FISH_SMOKE_SOURCE/docker-compose.yml" "$scratch/docker-compose.yml"
cp "$FISH_SMOKE_SOURCE/config.example.json" "$scratch/config.json"
mkdir "$scratch/data"
# The private scratch directory is accessible to the image's UID 1000 through the bind mount.
chmod a+rwx "$scratch/data"
unset NAPCAT_BIND_HOST
export ONEBOT_ACCESS_TOKEN=compose-smoke-token
export ADMIN_PORT=3210 ADMIN_PUBLISH_PORT=0
cat > "$scratch/.env" <<'EOF'
ADMIN_TOKEN=compose-smoke-admin-token
ONEBOT_ACCESS_TOKEN=compose-smoke-token
EOF
cat > "$scratch/build.yml" <<'EOF'
services:
  bot:
    build:
      context: ${FISH_SMOKE_SOURCE}
EOF

"${compose[@]}" config --format json | jq -e '
  ([.services.napcat.ports[].host_ip] == ["127.0.0.1", "127.0.0.1"]) and
  (.services.bot.ports[0] | .host_ip == "127.0.0.1" and .published == "0" and .target == 3210)
' >/dev/null
"${compose[@]}" build bot
"${compose[@]}" run --detach --no-deps --service-ports --name "$project" -e ONEBOT_WS_URL=ws://127.0.0.1:1 bot
docker exec -i "$project" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';
import { getVersion } from './src/version.js';
import { createRequire } from 'node:module';

const base = 'http://127.0.0.1:3210';
let healthy = false;
for (let attempt = 0; attempt < 40 && !healthy; attempt++) {
  healthy = await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) }).then(res => res.ok, () => false);
  if (!healthy) await wait(500);
}
assert.ok(healthy, 'Bot failed to start');
assert.equal(process.getuid(), 1000);
assert.equal(await getVersion(), createRequire(import.meta.url)('./package.json').version);
assert.equal((await fetch(base + '/api/status')).status, 401);
const status = await fetch(base + '/api/status', { headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN } });
assert.equal(status.status, 200);
assert.match(await (await fetch(base)).text(), /大肥鱼/);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<p>大肥鱼</p>');
  assert.ok((await page.screenshot()).length > 0);
} finally { await browser.close(); }
console.log('Compose bot, version, admin authentication and Chromium passed');
NODE
address=$(docker port "$project" 3210/tcp)
[[ "$address" == 127.0.0.1:* ]]
curl --fail --silent --show-error --max-time 5 "http://$address/healthz" >/dev/null
test -s "$scratch/data/management/prompts.json"
docker stop "$project" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$project")" = 0
