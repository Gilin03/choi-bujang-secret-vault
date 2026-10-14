import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const readBuffer = path => readFileSync(new URL(path, import.meta.url));

test('installable app manifest names the vault and explains offline limits', () => {
  const manifest = JSON.parse(read('../public/manifest.webmanifest'));
  assert.equal(manifest.name, 'BYTE BACK 자료실');
  assert.equal(manifest.short_name, '자료실');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.description, /오프라인/u);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(item => item.sizes === `${size}x${size}`);
    assert.equal(icon?.type, 'image/png');
    const png = readBuffer(`../public/vault-icon-${size}.png`);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('the page separates installed state from server-approved passkey status', () => {
  const page = read('../public/index.html');
  assert.match(page, /manifest\.webmanifest/u);
  assert.match(page, /앱 설치 상태/u);
  assert.match(page, /설치 표시.*기기 승인/u);
  assert.match(page, /api\/device\/status/u);
  assert.match(page, /api\/device\/register\/options/u);
  assert.match(page, /api\/device\/status\/verify/u);
  assert.match(page, /오프라인/u);
  assert.match(page, /persistSession:\s*false/u);
  assert.doesNotMatch(page, /\b(?:localStorage|sessionStorage|indexedDB)\b/u);
});
