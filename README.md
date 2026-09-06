# HotDrop

A lightweight cross-device drop for moving **text, images, and files** between your own devices with a shared room code.

## Features

- Text sync between devices
- Whole-window drag-and-drop — drop a file anywhere on the page, not just in the composer box
- Tap/click anywhere on an item to act on it instantly: copies text, copies images, downloads files (Telegram-style)
- Instant image previews via an embedded thumbnail — full-quality bytes are only fetched when you copy or download
- File-type icons (PDF, Word, Excel, PowerPoint, archive, audio, video, code, image, generic) with distinct colors
- Instant copy: full-quality image blobs are cached after first fetch and quietly prefetched in the background as items appear, so Copy/Download is usually instant instead of waiting on a network round-trip
- **Settings screen** (gear icon, top-right) for image compression: ask every time, always compress over a size threshold to a set quality, or never compress
- **Pin items** to protect them from the automatic storage cleanup — pinned items are only evicted as an absolute last resort if a room is completely full of pinned content
- **Room expiry countdown** and a **recent rooms** list on the join screen for one-tap switching between rooms you use often
- **Share sheet integration** (Android/Chrome installs only) — share a photo or link into HotDrop directly from any other app via the OS share sheet
- Multiple file selection, clipboard-image paste support
- Chunked binary uploads/downloads
- File downloads on the receiving device
- Ctrl/Cmd + Enter to send text
- Copy room code / copy room link
- **Adaptive sync polling**: ~3s while active, then ~10s, then ~20s when idle
- Polling pauses completely while the tab is hidden/backgrounded
- Instant refresh when you return to the tab or after local activity
- Clear Live / Idle / Syncing / Paused / Offline status indicator
- Live room storage meter
- **Automatic oldest-first cleanup** when new content needs space
- 7-day room expiry
- Mobile and desktop responsive UI, dark theme
- Full favicon/PWA icon set (see `icons/`)

## Storage design

The app intentionally keeps room metadata separate from binary chunks. This avoids returning every file inside one giant API response and lets files transfer in smaller requests.

Image items additionally carry a small embedded JPEG thumbnail (generated in-browser before upload, capped around 480px / ~45KB) inside their metadata, so previews render instantly on every device without a separate fetch. The original, full-quality file is untouched in chunked storage and is what gets copied or downloaded.

Current app-level limits:

- Maximum file size: **16 MB**
- Binary chunk size: **1.5 MiB**
- Room storage target: **32 MB encoded storage**
- Maximum visible items per room: **120**
- Text item limit: **200 KB**
- Thumbnail size: **~45 KB** (base64), images only
- Room expiry: **7 days after the latest write**

When adding an item would exceed the room limit, the API automatically removes the **oldest room items first** until the new item fits. Incomplete uploads older than 15 minutes are also eligible for cleanup.

## Files

```text
index.html
api/clipboard.js
icons/                 favicon, apple/android/PWA icons, manifest
vercel.json
.env.example
.gitignore
README.md
SETUP.txt
```

No React/Vite build is required. `api/share-target.js` hand-rolls its own tiny multipart parser rather than adding a dependency, so the project still has zero npm packages.

**Share sheet note:** the Web Share Target API is Android/Chrome (and other installable-PWA browsers) only — iOS Safari does not support it, so on iPhone/iPad there's no share-sheet entry regardless of this feature.

## Testing

`test/` contains a zero-dependency integration + benchmark suite that mocks Redis in-memory and drives the real `api/clipboard.js` and `api/share-target.js` handlers directly (not reimplementations of their logic). Run it with:

```
node test/run.js
```

or `npm test` if you'd rather. It covers: text/binary CRUD, input validation and abuse-hardening (bad room codes, header-injection attempts, oversized payloads), the pin-protected eviction logic (including the "evict a pinned item only as an absolute last resort" path), room TTL surfacing, the full share-target multipart round trip (including a binary payload with embedded CRLF bytes, to make sure the parser doesn't mistake file bytes for a boundary), and a few throughput benchmarks. It does not touch your real Redis or Vercel deployment — everything runs in-process against an in-memory store.

## Icons

`icons/` contains the full generated set from the HotDrop app icon:

- `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `favicon-48x48.png` — browser tab icon
- `apple-touch-icon.png` (180×180) — iOS home screen, flattened onto a solid background (iOS renders transparency as black)
- `android-chrome-192x192.png`, `android-chrome-512x512.png` — Android / PWA manifest icons
- `icon-512-maskable.png` — Android adaptive icon, artwork padded into the safe zone so a circular mask doesn't clip it
- `icon-64.png`, `icon-96.png` — used by `index.html` for the in-app header logo
- `site.webmanifest` — PWA manifest referencing the icons above

`index.html`'s `<head>` already links all of these; nothing else to wire up.

## Deploy on Vercel

### 1. Push the folder to GitHub

```powershell
git init
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/hotdrop.git
git add .
git commit -m "HotDrop: cross-device drop with thumbnails and file-type icons"
git push -u origin main
```

If the repo already exists, use normal update commands instead.

### 2. Import into Vercel

Import the repo in the Vercel dashboard, keep the default settings (no build command needed), and add the Redis environment variables from `.env.example` under Project Settings → Environment Variables.

### 3. Add Upstash Redis

Create a free Upstash Redis database (or use Vercel's KV integration, which sets the same variables under different names — both are read automatically) and copy its REST URL and token into the environment variables above.

Redeploy after adding the environment variables.
