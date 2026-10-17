const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
test('extension/lib is in sync with shared/ (run: node scripts/build-extension.js)', () => {
  for (const f of ['media-sync.js', 'room-client.js']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '../extension/lib', f), 'utf8'), fs.readFileSync(path.join(__dirname, '../shared', f), 'utf8'), f);
  }
});
