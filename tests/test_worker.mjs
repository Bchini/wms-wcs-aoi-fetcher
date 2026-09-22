import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyFeedback, limitStream } from '../src/worker.mjs';

async function drain(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  return total;
}

function streamOfChunks(chunkSizes) {
  return new ReadableStream({
    start(controller) {
      for (const size of chunkSizes) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

function withFetchStub(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('notifyFeedback does nothing when RESEND_API_KEY is unset', async () => {
  let called = false;
  await withFetchStub(
    async () => { called = true; return new Response('{}', { status: 200 }); },
    () => notifyFeedback({ NOTIFY_EMAIL: 'me@example.test' }, { message: 'x', service: 'wms', protocol: '1.3.0' })
  );
  assert.equal(called, false);
});

test('notifyFeedback does nothing when NOTIFY_EMAIL is unset', async () => {
  let called = false;
  await withFetchStub(
    async () => { called = true; return new Response('{}', { status: 200 }); },
    () => notifyFeedback({ RESEND_API_KEY: 'key' }, { message: 'x', service: 'wms', protocol: '1.3.0' })
  );
  assert.equal(called, false);
});

test('notifyFeedback posts the expected Resend payload when both are set', async () => {
  let captured = null;
  await withFetchStub(
    async (url, options) => {
      captured = { url, options };
      return new Response('{}', { status: 200 });
    },
    () =>
      notifyFeedback(
        { RESEND_API_KEY: 'test-key', NOTIFY_EMAIL: 'me@example.test' },
        { message: 'something broke', service: 'wcs', protocol: '1.0.0' }
      )
  );
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body.to, ['me@example.test']);
  assert.equal(body.text, 'something broke');
  assert.match(body.subject, /WCS/);
  assert.match(body.subject, /1\.0\.0/);
});

test('notifyFeedback swallows a failed send instead of throwing', async () => {
  await withFetchStub(
    async () => new Response('nope', { status: 500 }),
    () =>
      notifyFeedback(
        { RESEND_API_KEY: 'test-key', NOTIFY_EMAIL: 'me@example.test' },
        { message: 'x', service: 'wms', protocol: '1.3.0' }
      )
  ); // should not reject
});

test('notifyFeedback swallows a network error instead of throwing', async () => {
  await withFetchStub(
    async () => { throw new Error('network down'); },
    () =>
      notifyFeedback(
        { RESEND_API_KEY: 'test-key', NOTIFY_EMAIL: 'me@example.test' },
        { message: 'x', service: 'wms', protocol: '1.3.0' }
      )
  ); // should not reject
});

// limitStream() exists because a Content-Length check alone does nothing
// for a chunked/unknown-length response (it defaults to 0, never over any
// real cap) -- these exercise the actual byte-counting enforcement.
test('limitStream passes through a body under the cap unchanged', async () => {
  const source = streamOfChunks([1000, 1000, 1000]);
  const total = await drain(limitStream(source, 10_000));
  assert.equal(total, 3000);
});

test('limitStream errors once the cap is exceeded, even with no declared length', async () => {
  // Simulates a chunked-transfer response: no Content-Length was ever known,
  // only the actual bytes streamed matter.
  const source = streamOfChunks([5000, 5000, 5000]);
  await assert.rejects(() => drain(limitStream(source, 10_000)));
});

test('limitStream calls onSettled exactly once when the body completes normally', async () => {
  let settledCount = 0;
  const source = streamOfChunks([100]);
  await drain(limitStream(source, 10_000, () => { settledCount += 1; }));
  assert.equal(settledCount, 1);
});

test('limitStream calls onSettled exactly once when the cap is exceeded', async () => {
  let settledCount = 0;
  const source = streamOfChunks([5000, 5000, 5000]);
  await assert.rejects(() => drain(limitStream(source, 10_000, () => { settledCount += 1; })));
  assert.equal(settledCount, 1);
});
