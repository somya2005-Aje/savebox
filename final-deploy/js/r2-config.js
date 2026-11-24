/* SaveBox — Cloudflare R2 Worker configuration (v1.3.0)
 *
 * HOW TO CONNECT R2 CLOUD FILES:
 * 1. In the Cloudflare dashboard, enable R2 and create the bucket
 *    `savebox-files` (free tier: 10 GB, no card). See R2_SETUP.md.
 * 2. Deploy the Worker: cd ~/workspace/savebox/worker && npx wrangler deploy
 *    (uses the same Cloudflare credential as deploy_pages.py).
 * 3. Paste the Worker URL below, e.g.
 *    "https://savebox-r2.<your-subdomain>.workers.dev", then re-deploy Pages.
 *
 * While this is empty, the app runs exactly as before: files stay on the
 * device (IndexedDB) and only folders/links/notes sync via Firestore.
 * Nothing breaks and no error is shown beyond an honest "Not connected"
 * status in Settings -> Cloud Sync.
 */
window.SAVEBOX_R2_URL = '';

/* R2 free-tier quota: 10 GB storage per month. */
window.SAVEBOX_R2_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

/* True when a Worker URL has been pasted in. */
window.R2_ENABLED = Boolean(window.SAVEBOX_R2_URL);
