> REMOVED FROM THE APP per user order 2026-11-24 (v1.5.1): Google Drive was removed — MEGA is the only cloud storage now. This doc is kept for reference only; the app no longer loads js/drive.js.

# SaveBox Google Drive Setup — Drive as a cloud file store (v1.5.0)

Files uploaded in SaveBox can go to a **`SaveBox` folder in the user's own
Google Drive**, alongside MEGA. No new OAuth client ID, no new keys: the
app reuses the existing Firebase Google sign-in and asks for one extra
scope at sign-in time.

**Free tier (no card):** 15 GB storage, shared with the Google account's
other Google services (Gmail, Photos, Drive).

## The scope — read this first

The sign-in requests exactly one Drive scope:

```
https://www.googleapis.com/auth/drive.file
```

This scope lets SaveBox access **only the files it creates** — the
`SaveBox` folder and the files uploaded into it. SaveBox **cannot see,
open, or list any other file in the user's Drive**. The app says exactly
this on the Cloud Sync screen ("SaveBox can only access the files it
creates in your Drive") and never claims full-Drive access.

## The folder

- On first connect the app searches the Drive root for a folder named
  exactly `SaveBox` (`name='SaveBox'`, folder mimeType, not trashed).
  If it is not there, the app creates it. Every Drive upload goes into
  that folder; the app never uploads anywhere else in the account.
- `storagePath` for Drive files is `drive:<fileId>` (the Drive file ID
  of the uploaded file). The ID is stored in the item metadata, which
  syncs via Firestore like everything else.

## How to connect (in the app)

1. Open SaveBox → Settings → Cloud Sync → **Google Drive (15 GB free)**
   → tap **Link Google Drive**.
2. Pick the Google account in the Google sign-in popup (or finish the
   redirect sign-in if the popup is blocked — the app picks the token
   up when you come back).
3. Google asks to allow SaveBox to "see, edit, create, and delete only
   the specific Google Drive files you use with this app" — that is the
   `drive.file` scope. Allow it.
4. The screen shows **Connected** + the Google account email + live
   quota (used of 15 GB) + a **Disconnect Drive** button.

## How it works

- **Client:** `final-deploy/js/drive.js` (`window.SaveBoxDrive`) —
  `connect` (sign-in + scope + verify via `about.get`), `disconnect`
  (revoke + clear session), `upload` (multipart upload with real
  progress via XHR, into the SaveBox folder), `download`
  (`files.get?alt=media`), `remove` (`files.delete`), `quota`
  (`about.get` → `storageQuota`, cached ~60 s, total falls back to
  15 GB). The sign-in itself is `signInWithGoogleDrive()` in
  `final-deploy/js/firebase.js` (Google provider + `drive.file` scope,
  popup first, redirect fallback).
- **Token storage:** the OAuth access token is short-lived (~1 hour).
  It lives **in memory + sessionStorage only** (`savebox.drive.session.v1`)
  — never in Firestore, localStorage, or IndexedDB, and never sent
  anywhere except `googleapis.com`. Closing the tab ends the session;
  reopening the app in the same tab session restores it.
- **Token expiry:** on a 401 from Drive the client marks Drive
  disconnected and the app shows "Drive session expired — reconnect
  Drive". It never silently re-prompts in a loop — reconnect from
  Settings → Cloud Sync.
- **Disconnect:** revokes the token at `https://oauth2.googleapis.com/revoke`
  (best-effort), clears the session, and returns the UI to the
  not-connected state. It does **not** delete the user's files from
  Drive — they stay there and still open from the app while Drive is
  connected again later.

## Automatic overflow (v1.5.0)

Drive is one of two cloud stores — the other is MEGA (20 GB free, see
MEGA_SETUP.md). How new uploads choose a store:

- New uploads go to the **most recently connected** storage. Connect
  Drive after MEGA and new files go to Drive; connect MEGA after Drive
  and new files go to MEGA.
- When that storage is **full** (cached free space < file size), the
  upload automatically goes to the next linked storage with space.
  Quota checks are cached ~60 s.
- If **no** linked storage fits, the upload fails honestly — "All
  linked storages are full — connect another storage or free space" —
  and the file stays on this device. Nothing is ever faked as uploaded.
- Every file records its store in `storagePath` (`mega:<nodeHandle>` /
  `drive:<fileId>`), so downloads and deletes always resolve to the
  right cloud regardless of which storage is the current default.

## Current status (24 Nov 2026)

- ✅ App code ready (v1.5.0): `js/drive.js` client, `drive.file` scope
  in `js/firebase.js`, wiring in `app.js` (provider chain, upload on
  save/sync, download fallback, delete, Cloud Sync Drive section +
  status, Storage "Cloud files (Drive)" card, About text).
- ✅ Verified: jsdom smoke 81/81 (see below) with a mock Drive backend
  (fetch + XHR stubs) and a mock MEGA backend.
- ⏳ **Needs one real login:** the user links Drive once in the app on
  his phone (Settings → Cloud Sync → Link Google Drive). A real
  end-to-end Drive upload is NOT proven until that live pass runs
  (parent). MEGA and Drive are both policy-blocked in the cloud
  browser, so no real login can be tested from here.

## Limits (honest)

- The Drive token lasts about 1 hour. After it expires, Drive shows as
  disconnected until reconnected. Files already in Drive are unaffected.
- The `drive.file` scope means SaveBox can only touch files it created.
  If the user deletes the SaveBox folder in Drive itself, the app
  recreates it on the next connect — files deleted that way are gone
  from Drive (the app's on-device copy, if any, is unaffected).
- Drive quota is per Google account (15 GB free, shared with Gmail /
  Photos / Drive). Files count against that shared quota.
- No refresh token is stored — reconnecting is a deliberate tap, not a
  silent background refresh. This is by design (no long-lived
  credentials on the device).

## Verification (24 Nov 2026)

jsdom smoke `/tmp/sb15/smoke.js` — **81/81 pass, 0 window errors**
(mock Drive backend: `window.fetch` for about/list/create/download/
delete/revoke + a MockXHR for the multipart upload; the Firebase
Google sign-in is patched to a fake `{accessToken, user}` — no real
Google sign-in is attempted):

- App boots, register opens the app, Cloud Sync shows the Drive section
  with the Link button + the "only files it creates" scope note, and no
  Firebase/R2/"Local items"/"device-local" text anywhere on the screen.
- Drive connect: Connected + `drive-user@gmail.com` + Disconnect,
  SaveBox folder created in the mock Drive root, chain `["drive"]`,
  live quota line (used of 15 GB), `quota()` returns 15 GB total.
- Overflow: MEGA full + Drive with space → UI upload lands on Drive
  (`drive:` path); both full → honest "All linked storages are full"
  toast, no cloud upload; disconnect Drive → chain `["mega"]`, upload
  goes MEGA; reconnect Drive → chain `["drive","mega"]`, upload goes
  Drive; disconnect revokes the token and does not delete Drive files.
- Drive download returns the uploaded bytes; remove returns true and
  the file is gone from the mock; `quota()` rejects cleanly when not
  connected.
- MEGA still works end to end (upload/download round-trip, 2FA flow,
  session restore) and the Storage view shows MEGA + Drive cards with
  live quota lines and no R2 card.
