# SaveBox R2 Setup — Cloudflare R2 as the cloud file store

Files uploaded in SaveBox go to a **private** Cloudflare R2 bucket through
the `savebox-r2` Worker. The Worker verifies the user's Firebase ID token
on every request, so a user can only touch their own `<uid>/<itemId>`
objects. The bucket is never public.

**Free tier (no card):** 10 GB storage, 1M Class A (write) ops/month,
10M Class B (read) ops/month, unlimited free egress. Past 10 GB, uploads
fail with a clear error — nothing is silently lost.

## Current status (23 Nov 2026)

- ✅ Worker code ready: `worker/worker.js` + `worker/wrangler.toml`
  (binding `SAVEBOX_R2` → bucket `savebox-files`).
- ✅ App code ready + deployed (v1.3.0): `js/r2.js` client,
  `js/r2-config.js` (URL injection point), R2 wiring in `app.js`
  (upload on save/sync, download fallback, delete, Cloud Sync status
  line, Storage "Cloud files (R2)" card, About text).
- ✅ Worker logic verified locally: 12/12 harness checks (health, 401
  without/bad token, 403 on uid mismatch, upload/download/delete round
  trip, CORS allowlist, evil origin gets no CORS headers).
- ✅ App verified: jsdom smoke 22/22, zero window errors.
- ❌ **BLOCKED — R2 is not enabled on the Cloudflare account.**
  The API returns HTTP 403, error 10042: "Please enable R2 through the
  Cloudflare Dashboard." There is no API to enable R2; it is a dashboard
  action. No payment was requested and none was entered.
- ❌ Bucket `savebox-files` does not exist yet (consequence of the above).
  `wrangler deploy` fails with: "R2 bucket 'savebox-files' not found
  [code: 10085]".

## Steps to finish (in order)

### 1. Enable R2 in the Cloudflare dashboard (browser)

1. Open https://dash.cloudflare.com/ and sign in (saved Cloudflare login).
2. Left sidebar → **R2 Object Storage** (under Storage & Databases).
3. Click **Get Started** / **Purchase R2**. The free tier (10 GB) needs
   no credit card — if any screen asks for a card, STOP and ask the user
   first; do not enter payment details.

### 2. Create the bucket

1. In R2 → **Create bucket**.
2. Name: `savebox-files` (exact). Location: Automatic (default).
3. Leave everything else default. **Do NOT enable public access** and do
   not create a public `r2.dev` URL — the Worker is the only access path.

### 3. Deploy the Worker

From the SaveBox project (uses the same Cloudflare credential as
`deploy_pages.py`):

```bash
cd ~/workspace/savebox/worker
CLOUDFLARE_API_TOKEN='<surrogate from dynamic_credential_entry("custom.cloudflare")>' \
CLOUDFLARE_ACCOUNT_ID='617e5ccdaae4cb0e07706e4e3a012801' \
npx --yes wrangler@4.160.0 deploy
```

Or run the deploy from a script that loads the surrogate the same way
`deploy_pages.py` does. On success wrangler prints the Worker URL, e.g.
`https://savebox-r2.<subdomain>.workers.dev`. Record the exact URL.

### 4. Point the app at the Worker

1. Paste the URL into `~/workspace/savebox/final-deploy/js/r2-config.js`:
   `window.SAVEBOX_R2_URL = 'https://savebox-r2.<subdomain>.workers.dev';`
2. Re-deploy Pages: `python3 ~/workspace/savebox/deploy_pages.py`.
3. Verify:
   - `curl https://<worker-url>/health` → `{"ok":true,"service":"savebox-r2"}`
   - `curl -X POST https://<worker-url>/upload` (no token) → `401`
   - App: Settings → Cloud Sync shows "Cloud files (R2): Connected ✓";
     Settings → Storage shows the "Cloud files (R2)" card with 0 files.
4. Live-browser pass (parent): sign in with Google, upload a file, reload
   the app, open/preview the file (must load from R2, not just IndexedDB),
   delete it, confirm it is gone.

## How it works

| Piece | What it does |
|---|---|
| `worker/worker.js` | `GET /health`; `POST /upload` (multipart: file + itemId + uid); `GET /file/<uid>/<itemId>`; `DELETE /file/<uid>/<itemId>`. Every file route verifies `Authorization: Bearer <Firebase ID token>` via IdentityToolkit `accounts:lookup` and requires the token uid to match the path uid. CORS allowlist: `savebox.pages.dev`, `localhost`, `capacitor://localhost` only. 50 MB max per file. |
| `js/r2.js` | `SaveBoxR2` client: `upload` (XHR, real progress), `download`, `remove`, `status` (health check). All calls reject when R2 is unconfigured or the user is not signed in — callers fail soft. |
| `js/r2-config.js` | Single injection point: `window.SAVEBOX_R2_URL` (empty = R2 off). `window.R2_ENABLED` derives from it. |
| `app.js` | `uploadBlobToCloud` (used by save + Sync Now), `resolveFileBlob` (local blob first, then R2 for `r2:` paths), `deleteCloudFile` (hard delete + empty trash), Cloud Sync R2 status line, Storage R2 card with 10 GB quota bar, About text. `storagePath` for cloud files is `r2:<uid>/<itemId>`. |

## Checking usage

Cloudflare dashboard → R2 → `savebox-files` → Metrics: stored bytes,
Class A/B operations. Free limits reset monthly. If usage approaches
10 GB, the app's Storage view shows it; uploads past the limit return a
clear error from the Worker.

## If R2 asks for payment

STOP. Do not enter a card. The free tier is documented as card-free;
if the dashboard demands payment, report the exact screen to the user
and wait for their decision.
