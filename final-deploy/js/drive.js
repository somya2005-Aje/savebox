/* REMOVED FROM THE APP per user order 2026-11-24 (v1.5.1): Google Drive
 * was removed — MEGA is the only cloud storage now. This file is NOT
 * loaded by index.html anymore and is kept on disk for reference only. */
/* SaveBox Google Drive client (v1.5.0) — talks directly to Google's
 * Drive REST API (v3) from the app. No new OAuth client ID, no new keys:
 * the user signs in with Google through Firebase Auth (js/firebase.js)
 * with the drive.file scope added, and the OAuth access token from that
 * sign-in is used for Drive calls.
 *
 * SECURITY — read this before touching this file:
 * - The drive.file scope lets the app access ONLY files it creates in
 *   the user's Drive. It cannot see, list or change any other Drive
 *   file. The UI says exactly that — never claim full-Drive access.
 * - The OAuth access token is short-lived (~1 hour). It is kept in
 *   MEMORY and in sessionStorage only — never in Firestore, localStorage
 *   or IndexedDB, and never sent anywhere except googleapis.com.
 * - On a 401 from Drive the token is dead: this client marks Drive
 *   disconnected and rejects with "Drive session expired — reconnect
 *   Drive". Callers must show the reconnect state — never silently
 *   re-prompt in a loop, and never fake a success.
 * - Disconnect (logout) revokes the token at Google (best-effort) and
 *   forgets it on this device. Files already in Drive stay there.
 * - Every call rejects (never resolves with fake data) when Drive is
 *   not connected or the operation fails. Callers must fail soft and
 *   keep files on the device — exactly like the MEGA client.
 *
 * FOLDER: on first connect, a folder named "SaveBox" is found (or
 * created) in the Drive root and used for every upload. Uploads never
 * go anywhere else in the account. storagePath format for cloud files:
 * "drive:<fileId>".
 */
(function () {
  'use strict';

  var SESSION_KEY = 'savebox.drive.session.v1';
  var FOLDER_NAME = 'SaveBox';
  var DRIVE_QUOTA_BYTES = 15 * 1024 * 1024 * 1024; // 15 GB free tier
  var MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file, same as the app limit

  var token = null;          // OAuth access token (memory only)
  var saveBoxFolderId = null;
  var accountEmail = '';
  var isConnected = false;
  var quotaCache = null, quotaAt = 0;
  var connectPromise = null; // in-flight connect (dedupes double clicks)

  function FBx() { try { return window.SaveBoxFirebase || null; } catch (e) { return null; } }

  /* True when the Drive client code is loaded (not the same as logged in). */
  function ready() { return true; }

  /* True when a Drive session is live right now. */
  function connected() { return isConnected && !!token; }

  function getAccountEmail() { return accountEmail; }

  function clearStoredSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode */ }
  }

  function persistSession() {
    // Token + email only. The token is short-lived (~1 hour); if it has
    // expired by the next visit, restoreSession() fails honestly and the
    // user reconnects — nothing is faked.
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: token, email: accountEmail })); } catch (e) { /* unavailable */ }
  }

  /* Drop the session everywhere. Called on 401s and on disconnect. */
  function markDisconnected() {
    token = null; saveBoxFolderId = null; accountEmail = ''; isConnected = false;
    quotaCache = null; quotaAt = 0;
    clearStoredSession();
  }

  function expiredErr() {
    return new Error('Drive session expired — reconnect Drive in Settings → Cloud Sync.');
  }

  /* One Drive API call. Adds the Bearer token; a 401 means the token is
   * dead, so the session is dropped and the caller sees the expired error. */
  function api(path, opts) {
    opts = opts || {};
    if (!token) return Promise.reject(new Error('Google Drive is not connected'));
    var headers = { 'Authorization': 'Bearer ' + token };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    return fetch('https://www.googleapis.com' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body || undefined
    }).then(function (r) {
      if (r.status === 401) { markDisconnected(); throw expiredErr(); }
      if (!r.ok) {
        return r.text().then(function (t) {
          var msg = 'Google Drive error (' + r.status + ')';
          try { var j = JSON.parse(t); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) { /* keep default */ }
          throw new Error(msg);
        });
      }
      if (r.status === 204 || opts.noBody) return null;
      return r.json();
    });
  }

  /* Find the "SaveBox" folder in the Drive root, or create it. */
  function ensureSaveBoxFolder() {
    var q = "name='" + FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    return api('/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name)&spaces=drive').then(function (res) {
      var files = (res && res.files) || [];
      if (files.length) return files[0].id;
      return api('/drive/v3/files', {
        method: 'POST', contentType: 'application/json',
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
      }).then(function (f) { return f.id; });
    });
  }

  function finishConnect(tok, email) {
    token = tok;
    accountEmail = email || '';
    return api('/drive/v3/about?fields=user,storageQuota').then(function (about) {
      if (about && about.user && about.user.emailAddress) accountEmail = about.user.emailAddress;
      return ensureSaveBoxFolder();
    }).then(function (folderId) {
      saveBoxFolderId = folderId;
      isConnected = true;
      quotaCache = null; quotaAt = 0;
      persistSession();
      return { email: accountEmail, folder: FOLDER_NAME };
    });
  }

  /* Connect: Google sign-in with the drive.file scope, then verify the
   * token against Drive and find/create the SaveBox folder. Resolves
   * {email, folder} or {redirected:true} when the sign-in opened a
   * redirect (the token is picked up on return — see connectWithToken). */
  function connect() {
    if (connectPromise) return connectPromise;
    var fb = FBx();
    if (!fb || !fb.signInWithGoogleDrive) return Promise.reject(new Error('Google Sign-In is not available — reload the app and try again.'));
    if (isConnected) disconnect();
    connectPromise = fb.signInWithGoogleDrive().then(function (res) {
      connectPromise = null;
      if (!res) throw new Error('Google Sign-In did not return anything — try again.');
      if (res.redirected) return { redirected: true };
      if (!res.accessToken) throw new Error('Google did not return a Drive access token — try again.');
      return finishConnect(res.accessToken, res.user ? res.user.email : '');
    }).catch(function (e) {
      connectPromise = null;
      throw e;
    });
    return connectPromise;
  }

  /* Finish a redirect-based sign-in with a token obtained from the
   * redirect result (firebase.js getRedirectDriveToken). */
  function connectWithToken(tok) {
    if (!tok) return Promise.reject(new Error('No Drive token.'));
    if (isConnected) disconnect();
    return finishConnect(tok, '');
  }

  /* Restore a session kept in sessionStorage (same tab session only).
   * Returns true when the session is live again, false otherwise —
   * never throws. An expired token fails the about.get call honestly. */
  function restoreSession() {
    var raw = null;
    try { raw = sessionStorage.getItem(SESSION_KEY); } catch (e) { return Promise.resolve(false); }
    if (!raw) return Promise.resolve(false);
    var sess = null;
    try { sess = JSON.parse(raw); } catch (e) { clearStoredSession(); return Promise.resolve(false); }
    if (!sess || !sess.token) { clearStoredSession(); return Promise.resolve(false); }
    token = sess.token;
    accountEmail = sess.email || '';
    return api('/drive/v3/about?fields=user,storageQuota').then(function (about) {
      if (about && about.user && about.user.emailAddress) accountEmail = about.user.emailAddress;
      return ensureSaveBoxFolder();
    }).then(function (folderId) {
      saveBoxFolderId = folderId;
      isConnected = true;
      quotaCache = null; quotaAt = 0;
      return true;
    }).catch(function () {
      markDisconnected();
      return false;
    });
  }

  /* Disconnect: revoke the token at Google (best-effort) and forget it
   * here. Files already in Drive stay there. */
  function disconnect() {
    var tok = token;
    markDisconnected();
    if (tok) {
      try {
        fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'token=' + encodeURIComponent(tok)
        }).catch(function () { /* revoke is best-effort */ });
      } catch (e) { /* ignore */ }
    }
  }

  /* Upload with real progress (XHR — fetch has no upload progress).
   * Multipart upload into the SaveBox folder. Resolves
   * {path: "drive:<fileId>", size, name}. */
  function upload(itemId, blob, filename, onProgress) {
    if (!connected() || !saveBoxFolderId) return Promise.reject(new Error('Google Drive is not connected'));
    if (!blob || !blob.size) return Promise.reject(new Error('Empty file — nothing to upload.'));
    if (blob.size > MAX_FILE_BYTES) return Promise.reject(new Error('File is over 50 MB.'));
    var name = filename || itemId;
    var boundary = '-------savebox' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var meta = { name: name, parents: [saveBoxFolderId] };
    var header = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + (blob.type || 'application/octet-stream') + '\r\n\r\n';
    var footer = '\r\n--' + boundary + '--';
    var body = new Blob([header, blob, footer], { type: 'multipart/related; boundary=' + boundary });
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function (fn, arg) { if (done) return; done = true; fn(arg); };
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + boundary);
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) { try { onProgress(e.loaded / e.total); } catch (err) { /* ignore */ } }
        };
      }
      xhr.onload = function () {
        if (xhr.status === 401) { markDisconnected(); finish(reject, expiredErr()); return; }
        if (xhr.status === 200 || xhr.status === 201) {
          try {
            var f = JSON.parse(xhr.responseText || '{}');
            if (f && f.id) { finish(resolve, { path: 'drive:' + f.id, size: blob.size, name: f.name || name }); return; }
          } catch (e) { /* fall through */ }
          finish(reject, new Error('Google Drive did not return a file id — try again.'));
          return;
        }
        var msg = 'Google Drive upload failed (' + xhr.status + ')';
        try { var j = JSON.parse(xhr.responseText || '{}'); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) { /* keep default */ }
        finish(reject, new Error(msg));
      };
      xhr.onerror = function () { finish(reject, new Error('Could not reach Google Drive — check your internet connection and try again.')); };
      xhr.ontimeout = function () { finish(reject, new Error('Google Drive took too long to respond — try again.')); };
      try { xhr.send(body); } catch (e) { finish(reject, new Error('Could not start the Google Drive upload — try again.')); }
    });
  }

  /* Download a file blob by its Drive file id. Rejects on 404/auth/
   * network errors — callers fall back to the device copy or show an error. */
  function download(fileId) {
    if (!connected()) return Promise.reject(new Error('Google Drive is not connected'));
    return fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) {
      if (r.status === 401) { markDisconnected(); throw expiredErr(); }
      if (r.status === 404) throw new Error('File not found in Drive');
      if (!r.ok) throw new Error('Google Drive download failed (' + r.status + ')');
      return r.blob();
    });
  }

  /* Permanently delete a file. Resolves true on success, false
   * otherwise (including "already gone"). */
  function remove(fileId) {
    if (!connected()) return Promise.resolve(false);
    return fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) {
      if (r.status === 401) { markDisconnected(); return false; }
      return r.ok || r.status === 404;
    }).catch(function () { return false; });
  }

  /* Live quota from Drive's about API (cached 60 s). Resolves
   * {used, total} in bytes. total falls back to the 15 GB free tier
   * when Drive reports no limit. */
  function quota() {
    if (!connected()) return Promise.reject(new Error('Google Drive is not connected'));
    if (quotaCache && Date.now() - quotaAt < 60000) return Promise.resolve(quotaCache);
    return api('/drive/v3/about?fields=storageQuota').then(function (about) {
      var sq = (about && about.storageQuota) || {};
      quotaCache = {
        used: Number(sq.usageInDrive || sq.usage || 0) || 0,
        total: Number(sq.limit || 0) || DRIVE_QUOTA_BYTES
      };
      quotaAt = Date.now();
      return quotaCache;
    });
  }

  window.SaveBoxDrive = {
    ready: ready,
    connected: connected,
    accountEmail: getAccountEmail,
    connect: connect,
    connectWithToken: connectWithToken,
    restoreSession: restoreSession,
    disconnect: disconnect,
    upload: upload,
    download: download,
    remove: remove,
    quota: quota,
    folderName: function () { return FOLDER_NAME; }
  };
})();
