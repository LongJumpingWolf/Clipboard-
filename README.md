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
- **Reset a room** — a Settings-screen "Danger zone" button that permanently deletes every item in the current room (for every device using it), behind a confirmation step
- **Room tabs** — keep several rooms open at once and switch between them like browser tabs. Only the active tab polls; background tabs go fully to sleep (zero requests) until you switch back, then refresh instantly and show a "N new since you last looked" hint.
- **Monthly usage meter** — an 8-bit pixel-style gauge in the session snapshot estimating how much of the hosting tier's shared monthly request budget has been used, across all rooms
- **Download all as ZIP** — grabs every item in the room (text saved as `.txt`, files/images as themselves) into one ZIP file, with each entry's modification date set to when it was actually uploaded, not when the ZIP was built
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

## Security notes

A deliberate pass looking for real vulnerabilities, not just functional bugs. Findings:

**Fixed:**
- **Unbounded client-side memory growth** — background image prefetching had no cap on total cache size, fetching up to 8MB per image with no ceiling. This is the most likely explanation for occasional blank-then-reload behavior on memory-constrained devices (iPad in particular) — pressing Copy could be the final allocation that pushed Safari over its tab memory limit, triggering a silent reload. Now a proper LRU cache capped at 48MB total / 16 entries, evicting oldest-used blobs first.
- **Raw browser error surfaced to users** — a clipboard permission-timing error (`NotAllowedError`, thrown when the full-quality fetch takes long enough that the browser's user-gesture window expires) was shown verbatim instead of a readable message. Now shows "Copy timed out — tap again to retry."
- **Added a Content-Security-Policy header** — restricts script/style/font sources to only what's actually used (self, the QR library on cdnjs, Google Fonts), blocks framing entirely (`frame-ancestors 'none'`), and disallows `object-src`. Defense-in-depth on top of the points below, not a fix for something currently exploitable.
- **The CSP above briefly broke Safari** — `getBlob()` used to re-fetch an already-cached item via `fetch(blobCache.get(id))`, a `fetch()` call against a `blob:` URL. Chrome mostly doesn't enforce `connect-src` against `blob:` fetches; Safari does, strictly. With `connect-src 'self'` and no `blob:` allowance, every *second* copy/download of the same item failed on Safari with a bare "Load failed" — Safari's generic fetch-failure error, no further detail. Fixed at the root rather than by loosening the policy alone: the actual `Blob` object is now cached alongside its URL, so a cache hit returns it directly and never calls `fetch()` at all. Also added `blob:` to `connect-src` as a second layer, in case anything else ever does the same thing. A dedicated regression test (`test/sync.js`) asserts a second download of the same item issues zero additional network requests.

**Checked and confirmed safe (with regression tests added where it made sense):**
- No XSS injection path: every `innerHTML` assignment in the frontend is either clearing content or a fixed, hardcoded string with zero user data interpolated — all real user data (filenames, room codes, text) goes through `textContent`.
- Files are always served for download as `application/octet-stream`, regardless of what MIME type was claimed at upload time — an attacker can't upload a file claiming to be `text/html` and get it rendered inline by a victim's browser.
- No CORS headers are set, so the API is same-origin only by default — another website's JavaScript cannot read or write your rooms even if it somehow knew a room code.
- No prototype pollution vector — request bodies are read field-by-field, never merged or spread onto trusted objects.
- Filenames and MIME types are rejected outright if they contain CR/LF characters, closing off HTTP header-injection attempts.
- All regexes (room codes, item IDs, multipart boundary parsing) are simple bounded patterns with no nested quantifiers — no ReDoS risk.
- The share-target multipart body size is capped *during* streaming (the connection is dropped mid-upload if it's exceeded), not just checked after the fact — prevents a memory-exhaustion DoS from an oversized request.
- Share-target tokens are 128 bits of `crypto.randomBytes` and enforced single-use server-side.

**Known, accepted gap (not fixed, flagged for awareness):** there's no rate limiting on the API. A buggy or malicious client could hammer it with requests, which mainly costs *you* Redis command budget rather than exposing data (the room code is still required for meaningful access). Given the personal/small-group scope, this hasn't been built — say the word if you want basic per-IP throttling added.

## Testing

Two suites, run both with `npm test`:

**Backend** (`node test/run.js`) — zero-dependency integration + benchmark suite that mocks Redis in-memory and drives the real `api/clipboard.js` and `api/share-target.js` handlers directly (not reimplementations of their logic). Covers: text/binary CRUD, input validation and abuse-hardening (bad room codes, header-injection attempts, oversized payloads), the pin-protected eviction logic (including the "evict a pinned item only as an absolute last resort" path), room TTL surfacing, room reset, monthly usage tracking, the full share-target multipart round trip (including a binary payload with embedded CRLF bytes, to make sure the parser doesn't mistake file bytes for a boundary), and a few throughput benchmarks.

**Frontend sync** (`node test/sync.js`) — loads the real `index.html` in jsdom with a fully controllable fake network, so every request can be held open and resolved in a deliberately chosen order. This exists to prove the app can't show wrong data under bad timing. It covers the scenarios that actually cause "my file disappeared" bugs:

- A slow response for room A arriving *after* you've switched to room B (must be discarded, not painted over B)
- Two overlapping refreshes of the *same* room resolving out of order (the older one must not revert newer data) — this one caught a real bug during development, which is why the request-sequence guard exists
- Background tabs making **zero** requests while asleep
- Switching to a sleeping tab refreshing immediately, with its own data and no leakage from the previous room
- Failed requests leaving the last good data intact, and not permanently sticking the busy/sync indicator
- Rapid switching between three rooms with all responses resolved in scrambled order, ending on a tab whose feed matches that tab
- Clicking "Download all" and getting a real, valid ZIP file back — this test actually builds a file in a real DOM, writes the produced bytes to disk, and runs the system `unzip -t`/`unzip -l` against it to verify integrity and that each entry's timestamp matches its original upload time, not download time

**ZIP writer** (`node test/zip.js`) — the "Download all" feature's ZIP-writing code, verified against the real system `unzip`/`zipinfo` tools rather than trusted on faith: byte-for-byte content round-trips, per-file timestamps matching what was requested (not build time), unicode filenames, and the filename-sanitization/de-duplication logic that stops a crafted item name from creating unexpected nested folders in the archive. Runs its byte-level checks only if `unzip`/`zipinfo` are present on the machine running the tests; the structural checks always run.

Neither suite touches your real Redis or Vercel deployment — everything runs in-process. `jsdom` is the only dependency and is dev-only; the shipped app still has zero runtime dependencies.

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
