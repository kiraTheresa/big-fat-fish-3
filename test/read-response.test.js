import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResponseBytes } from '../src/utils/read-response.js';

test('response byte limit cancels oversized streams with absent or misleading lengths', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '100' }]) {
    let cancelled = false;
    let pulls = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    }), { headers });
    await assert.rejects(readResponseBytes(response, 8), { code: 'IMAGE_RESPONSE_TOO_LARGE' });
    assert.equal(cancelled, true);
    assert.ok(pulls <= 4);
  }
  assert.equal((await readResponseBytes(new Response('12345678'), 8)).toString(), '12345678');
  assert.equal((await readResponseBytes(new Response(null), 8)).length, 0);
});
