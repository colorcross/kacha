import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { serveMedia } from '../scripts/kacha_studio_server.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-media-lifecycle-'));
const file = path.join(root, 'source.mp4');
fs.writeFileSync(file, 'abcdefghij');
const fd = fs.openSync(file, 'r+'); fs.ftruncateSync(fd, 64 * 1024 * 1024); fs.closeSync(fd);
const stat = fs.statSync(file);
const media = { path: file, identity: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, inode: stat.ino } };
const streams = [];
const original = fs.createReadStream;
let failRead = false;
fs.createReadStream = (...args) => {
  const stream = original(...args); streams.push(stream);
  if (failRead) setImmediate(() => stream.destroy(new Error('controlled read failure')));
  return stream;
};
const server = http.createServer((request, response) => {
  try { serveMedia(request, response, media); }
  catch (error) { response.writeHead(400); response.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
async function closed(stream) {
  if (!stream.closed) await once(stream, 'close', { signal: AbortSignal.timeout(3000) });
  assert.equal(stream.closed, true); assert.equal(stream.fd, null);
}
async function abort(headers) {
  const before = streams.length;
  await new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      response.once('data', () => { response.destroy(); resolve(); });
      response.once('error', reject);
    });
    request.once('error', reject);
  });
  assert.equal(streams.length, before + 1);
  await closed(streams.at(-1));
}
try {
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(stat.size));
  assert.equal(streams.length, 0);
  const bytes = await fetch(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(bytes.status, 206); assert.equal(await bytes.text(), 'cdef');
  await closed(streams.at(-1));
  const suffix = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=-5' } });
  assert.equal(suffix.status, 206); assert.equal(suffix.headers.get('content-length'), '5');
  for (const range of ['bytes=-', 'bytes=9-1', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'bytes=-0']) {
    assert.equal((await fetch(url, { headers: { Range: range } })).status, 416);
  }
  for (let i = 0; i < 3; i++) { await abort({}); await abort({ Range: `bytes=${i}-` }); }
  failRead = true;
  await assert.rejects(async () => { const response = await fetch(url); await response.arrayBuffer(); });
  // An intentional source error may precede close; observe close without once()'s error rejection.
  const failed = streams.at(-1);
  if (!failed.closed) await new Promise(resolve => failed.once('close', resolve));
  assert.equal(failed.fd, null);
  failRead = false;
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200, 'server survives a source error');
  const full = await fetch(url); const body = await full.arrayBuffer();
  assert.equal(body.byteLength, stat.size); await closed(streams.at(-1));
  console.log(JSON.stringify({ status: 'pass', checks: ['full-and-range-completion', 'head-and-invalid-ranges', 'six-client-aborts-close-file-descriptors', 'read-error-closes-file-and-server-survives'], streams: streams.length }, null, 2));
} finally {
  fs.createReadStream = original;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
