# SaveBox

**Android APK (v1.5.9):** https://github.com/somya2005-Aje/savebox/releases/download/v1.5.9/savebox-v1.5.9.apk — download on your phone, allow "Install unknown apps" for Chrome if asked, tap Install (Play Protect may warn — tap Install anyway). **From v1.5.7, new versions install directly over the old app — no uninstall needed.** If v1.5.6 is still installed, uninstall it once (v1.5.6 was signed with a different key), then all later updates install directly. Source repo: https://github.com/somya2005-Aje/savebox (public; APK rebuilt by GitHub Actions from `android-app/`). v1.5.9 — Personal Cloud Storage & Digital Locker

Save links, files and notes in one safe place. Find them in seconds, share them
safely, and lock private files with a PIN.

**Live URL (after deploy):** https://savebox.pages.dev/
**Stack:** vanilla HTML/CSS/JS + Tailwind via CDN. No build step, no framework.

## What works in v1.5.9 (no setup needed)

- **Auth** — register / sign in / sign out, device-local password recovery,
  profile edit, change password, account deletion (wipes that user's data).
  Passwords are stored only as SHA-256 hashes — never plain text.
  **Continue with Google** button sits above the email form (with an
  "or continue with email" divider) and on the register form too; it calls
  Firebase Google Sign-In when a config is present, and honestly says
  Firebase setup is needed when it is not. A matching button lives in
  Settings → Cloud Sync to link a Google account to a local account.
- **Save Link** — paste a YouTube / Instagram / Facebook / TikTok / website
  link; metadata is fetched for real (YouTube oEmbed, no key; other sites via
  allorigins proxy + Open Graph parsing) with a manual fallback form when a
  site blocks fetching. Editable title, description, tags, folder, custom name.
- **Upload File** — multiple files, up to 50 MB each, real FileReader progress
  bars, retry on failure. File **bytes live in IndexedDB** (`savebox-files`),
  so they survive reloads. Metadata lives in localStorage (`savebox_db_v1`).
- **Notes** — create and edit text notes, saved as searchable items.
- **Folders & subfolders** — icon + colour picker, rename, breadcrumb nav.
  Deleting a folder moves its items to All Files — never silently deletes them.
- **All Files** — grid/list toggle, sort (name/date/size/type), filter chips
  (Images, PDFs, Documents, Videos, Audio, Links, Notes, Other), global search.
- **Item actions** — Open/Preview, Rename, Edit details, Replace file (new blob
  uploads first, swap only on success), Download, Share, Duplicate, Move,
  Copy to folder, Favourite, Delete → Trash.
- **Multi-select** — bulk Move / Favourite / Add tag / Delete.
- **Trash** — restore, restore all, empty trash, hard delete (removes metadata
  + IndexedDB blob, with irreversible-warning confirm).
- **Favourites, Recently Saved, Recently Opened, Downloads** (from activity log).
- **Private Folder** — PIN-gated; items moved there are hidden from every
  other view until unlocked.
- **Preview** — images (zoom +/−, fullscreen, prev/next), video, audio, PDF
  (native browser viewer), text/JSON/HTML in a reader, unsupported types get
  Download / Open With.
- **App Lock** — 5 lock types (Settings → Security → Lock Type & Setup):
  PIN only, Password only, Fingerprint only, Fingerprint + PIN,
  Fingerprint + Password. PIN (4 / 6 / custom 4–8 digits); separate
  app-lock password (min 6 chars, SHA-256 hash only); fingerprint via
  WebAuthn platform authenticator (real device biometrics — only a
  credential ID is stored, never the fingerprint). Auto-lock (Immediately,
  30s, 1m, 5m, on background), multi-step lock screen, Private Folder
  unlocks with any configured method. Forgot lock? → unlock with account
  password, then re-set the lock. You can never be locked out with no
  recovery.
- **Security Dashboard** — app-lock/lock-type status, per-method status
  (PIN set/not set, Password set/not set, Fingerprint enrolled / not
  supported — checked live via WebAuthn), signed-in account + last login,
  active sessions with "Sign out other sessions", last 30 activity events.
- **Storage** — real quota from `navigator.storage.estimate()`, breakdown by
  type, largest files (top 10), duplicate candidates (same name + size),
  cleanup suggestions (review links only — never auto-deletes).
- **Backup / Restore / Export** — JSON backup download (files under 10 MB
  embedded as base64; larger files listed as skipped), restore from backup
  file, Export Links (CSV + JSON), Export Account Data (metadata only).
- **Settings** — vertical menu, line by line (Profile, Security, Storage,
  Backup, Cloud Sync, About); light/dark theme (persisted), default grid/list
  layout, Cloud Sync status, About with honest limits list.
- **Profile photo** — tap the camera badge on your avatar (or "Change
  photo (gallery)") to pick a photo from the gallery; the badge/button are
  real `<label for="photoInput">` elements and the input is visually hidden
  (never `display:none`), so the gallery picker opens reliably on mobile
  browsers. Photo is compressed to max 512px and stored in IndexedDB, shown
  in the header, sidebar and Profile page. Remove-photo option included.
- **3D smooth design** — folder/file cards tilt and lift on hover/tap, glossy
  buttons, floating 3D box on onboarding, 200–300ms transitions everywhere,
  skeleton loading on navigation, modal pop-in animation.
- **MEGA cloud files (20 GB free)** — connect your free MEGA account in
  Settings → Cloud Sync (email + password, two-step authentication as two
  explicit options — "No 2FA" default, "2FA is on" reveals the code box —
  optional "Keep me signed in"). Files upload to a **SaveBox** folder in your own
  MEGA Cloud drive — end-to-end encrypted by MEGA, no card, no Firebase
  needed. Login happens in the app, directly against MEGA's API (megajs
  1.3.10, vendored locally — no CDN); your MEGA password is never stored
  in plaintext anywhere and never sent to any server except MEGA. Session
  persistence is opt-in via megajs' documented `toJSON`/`fromJSON`
  mechanism, storing only the session fields (key/sid/name/user/email —
  never the password). See MEGA_SETUP.md.
- **Google Drive cloud files (15 GB free)** — link Google Drive in
  Settings → Cloud Sync (sign in with Google; SaveBox asks only for the
  `drive.file` scope, so it can access only the files it creates in your
  Drive — never your other Drive files). Files upload to a **SaveBox**
  folder in your Drive root, with real upload progress and a live quota
  line. The OAuth token is short-lived (~1 hour) and lives in memory +
  sessionStorage only — never in Firestore, localStorage or IndexedDB;
  when it expires Drive shows as disconnected and you reconnect it.
  Disconnecting revokes the token at Google and never deletes your files.
  See DRIVE_SETUP.md.
- **Automatic overflow** — new uploads go to the most recently connected
  storage (MEGA or Drive). When it fills up, SaveBox automatically uses
  the next linked storage with space; if none fits, the upload fails
  honestly ("All linked storages are full — connect another storage or
  free space") and the file stays on this device. Every file records
  which cloud it is in (`mega:<nodeHandle>` / `drive:<fileId>`), so
  downloads and deletes always resolve to the right cloud. Quota checks
  are cached ~60 s, like MEGA's.
- **Cloudflare R2 — DROPPED in v1.4.0** (user order, 23 Nov 2026). The
  R2 Worker was never deployed (the Cloudflare dashboard sign-in kept
  failing its Turnstile check) and no bucket was ever created. The v1.3.0
  R2 code stays in the app but dormant (`R2_ENABLED` false, no new R2
  uploads); files already in R2 still open from there. See R2_SETUP.md.
- **Firebase cloud (connected)** — project `savebox-f0b65`, Google Sign-In
  (popup + redirect fallback), email/password via Firebase Auth, Firestore
  sync of folders/links/notes (local merges up first, then cloud is source
  of truth). See FIREBASE_SETUP.md.
- **Share links** — private `…#share=<token>` links with optional expiry
  (1h / 1d / 7d / 30d / never) and optional password, revocable. Opening a
  share link shows a shared-item page (password prompt when protected).

## Cloud setup status

- **MEGA — ACTIVE cloud file store (v1.5.0).** App code ready, deployed
  and smoke-tested (81/81 jsdom checks: Cloud Sync redesign, Drive
  connect + overflow, 2FA options + auto-switch on a 2FA-required error,
  mega.nz link, login form, wrong-password handling, connect/disconnect,
  upload with real progress, download round-trip, delete, quota, session
  restore, R2 dormant). Needs the user to connect once in the app
  (Settings → Cloud Sync → MEGA email + password — his MEGA login is in
  the Secure Vault for browser tasks). On first connect the app creates a
  `SaveBox` folder under his (empty) Cloud drive root (handle `E3AFmJ6D`,
  verified by his screenshot 24 Nov 2026) and uses it for all uploads.
  Full steps in MEGA_SETUP.md.
- **Google Drive — ACTIVE cloud file store (v1.5.0).** Link in the app
  (Settings → Cloud Sync → Link Google Drive, `drive.file` scope only).
  Files upload to a `SaveBox` folder in the Drive root (15 GB free).
  Needs the user to sign in with Google once on his phone — Drive and
  MEGA are both policy-blocked in the cloud browser, so no real login
  can be tested from here. Full steps in DRIVE_SETUP.md.
- **Firebase — CONNECTED** (project `savebox-f0b65`, Auth + Firestore live,
  config in `final-deploy/js/firebase-config.js`). Google Sign-In and
  Firestore metadata sync work now. The Firebase/Google block no longer
  shows on the Cloud Sync screen (removed in v1.5.0 by user order) —
  Cloud Sync now shows only MEGA and Google Drive.
- **Cloudflare R2 — DROPPED by user order (23 Nov 2026).** The Worker
  (`worker/`) and app code are ready but were never deployed: R2 is not
  enabled on the Cloudflare account and the dashboard sign-in kept
  failing its Turnstile verification, so the task was dropped. Do not
  re-enable R2 unless the user asks. Full history in R2_SETUP.md.
- **Firebase Storage — NOT USED.** It needs the Blaze (billing) plan; the
  user chose free-only. File blobs go to MEGA instead, never to Firebase
  Storage.

## Honest limits

- Files stay on this device until MEGA or Google Drive is connected
  (Settings → Cloud Sync); connecting either needs no Firebase. New
  uploads go to the most recently connected storage and automatically
  overflow to the next linked storage with space when it fills up.
- Google Drive sign-in is short-lived (about 1 hour) — when it expires,
  Drive shows as disconnected and you reconnect it from Settings →
  Cloud Sync. Your files stay in Drive; disconnecting never deletes them.
- MEGA free tier: 20 GB storage, no card. Free accounts have a limited
  download/transfer quota — very large or frequent downloads can pause
  until the quota resets.
- MEGA sessions expire — without "Keep me signed in", log in again each
  time the app starts. The remembered session stores only megajs session
  fields, never the password.
- Fingerprint unlock needs a device with fingerprint/face unlock and a
  WebAuthn-capable browser — otherwise it stays honestly disabled. On the
  native Android app, fingerprint can also use BiometricPrompt (Phase 6).
- Some websites block metadata fetching — manual entry always works.
- Backups skip files over 10 MB (re-upload those manually after restore).
- Storage quota is whatever the browser grants this origin (usually large,
  but browser-managed).

## Files

```
savebox/
├── final-deploy/            # the app — deploy this folder
│   ├── index.html           # single entry point (onboarding + app shell)
│   ├── css/app.css
│   └── js/
│       ├── firebase-config.js   # real Firebase config (project savebox-f0b65)
│       ├── firebase.js          # Firebase Auth/Firestore layer
│       ├── r2-config.js         # dormant in v1.4.0 (R2 dropped)
│       ├── r2.js                # R2 Worker client (dormant in v1.4.0)
│       ├── mega-config.js       # MEGA folder handle + 20 GB quota
│       ├── buffer-vendor.js     # Buffer polyfill (megajs uploads need real Buffers)
│       ├── mega-vendor.js       # megajs 1.3.10 browser UMD, copied as-is
│       ├── mega.js              # MEGA client (login/upload/download/delete/quota)
│       ├── drive.js             # Google Drive client (connect/upload/download/delete/quota)
│       ├── db.js                # localStorage + IndexedDB data layer
│       └── app.js               # all app logic
├── mega-build/              # MEGA vendor build (npm install; build-vendors.sh)
│   ├── package.json             # megajs@1.3.10, buffer@6.0.3, esbuild, jsdom
│   └── build-vendors.sh         # rebuilds buffer-vendor.js + mega-vendor.js
├── worker/                  # Cloudflare Worker: savebox-r2 (DORMANT — R2 dropped)
│   ├── wrangler.toml            # binds R2 bucket `savebox-files`
│   └── worker.js                # token-verified upload/download/delete
├── android-app/             # Capacitor wrapper (APK)
│   ├── capacitor.config.json    # appId com.savebox.app
│   ├── package.json             # name savebox-android
│   ├── android/                 # native Android project
│   └── scripts/
│       ├── prepare-www.sh       # copies final-deploy into android-app/www
│       └── build_apk.sh         # ./gradlew assembleDebug (run on a real machine)
├── deploy_pages.py          # Cloudflare Pages deploy (parent runs on user order)
├── FIREBASE_SETUP.md        # exact Firebase setup steps
├── R2_SETUP.md              # R2 history (dropped in v1.4.0 — do not re-enable)
├── MEGA_SETUP.md            # exact MEGA connect steps, limits & security notes
├── DRIVE_SETUP.md           # exact Drive connect steps, scope, token & overflow rules
└── README.md                # this file
```

## Deploy

Parent deploys with `python3 deploy_pages.py` (Cloudflare Pages project
`savebox`). Do not deploy automatically.

## Android APK

```bash
bash android-app/scripts/prepare-www.sh
cd android-app && npm install
bash scripts/build_apk.sh   # needs Android SDK + JDK 17; see the script's notes
```

Note: Gradle may fail in sandboxed environments because its daemon uses a
loopback TCP socket that is blocked there. Build on a real machine instead.

## Version

v1.5.9 — 24 Nov 2026 (notes under photos: open any photo or file and a Note box sits right under the preview — one note per file, stored on the file's own record (description), so it is searchable and Firestore-synced with the file; Add Text without upload: "📝 New Note" is now on Home, All Files and inside every folder; text inside a new folder: creating a folder opens it straight away and the New Note button inside adds text directly in that folder, no upload needed. Smoke 27/27 pass. Same signing key as v1.5.7/v1.5.8, so v1.5.8 users install directly over it, no uninstall.)

v1.5.8 — 24 Nov 2026 (safe area: the header stays below the phone's status bar and the bottom nav above the back/home buttons, via CSS safe-area insets + the @capacitor/status-bar plugin; in-app update check: the app silently checks GitHub releases on start and shows a Download banner on Home, plus a "Check for updates" button in Settings → About. Updates install directly over the old app from v1.5.7 — v1.5.6 was signed with a different key (SHA-1 7e69b93a…), which is why it needed an uninstall; v1.5.7+ all share the committed keystore SHA-1 e42a6d03….)

v1.5.7 — 24 Nov 2026 (Google Sign-In now happens INSIDE the installed app
by user order: the web `signInWithRedirect` flow opened Chrome and the
return URL https://localhost/… only exists inside the APK WebView, so Chrome
showed ERR_CONNECTION_REFUSED. The APK now uses @capacitor-firebase/
authentication v8.6.0 — `FirebaseAuthentication.signInWithGoogle()` shows
the native Google account chooser in-app, and the ID token is exchanged with
the compat SDK, so login/signup/link/sync are unchanged. The website keeps
the popup → redirect flow. A persistent DEBUG keystore
(`android-app/android/app/debug.keystore`, SHA-1
E4:2A:6D:03:A4:01:6E:EE:51:1E:E1:12:89:DC:EB:B0:72:A9:64:E2) is committed to
the repo so the APK signature — and the Firebase SHA-1 — never change
between Actions builds. The Android app is registered in the Firebase
console (package com.savebox.app, App ID
1:877557763090:android:740b6e11de51f9a2bc9ccb) and google-services.json is at
android-app/android/app/ — see FIREBASE_SETUP.md. **v1.5.9 APK is live:**
https://github.com/somya2005-Aje/savebox/releases/download/v1.5.9/savebox-v1.5.9.apk
(versionCode 159).)

v1.5.6 — 24 Nov 2026 (App launcher icon by user order: the SaveBox shield
(blue #1769AA/#2F8FE5 + white cloud/check + gold dot on navy #102A43) is now
the APK launcher icon in all densities + adaptive icon (navy background), and
the web manifest (manifest.webmanifest + icon-192/512) fixes the
Add-to-Home-Screen icon too. VersionCode 156.)

v1.5.5 — 24 Nov 2026 (Blue theme restored by user order: the pink accent
family (#DB2777 / #EC4899 / #F472B6) is reverted to the original blues
(--royal #1769AA / --electric #2F8FE5 / --cyan #39BDEB, Tailwind royal /
electric / cyanx, gradients, shadows, focus rings, toggles, logo, lock
screen, light-blue tints). No functionality change. Smoke-tested in jsdom.)

v1.5.4 — 24 Nov 2026 (Pink theme by user order: the blue accent family
(--royal #1769AA / --electric #2F8FE5 / --cyan #39BDEB, Tailwind royal /
electric / cyanx, gradients, shadows, focus rings, toggles, logo, lock
screen) is now pink (#DB2777 / #EC4899 / #F472B6) on the same dark navy
theme. Dark backgrounds, cards, gold, MEGA red, error red, success green
and folder emoji colours are unchanged. Smoke-tested in jsdom.)

v1.5.3 — 24 Nov 2026 (Sync fix for the red "Sync failed" toast: sync now
only uses a LIVE Firebase user (FB.auth.currentUser.uid) — a stored
firebaseUid from an expired session never reaches Firestore again, so an
expired Google session no longer produces a permission error. A
permission/auth failure falls back to the MEGA-only branch (files still
sync to MEGA) with a plain-words toast and a "Reconnect Google" button in
Cloud Sync that appears ONLY after such a failure; tapping it re-runs
Google sign-in and sync retries. syncUp skips per-document denials
(docs owned by another uid) and reports the count instead of failing the
whole sync; the silent background sync stays silent. Smoke-tested 46/46
in jsdom with a mock Firebase layer + mock MEGA, and 12/12 in a firebase.js
unit test with a fake Firestore.)

v1.5.2 — 24 Nov 2026 (Cloud-first storage by user order: connected clouds
are used FIRST; the device is only the last resort when every connected
cloud is full (or none is connected) — on cloud success no device copy is
kept; existing device files are never migrated. "Storage used (on this
device)" card removed from Home, sidebar device-storage widget removed,
device meter removed from the Storage view (cloud cards only). Home
subtitle and Documents stat no longer mention device storage. Upload
modal + About state the cloud-first rule honestly. Smoke-tested 51/51 in
jsdom with mock MEGA + Map-backed blob store.)

v1.5.1 — 24 Nov 2026 (Google Drive REMOVED by user order, 2 minutes after
v1.5.0 shipped — Drive was never connected on any device, so nothing to
revoke and no Drive files exist. Cloud Sync screen shows MEGA only;
Drive removed from the upload chain, Storage view and About (one-line
history note kept); js/drive.js no longer loaded, kept on disk dormant
with DRIVE_SETUP.md for reference. MEGA untouched. Smoke-tested in jsdom
with mock MEGA.)

v1.5.0 — 24 Nov 2026 (Cloud Sync redesign by user order: Firebase/Google
block removed from the Cloud Sync screen; Google Drive linking added —
15 GB free, `drive.file` scope only, SaveBox folder in the Drive root,
live quota, Disconnect Drive; automatic overflow — new uploads go to the
most recently connected storage and move to the next linked storage with
space when it fills up, honest "all storages full" error otherwise;
"local"/"device-local" wording removed from Cloud Sync / Storage views.
Smoke-tested 81/81 in jsdom with mock Drive + mock MEGA.)

v1.4.1 — 24 Nov 2026 (MEGA login: two-step authentication is now two
explicit options — "No 2FA" default, no code sent; "2FA is on" reveals
the 6-digit box; a 2FA-required error auto-switches to "2FA is on" —
plus an "Open MEGA — mega.nz" link under the login form for new users.)

v1.4.0 — 24 Nov 2026 (MEGA.nz cloud files: 20 GB free, SaveBox folder in
the user's Cloud drive, login in the app, session restore, quota display.
R2 dropped by user order. Firebase Auth + Firestore already live.)
