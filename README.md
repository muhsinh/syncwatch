# SyncWatch

Watch (or listen to) the same thing at the same time, long distance. Pause, play and seek on either side and the other follows.

## How it works

```
 Desktop app (Electron)  ──┐                      ┌── Desktop app
   embedded browser +      ├─ WebSocket relay ────┤
   sync script in every    │  (server/server.js)  │── Web app / PWA (iPad, tablet, TV browser)
   frame of the page      ─┘   rooms by code       └   YouTube + direct media links
```

* **Relay server** (`server/`) – tiny Node WebSocket server, one room per code. Stores only the current page URL and playback position. It also serves the web app.
* **Desktop app** (`desktop/`) – a browser window with a sync script injected into *every* frame of whatever page you open (movie sites, embedded players, YouTube Music, …). It finds the `<video>`/`<audio>` element, reports play/pause/seek/speed, and applies your partner's. Opening a page also opens it for your partner.
* **Web app / PWA** (`web/`) – opens in any browser (iPad, Android tablet, TV browser) and installs to the home screen. Syncs YouTube and direct media URLs (`.mp4 .m3u8 .mp3 …`).
* **Sync engine** (`shared/media-sync.js`) – clock-offset correction (NTP style), drift correction (seeks if >1 s off), echo suppression, ad-clip filtering (<30 s media ignored), heartbeats from whoever last acted.

## Run it

```bash
npm install
npm run server          # relay + web app on :8787
npm run desktop         # desktop app
npm test
```

Both of you must reach the same relay. Deploy it anywhere that supports WebSockets (Fly.io, Render, Railway, a VPS; `Dockerfile` included), or run it locally and expose it with a tunnel (`cloudflared tunnel --url http://localhost:8787`). Use `wss://` for hosted servers. Then in the app: enter the server URL, a shared room code, and Connect.

Build installers: `npm run dist` (run on each OS: .dmg, .exe, AppImage/.deb).

## Device support

| Device | Status |
|---|---|
| Windows / macOS / Linux laptop | Full: any site (desktop app) |
| iPad / Android tablet / phone | Web app (PWA): YouTube + direct links. Arbitrary sites need a native wrapper (not built yet) |
| Smart TV | Open the web app in the TV browser, or cast. No native TV app yet |

## Known limits

* **Spotify / Netflix / Disney+ / other DRM'd players** need Widevine, which stock Electron lacks, so they won't play in the desktop app. YouTube, YouTube Music, SoundCloud, Bandcamp and most free/streaming-site players do.
* Players that create audio/video elements purely in JS and never attach them to the DOM can't be detected.
* Media shorter than 30 s is ignored on purpose (ads, previews).
* Both of you need access to the content (same site/account/region); only control state is shared, never the video.
* Partner navigation is followed automatically; only share a room with someone you trust. Popups are blocked.
* The relay has no auth beyond the room code: use a long unguessable code.

## Ad blocking (desktop app)

The desktop app blocks ads and trackers using the same filter lists as Adblock Plus / uBlock Origin (EasyList, EasyPrivacy, uBO lists) via the Ghostery adblocker engine, network and cosmetic. Lists download on first launch and are cached; if offline the app runs unblocked. Pirate sites with anti-adblock walls or fresh popunder domains may still get through. Ads stitched into the video stream cannot be blocked by any blocker.
