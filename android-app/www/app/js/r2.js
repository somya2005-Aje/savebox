/* SaveBox R2 client (v1.3.0) — talks to the savebox-r2 Worker only.
 * The Worker verifies a Firebase ID token on every file route, so a user
 * can only ever upload/download/delete their own files (<uid>/<itemId>).
 * Every call rejects (never resolves with fake data) when R2 is not
 * configured, the user is not signed in with Firebase, or the Worker
 * returns an error. Callers must fail soft and keep files device-local.
 */
(function () {
  'use strict';

  function baseUrl() {
    var u = (window.SAVEBOX_R2_URL || '').replace(/\/+$/, '');
    return u || null;
  }

  function ready() {
    return Boolean(baseUrl());
  }

  function getToken() {
    var FBx = window.SaveBoxFirebase;
    if (!FBx || !FBx.ready) return Promise.reject(new Error('firebase not ready'));
    var cu = FBx.currentUser ? FBx.currentUser() : null;
    if (!cu || !cu.getIdToken) return Promise.reject(new Error('not signed in'));
    return cu.getIdToken(false);
  }

  function authedFetch(path, opts) {
    var url = baseUrl();
    if (!url) return Promise.reject(new Error('r2 not configured'));
    return getToken().then(function (token) {
      var headers = Object.assign({}, (opts && opts.headers) || {}, {
        Authorization: 'Bearer ' + token,
      });
      var o = Object.assign({}, opts, { headers: headers });
      return fetch(url + path, o);
    });
  }

  /* Upload with real XHR progress events. Resolves {path, size}. */
  function upload(uid, itemId, blob, filename, onProgress) {
    var url = baseUrl();
    if (!url) return Promise.reject(new Error('r2 not configured'));
    return getToken().then(function (token) {
      return new Promise(function (resolve, reject) {
        var fd = new FormData();
        fd.append('uid', uid);
        fd.append('itemId', itemId);
        fd.append('file', blob, filename || itemId);
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url + '/upload');
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.timeout = 120000;
        if (xhr.upload && typeof onProgress === 'function') {
          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
          };
        }
        xhr.onload = function () {
          var data = null;
          try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* ignore */ }
          if (xhr.status >= 200 && xhr.status < 300 && data && data.path) resolve(data);
          else reject(new Error((data && data.error) || ('upload failed: ' + xhr.status)));
        };
        xhr.onerror = function () { reject(new Error('network error')); };
        xhr.ontimeout = function () { reject(new Error('upload timed out')); };
        xhr.send(fd);
      });
    });
  }

  /* Download a file blob. Rejects on 404/auth/network errors. */
  function download(uid, itemId) {
    return authedFetch('/file/' + encodeURIComponent(uid) + '/' + encodeURIComponent(itemId))
      .then(function (res) {
        if (!res.ok) throw new Error('download failed: ' + res.status);
        return res.blob();
      });
  }

  /* Delete a file object. Resolves true on success, false otherwise. */
  function remove(uid, itemId) {
    return authedFetch('/file/' + encodeURIComponent(uid) + '/' + encodeURIComponent(itemId), { method: 'DELETE' })
      .then(function (res) { return res.ok; })
      .catch(function () { return false; });
  }

  /* Liveness check for the Cloud Sync status line. Resolves true/false. */
  function status() {
    var url = baseUrl();
    if (!url) return Promise.resolve(false);
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 4000);
    return fetch(url + '/health', { signal: ctrl.signal })
      .then(function (res) { clearTimeout(t); return res.ok; })
      .catch(function () { clearTimeout(t); return false; });
  }

  window.SaveBoxR2 = {
    ready: ready,
    upload: upload,
    download: download,
    remove: remove,
    status: status,
  };
})();
