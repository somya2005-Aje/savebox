# SaveBox MEGA Setup — MEGA.nz as the cloud file store

Files uploaded in SaveBox go to a **`SaveBox` folder in the user's own
MEGA Cloud drive**, end-to-end encrypted by MEGA. Login happens in the
app, directly against MEGA's own API (megajs 1.3.10, vendored locally —
no CDN, no proxy server, no middleman).

**Free tier (no card):** 20 GB storage. Free accounts have a **limited
download/transfer quota** — very large or frequent downloads can pause
until the quota resets. There is no way around this on the free plan.

## Current status (24 Nov 2026)

- ✅ App code ready + deployed (v1.5.0): `js/mega.js` client,
  `js/mega-config.js` (folder handle + quota), `js/mega-vendor.js`
  (megajs 1.3.10 browser UMD), `js/buffer-vendor.js` (Buffer polyfill),
  wiring in `app.js` (upload on save/sync, download fallback, delete,
  Cloud Sync MEGA form + status, Storage "Cloud files (MEGA)" card,
  About text). MEGA is one of two cloud stores in v1.5.0 — the other is
  Google Drive (see DRIVE_SETUP.md); new uploads go to the most
  recently connected storage and automatically overflow to the next
  linked storage with space when it fills up.
- ✅ Verified: jsdom smoke 81/81 (see below).
- ⏳ **Needs one real login:** the user connects once in the app
  (Settings → Cloud Sync → MEGA). His MEGA login is saved in the
  Secure Vault for browser tasks. A real end-to-end cloud upload is
  NOT proven until that live-browser pass runs (parent).

## The folder

- The user's link https://mega.nz/fm/E3AFmJ6D opens his MEGA **Cloud
  drive root** (handle `E3AFmJ6D`). His screenshot (24 Nov 2026)
  confirms the drive is **empty** — no existing files to preserve.
- On first connect the app looks for a folder named exactly `SaveBox`
  under the Cloud drive root. If it is not there, the app creates it
  (`root.mkdir('SaveBox')`). Every upload goes into that folder; the
  app never uploads anywhere else in the account.
- `storagePath` for cloud files is `mega:<nodeHandle>` (the MEGA node
  handle of the uploaded file). The handle is stored in the item
  metadata, which syncs via Firestore like everything else.

## How to connect (in the app)

1. Open SaveBox → **Settings → Cloud Sync → MEGA Cloud Files**.
2. Enter the **MEGA email** and **MEGA password**, then pick a
   **Two-step authentication (2FA)** option: **"No 2FA"** (default —
   log in without a code, and no code is sent) or **"2FA is on"**
   (reveals the 6-digit code box). If MEGA asks for a code after a
   "No 2FA" attempt, the form switches to "2FA is on" by itself,
   shows the code box and focuses it.
3. New to MEGA? The form has a link **"Open MEGA — mega.nz"**
   (https://mega.nz/) under the login form — it opens MEGA directly
   so an account can be created there. It is only shown while logged out.
4. Tick **"Keep me signed in on this device"** only if the session
   should survive app restarts (see Security below).
5. Tap **Connect MEGA**. On success the Cloud tab shows "Connected" +
   the account email + live quota ("X of 20 GB used"), and the Storage
   view shows the "Cloud files (MEGA)" card.
6. Upload a file (or tap **Sync Now**). It appears in MEGA under
   Cloud drive → SaveBox. Open it in the MEGA app/web to confirm.

No Firebase or Google Sign-In is needed for MEGA cloud files. Sync Now
uploads pending files to MEGA even without Firebase; folders/links/notes
still need Firebase to sync across devices.

## Security — how credentials are handled

- The MEGA email/password are typed into the app's own form and passed
  straight to `new mega.Storage()` — they go **only to MEGA**
  (`g.api.mega.co.nz`). They are **never** sent to Firebase, Cloudflare,
  or any other server, and **never stored in plaintext anywhere** (not
  in Firestore, localStorage, or IndexedDB). megajs itself deletes
  `options.password` from memory after login, and the app clears the
  password field after every attempt.
- **Session persistence is opt-in** ("Keep me signed in"). It uses
  megajs' documented session mechanism: `storage.toJSON()` /
  `Storage.fromJSON()` (megajs 1.3.10 types). Only the session fields
  are kept — `key`, `sid`, `name`, `user`, `email` — and `options` is
  stored **empty**, so the stored session can never contain the
  password. It lives in localStorage under `savebox.mega.session.v1`.
  Default (checkbox off) is **session-only**: log in again each time
  the app starts.
- **Disconnect MEGA** (Cloud tab) closes the server session and deletes
  any remembered session on the device. Files already in MEGA stay
  there; new files stay on the device.
- The app never logs or displays the MEGA password. Error messages are
  mapped to friendly text ("Wrong MEGA email or password") and never
  include credential material.

## How it works

| Piece | What it does |
|---|---|
| `js/mega-vendor.js` | megajs 1.3.10 browser UMD (237 KB), copied as-is from npm. Exposes `window.mega.Storage`. |
| `js/buffer-vendor.js` | Buffer polyfill (buffer@6.0.3, 27 KB, built by `mega-build/build-vendors.sh`). REQUIRED: megajs' browser upload streams reject plain Uint8Array chunks — only real Buffer instances are accepted. |
| `js/mega-config.js` | Single injection point: root handle `E3AFmJ6D`, folder name `SaveBox`, 20 GB quota. |
| `js/mega.js` | `SaveBoxMega` client: `login` (email/password/remember/2FA, 90 s timeout), `restoreSession` (fromJSON + reload), `logout`, `upload` (256 KB Buffer chunks, real progress), `download` (downloadBuffer → Blob), `remove` (permanent node delete), `quota` (getAccountInfo, cached 60 s). All calls reject when MEGA is not connected — callers fail soft. |
| `app.js` | `uploadBlobToCloud` (MEGA first, R2 legacy second), `resolveFileBlob` (local blob first, then MEGA for `mega:` paths), `deleteCloudFile` (hard delete + empty trash), `syncNow` (MEGA-only mode works without Firebase), Cloud Sync MEGA form/status, Storage MEGA card, About text. |

## Checking usage

- In the app: Settings → Cloud Sync shows live quota ("X of 20 GB
  used"); Settings → Storage shows the "Cloud files (MEGA)" card with
  the cloud file count + total bytes from synced metadata.
- In MEGA: mega.nz → Cloud drive → SaveBox (or the MEGA app) shows the
  files; Account → Dashboard shows storage + transfer quota.

## If the MEGA session expires

- Symptom: files that used to open from the cloud now fail, and the
  Cloud tab shows "Not connected" (or the quota line says
  "unavailable"). Uploads stay device-local.
- Fix: Settings → Cloud Sync → log in again with the MEGA email +
  password. If "Keep me signed in" was ticked and the session still
  fails, it has expired server-side — log in again; nothing is lost
  (files stay in the MEGA SaveBox folder).
- If the MEGA account itself is locked / the password changed, the
  login form shows "Wrong MEGA email or password" — fix the account
  in MEGA first, then reconnect.

## Limits (honest)

- 20 GB storage on the free plan. Past 20 GB, uploads fail with a
  clear error — nothing is silently lost.
- Free transfer quota: heavy downloading can pause until it resets.
- 50 MB max per file (app limit, same as before).
- Uploads in the browser use pure-JS crypto (megajs + Buffer polyfill),
  so very large files upload slower than MEGA's own app — progress is
  shown honestly while it runs.
- No real end-to-end cloud upload is proven until the live-browser pass
  with the user's saved MEGA login (parent). The jsdom smoke below
  covers everything up to the network boundary.

## Automatic overflow (v1.5.0)

MEGA is one of two cloud stores now — the other is Google Drive
(15 GB free, see DRIVE_SETUP.md). How new uploads choose a store:

- New uploads go to the **most recently connected** storage. Connect
  Drive after MEGA and new files go to Drive; connect MEGA after Drive
  and new files go to MEGA.
- When that storage is **full** (cached free space < file size), the
  upload automatically goes to the next linked storage with space.
  Quota checks are cached ~60 s, like MEGA's own quota cache.
- If **no** linked storage fits, the upload fails honestly — "All
  linked storages are full — connect another storage or free space" —
  and the file stays on this device. Nothing is ever faked as uploaded.
- Every file records its store in `storagePath` (`mega:<nodeHandle>` /
  `drive:<fileId>`), so downloads and deletes always resolve to the
  right cloud regardless of which storage is the current default.
- Disconnecting MEGA only signs you out here — files already in MEGA
  stay there and still open from the app.

## Verification (24 Nov 2026)

jsdom smoke `/tmp/sb15/smoke.js` — **81/81 pass, 0 window errors** (v1.5.0):
- Cloud Sync redesign: no Firebase/R2/"Local items"/"device-local" text;
  Drive section with Link button + scope note; MEGA form + 2FA options +
  mega.nz link still present.
- Drive connect (mock): Connected + email + quota + Disconnect, SaveBox
  folder created, chain `["drive"]`; MEGA login: chain
  `["mega","drive"]` (newest-connected first).
- Overflow: MEGA full + Drive with space → upload lands on Drive
  (`drive:` path), MEGA gets nothing; both full → honest "All linked
  storages are full" toast, no cloud upload; disconnect Drive → chain
  `["mega"]`, upload goes MEGA; reconnect Drive → chain
  `["drive","mega"]`, upload goes Drive; disconnect revokes the token
  and does not delete Drive files.
- Real `mega-vendor.js` loads (`window.mega.Storage`, `fromJSON`/`toJSON`/
  `getAccountInfo`/`reload`, `File.downloadBuffer`); real bundle's
  upload stream accepts Buffer chunks (and rejects plain Uint8Array —
  this caught a real bug: the wrapper now writes Buffer chunks via the
  shim; see `mega-build/build-vendors.sh`).
- App boots, register opens the app, Cloud tab shows the MEGA form with
  honest "Not connected" + password-never-stored note; empty login and
  wrong credentials give friendly inline errors; good login connects
  (Connected + email + Disconnect + live quota); remembered session is
  stored **without the password**; `restoreSession()` revives it;
  upload resolves a `mega:` path with real rising progress ending at 1;
  download round-trips the exact bytes; delete removes it; Storage
  "Cloud files (MEGA)" card + live quota line; About v1.5.0 + MEGA
  limits; 6 Settings rows; Save Link modal still opens; logout clears
  the session and upload/download/quota reject cleanly when disconnected.
- No real MEGA login was attempted (no credentials exist in this
  environment) — the mock implements the exact verified megajs 1.3.10
  method signatures.

## Rebuilding the vendors

```bash
cd ~/workspace/savebox/mega-build
npm install          # megajs@1.3.10, buffer@6.0.3, esbuild, jsdom
bash build-vendors.sh   # rebuilds js/buffer-vendor.js + js/mega-vendor.js
node --check ../final-deploy/js/mega.js ../final-deploy/js/buffer-vendor.js
NODE_PATH=$(pwd)/node_modules node /tmp/sb14/smoke.js   # 41 checks
python3 ../deploy_pages.py   # deploy (parent runs on user order)
```
