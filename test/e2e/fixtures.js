// Generates media fixtures and runs a "movie site" fixture server (HTTP range support, cross-origin iframe player,
// short ad video, delayed player injection, SPA navigation) used by the e2e tests.
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fixtures');
function ensureFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  const make = (name, args) => { if (!fs.existsSync(path.join(DIR, name))) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, path.join(DIR, name)]); };
  make('movie.webm', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '120', '-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libvorbis', '-g', '15']);
  make('ad.webm', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '15', '-c:v', 'libvpx', '-b:v', '50k', '-g', '15']);
  make('song.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '120', '-c:a', 'libmp3lame']);
}

function serveFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  if (m) {
    const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...h, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}

function listen(handler, port) {
  return new Promise((r) => { const s = http.createServer(handler); s.listen(port, '0.0.0.0', () => r(s)); });
}

async function startSite({ sitePort, playerPort }) {
  ensureFixtures();
  const media = (req, res) => {
    const f = req.url.split('?')[0].slice(1);
    const types = { 'movie.webm': 'video/webm', 'ad.webm': 'video/webm', 'song.mp3': 'audio/mpeg' };
    if (types[f]) return serveFile(req, res, path.join(DIR, f), types[f]);
    return false;
  };
  const player = await listen((req, res) => {
    if (media(req, res) !== false) return;
    // cross-origin embedded player; <video> is injected late, like real sites do
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<body style="margin:0"><script>setTimeout(()=>{const v=document.createElement('video');v.id='player';v.src='http://localhost:${playerPort}/movie.webm';v.controls=true;v.style.width='100%';document.body.append(v)},1200)</script>`);
  }, playerPort);
  const site = await listen((req, res) => {
    if (media(req, res) !== false) return;
    const p = req.url.split('?')[0];
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (p === '/') res.end(`<title>Movie site</title><video id="ad" src="/ad.webm" muted autoplay loop width=160></video>
      <iframe id="f" src="http://localhost:${playerPort}/" width=640 height=360></iframe>
      <a id="spa" href="#" onclick="history.pushState({},'','/watch/2');return false">next</a>`);
    else if (p === '/direct') res.end('<video id="player" src="/movie.webm" controls width=320></video>');
    else if (p === '/audio') res.end('<audio id="player" src="/song.mp3" controls></audio>');
    else res.end('<title>other</title>other page');
  }, sitePort);
  return { site, player, close: () => { site.close(); player.close(); } };
}

module.exports = { ensureFixtures, startSite, DIR };
