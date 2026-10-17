// Copies the shared sync engine into the extension so it can be loaded unpacked straight from the repo.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'extension', 'lib'), { recursive: true });
for (const f of ['media-sync.js', 'room-client.js']) fs.copyFileSync(path.join(root, 'shared', f), path.join(root, 'extension', 'lib', f));
console.log('extension/lib updated');
