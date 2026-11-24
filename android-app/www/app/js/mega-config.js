/* SaveBox — MEGA.nz cloud files configuration (v1.4.1)
 *
 * MEGA is the active cloud file store. The user's MEGA Cloud drive root
 * has handle E3AFmJ6D (from the link https://mega.nz/fm/E3AFmJ6D — the
 * user confirmed on 24 Nov 2026 that it opens his Cloud drive root and
 * that the drive is EMPTY, so there are no existing files to preserve).
 *
 * On first MEGA connect the app creates a folder named "SaveBox" under
 * the Cloud drive root and uses it for every upload. If a "SaveBox"
 * folder already exists at root, it is used instead — nothing is ever
 * uploaded outside the user's own MEGA account.
 *
 * MEGA free tier: 20 GB storage, no card. Files are end-to-end encrypted
 * by MEGA. Free accounts have a limited download/transfer quota.
 *
 * Login happens IN THE APP, directly against MEGA's own API (megajs) —
 * the user's MEGA email/password are entered in Settings → Cloud Sync,
 * go only to mega.nz, and are NEVER stored in plaintext anywhere (not in
 * Firestore, localStorage or IndexedDB). See MEGA_SETUP.md.
 */
window.SAVEBOX_MEGA_ROOT_HANDLE = 'E3AFmJ6D';

/* Folder created (or re-used) under the Cloud drive root on first connect. */
window.SAVEBOX_MEGA_FOLDER_NAME = 'SaveBox';

/* MEGA free-tier quota: 20 GB storage. */
window.SAVEBOX_MEGA_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;

/* True when the MEGA client is part of the app (it always is from v1.4.0). */
window.MEGA_ENABLED = true;
