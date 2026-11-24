/* SaveBox MEGA client (v1.4.1) — talks directly to MEGA's own API via megajs.
 *
 * SECURITY — read this before touching this file:
 * - The user's MEGA email/password are typed into the app's own
 *   Settings → Cloud Sync form and passed straight to `new mega.Storage()`,
 *   which sends them only to MEGA (g.api.mega.co.nz). They are NEVER sent
 *   to Firebase, Cloudflare, or any other server, and NEVER stored in
 *   plaintext anywhere — not in Firestore, localStorage or IndexedDB.
 *   megajs itself deletes `options.password` from memory after login.
 * - This file never logs the password, never puts it in an error message,
 *   and never writes it to any storage. The login form field is cleared
 *   by the caller (app.js) after every attempt, success or failure.
 * - Session persistence is opt-in ("Keep me signed in on this device").
 *   It uses megajs' documented session mechanism: `storage.toJSON()` /
 *   `Storage.fromJSON()` (see megajs 1.3.10 types). Only the session
 *   fields are kept — key, sid, name, user, email — and `options` is
 *   stored EMPTY, so no password can ever be in the stored session.
 *   Default (checkbox off) is session-only: the user logs in again each
 *   time the app starts, and the UI says so honestly.
 * - Every call rejects (never resolves with fake data) when MEGA is not
 *   connected or the operation fails. Callers must fail soft and keep
 *   files device-local — exactly like the R2 client.
 *
 * FOLDER: on first connect, a folder named "SaveBox" is found (or created)
 * under the user's Cloud drive root and used for every upload. Uploads
 * never go anywhere else in the account. storagePath format for cloud
 * files: "mega:<nodeHandle>".
 *
 * MEGA files are end-to-end encrypted by MEGA. This client does not add
 * its own encryption and does not claim otherwise.
 */
(function () {
  'use strict';

  var SESSION_KEY = 'savebox.mega.session.v1';
  var FOLDER_NAME = (window.SAVEBOX_MEGA_FOLDER_NAME || 'SaveBox');
  var ROOT_HANDLE = (window.SAVEBOX_MEGA_ROOT_HANDLE || '');
  var MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file, same as the app limit
  var LOGIN_TIMEOUT_MS = 90000;

  var MegaLib = null;       // window.mega (megajs UMD bundle)
  var storage = null;       // megajs Storage while connected
  var saveBoxFolder = null; // MutableFile for the "SaveBox" folder under root
  var accountEmail = '';    // MEGA account email while connected
  var isConnected = false;
  var loginPromise = null;  // in-flight login (dedupes double clicks)
  var quotaCache = null, quotaAt = 0;

  function lib() {
    if (MegaLib) return MegaLib;
    var m = null;
    try { m = window.mega || null; } catch (e) { /* ignore */ }
    if (m && m.Storage) MegaLib = m;
    return MegaLib;
  }

  /* True when the megajs library loaded (not the same as logged in). */
  function ready() {
    return Boolean(lib());
  }

  /* True when a MEGA session is live right now. */
  function connected() {
    return isConnected && !!storage;
  }

  function getAccountEmail() {
    return accountEmail;
  }

  function normaliseErr(e) {
    var msg = (e && e.message) ? String(e.message) : '';
    var low = msg.toLowerCase();
    if (low.indexOf('password') >= 0 || low.indexOf('wrong') >= 0 || low.indexOf('enoent') >= 0 || msg === '-9' || msg === '-11') {
      return new Error('Wrong MEGA email or password — check them and try again.');
    }
    if (low.indexOf('two factor') >= 0 || low.indexOf('2fa') >= 0 || low.indexOf('mfa') >= 0 || low.indexOf('second factor') >= 0) {
      return new Error('This MEGA account has two-factor authentication on — enter the code in the “Two-factor code” box and try again.');
    }
    if (low.indexOf('fetch') >= 0 || low.indexOf('network') >= 0 || low.indexOf('failed to') >= 0 || low.indexOf('timeout') >= 0 || low.indexOf('timed out') >= 0 || low.indexOf('econn') >= 0) {
      return new Error('Could not reach MEGA — check your internet connection and try again.');
    }
    if (low.indexOf('quota') >= 0 || low.indexOf('overquota') >= 0 || msg === '-17' || msg === '-18') {
      return new Error('MEGA storage or transfer quota is full — free some space in MEGA or wait for the quota to reset.');
    }
    if (!msg) return new Error('MEGA error — please try again.');
    return new Error(msg);
  }

  function clearStoredSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode */ }
  }

  function persistSession(st) {
    // Store ONLY the session fields. `toJSON().options` would carry the
    // login options, so it is deliberately dropped and stored empty —
    // the stored session can never contain the password.
    try {
      var j = st.toJSON();
      var sess = {
        key: j.key, sid: j.sid,
        name: j.name || '', user: j.user || '',
        email: (st.email || accountEmail || ''),
        options: {}
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch (e) { /* storage unavailable — session stays memory-only */ }
  }

  /* Find the "SaveBox" folder under the Cloud drive root, or create it.
   * The root handle from the user's link (E3AFmJ6D) is the Cloud drive
   * root itself; `storage.root` is that folder, cross-checked against
   * `storage.files[ROOT_HANDLE]` when it is present. */
  function ensureSaveBoxFolder(st) {
    return new Promise(function (resolve, reject) {
      var base = st.root || null;
      if (ROOT_HANDLE && st.files && st.files[ROOT_HANDLE] && st.files[ROOT_HANDLE].directory) {
        base = st.files[ROOT_HANDLE];
      }
      if (!base) return reject(new Error('MEGA Cloud drive did not load — try again.'));
      var kids = base.children || [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].directory && kids[i].name === FOLDER_NAME) return resolve(kids[i]);
      }
      var p = null;
      try { p = base.mkdir(FOLDER_NAME); } catch (e) { return reject(normaliseErr(e)); }
      Promise.resolve(p).then(resolve, function (e) { reject(normaliseErr(e)); });
    });
  }

  function finishConnect(st, folder, remember) {
    storage = st;
    saveBoxFolder = folder;
    accountEmail = (st.email || accountEmail || '');
    isConnected = true;
    quotaCache = null; quotaAt = 0;
    if (remember) persistSession(st); else clearStoredSession();
    return { email: accountEmail, folder: FOLDER_NAME };
  }

  /* Log in with the user's MEGA email/password. Credentials go only to
   * MEGA. Resolves {email, folder}. Rejects with a friendly error. */
  function login(email, password, remember, secondFactorCode) {
    if (loginPromise) return loginPromise;
    email = String(email || '').trim().toLowerCase();
    if (!email || !password) return Promise.reject(new Error('Enter your MEGA email and password.'));
    var M = lib();
    if (!M) return Promise.reject(new Error('MEGA library failed to load — reload the app and try again.'));
    if (isConnected) logout(); // switching accounts: drop the old session first
    accountEmail = email;
    loginPromise = new Promise(function (resolve, reject) {
      var settled = false;
      var st = null;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { if (st) st.close(); } catch (e) { /* ignore */ }
        loginPromise = null;
        reject(new Error('MEGA took too long to respond — check your connection and try again.'));
      }, LOGIN_TIMEOUT_MS);
      var done = function (fn, arg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        loginPromise = null;
        fn(arg);
      };
      try {
        var opts = { email: email, password: password, autoload: true, autologin: true };
        if (secondFactorCode) opts.secondFactorCode = String(secondFactorCode).trim();
        st = new M.Storage(opts);
      } catch (e) {
        done(reject, normaliseErr(e));
        return;
      }
      st.ready.then(function () {
        ensureSaveBoxFolder(st).then(function (folder) {
          done(resolve, finishConnect(st, folder, !!remember));
        }).catch(function (e) {
          try { st.close(); } catch (err) { /* ignore */ }
          done(reject, normaliseErr(e));
        });
      }).catch(function (e) {
        done(reject, normaliseErr(e));
      });
    });
    return loginPromise;
  }

  /* Restore a remembered session (only when the user ticked "Keep me
   * signed in"). Returns true when the session is live again, false
   * otherwise (expired session, bad network, bad data) — never throws. */
  function restoreSession() {
    var raw = null;
    try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return Promise.resolve(false); }
    if (!raw) return Promise.resolve(false);
    var sess = null;
    try { sess = JSON.parse(raw); } catch (e) { clearStoredSession(); return Promise.resolve(false); }
    if (!sess || !sess.key || !sess.sid) { clearStoredSession(); return Promise.resolve(false); }
    var M = lib();
    if (!M) return Promise.resolve(false);
    var st = null;
    try {
      st = M.Storage.fromJSON({
        key: sess.key, sid: sess.sid,
        name: sess.name || '', user: sess.user || '',
        options: {}
      });
    } catch (e) {
      clearStoredSession();
      return Promise.resolve(false);
    }
    accountEmail = sess.email || '';
    return st.reload(true).then(function () {
      return ensureSaveBoxFolder(st);
    }).then(function (folder) {
      finishConnect(st, folder, true);
      return true;
    }).catch(function () {
      clearStoredSession();
      try { st.close(); } catch (e) { /* ignore */ }
      return false;
    });
  }

  /* Log out of MEGA (server session closed) and forget any remembered
   * session on this device. Files already in MEGA stay there. */
  function logout() {
    clearStoredSession();
    quotaCache = null; quotaAt = 0;
    var st = storage;
    storage = null; saveBoxFolder = null; accountEmail = ''; isConnected = false;
    if (st) {
      try {
        var p = st.close();
        if (p && p.catch) p.catch(function () { /* already closed */ });
      } catch (e) { /* ignore */ }
    }
  }

  /* Upload with real progress: the blob is written to megajs in 256 KB
   * chunks and onProgress(fraction) reports the bytes actually fed to
   * the uploader. Resolves {path: "mega:<nodeHandle>", size, name}. */
  function upload(itemId, blob, filename, onProgress) {
    if (!connected() || !saveBoxFolder) return Promise.reject(new Error('MEGA is not connected'));
    if (!blob || !blob.size) return Promise.reject(new Error('Empty file — nothing to upload.'));
    if (blob.size > MAX_FILE_BYTES) return Promise.reject(new Error('File is over 50 MB.'));
    var name = filename || itemId;
    // Chunks MUST be real Buffer instances: megajs' browser upload
    // streams reject plain Uint8Array ("chunk must be string or Buffer").
    // window.Buffer comes from js/buffer-vendor.js (buffer@6.0.3).
    var Buf = null;
    try { Buf = window.Buffer || null; } catch (e) { /* ignore */ }
    if (!Buf || typeof Buf.from !== 'function') {
      return Promise.reject(new Error('MEGA upload library did not load — reload the app and try again.'));
    }
    return blob.arrayBuffer().then(function (ab) {
      var bytes = new Uint8Array(ab);
      var stream = null;
      try {
        stream = saveBoxFolder.upload({ name: name, size: bytes.length });
      } catch (e) {
        return Promise.reject(normaliseErr(e));
      }
      return new Promise(function (resolve, reject) {
        var done = false;
        var finish = function (fn, arg) { if (done) return; done = true; fn(arg); };
        stream.on('error', function (e) { finish(reject, normaliseErr(e)); });
        stream.complete.then(function (file) {
          finish(resolve, { path: 'mega:' + file.nodeId, size: bytes.length, name: file.name });
        }).catch(function (e) { finish(reject, normaliseErr(e)); });
        var CHUNK = 256 * 1024, off = 0, stopped = false;
        var writeNext = function () {
          if (stopped || done) return;
          while (off < bytes.length) {
            var end = Math.min(bytes.length, off + CHUNK);
            var chunk = Buf.from(bytes.subarray(off, end));
            off = end;
            var ok;
            try { ok = stream.write(chunk); } catch (e) { stopped = true; finish(reject, normaliseErr(e)); return; }
            if (typeof onProgress === 'function') {
              try { onProgress(off / bytes.length); } catch (e) { /* ignore */ }
            }
            if (!ok) { stream.once('drain', writeNext); return; }
          }
          try { stream.end(); } catch (e) { finish(reject, normaliseErr(e)); }
        };
        writeNext();
      });
    });
  }

  /* Download a file blob by its MEGA node handle. Rejects on 404/auth/
   * network errors — callers fall back to device-local or show an error. */
  function download(nodeHandle) {
    if (!connected() || !storage) return Promise.reject(new Error('MEGA is not connected'));
    var node = storage.files ? storage.files[nodeHandle] : null;
    if (!node) return Promise.reject(new Error('File not found in MEGA'));
    return node.downloadBuffer().then(function (buf) {
      var arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      return new Blob([arr], { type: 'application/octet-stream' });
    }).catch(function (e) { throw normaliseErr(e); });
  }

  /* Permanently delete a file node. Resolves true on success, false
   * otherwise (including "already gone"). */
  function remove(nodeHandle) {
    if (!connected() || !storage) return Promise.resolve(false);
    var node = storage.files ? storage.files[nodeHandle] : null;
    if (!node) return Promise.resolve(true);
    return node.delete(true).then(function () { return true; }).catch(function () { return false; });
  }

  /* Live quota from MEGA's account API (cached 60 s). Resolves
   * {used, total, downloadUsed, downloadTotal} in bytes. */
  function quota() {
    if (!connected() || !storage) return Promise.reject(new Error('MEGA is not connected'));
    if (quotaCache && Date.now() - quotaAt < 60000) return Promise.resolve(quotaCache);
    return storage.getAccountInfo().then(function (a) {
      quotaCache = {
        used: a.spaceUsed || 0,
        total: a.spaceTotal || (window.SAVEBOX_MEGA_QUOTA_BYTES || 21474836480),
        downloadUsed: a.downloadBandwidthUsed || 0,
        downloadTotal: a.downloadBandwidthTotal || 0
      };
      quotaAt = Date.now();
      return quotaCache;
    }).catch(function (e) { throw normaliseErr(e); });
  }

  window.SaveBoxMega = {
    ready: ready,
    connected: connected,
    accountEmail: getAccountEmail,
    login: login,
    restoreSession: restoreSession,
    logout: logout,
    upload: upload,
    download: download,
    remove: remove,
    quota: quota,
    folderName: function () { return FOLDER_NAME; }
  };
})();
