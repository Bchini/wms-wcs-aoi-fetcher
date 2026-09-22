import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyFeedback } from '../src/worker.mjs';

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
