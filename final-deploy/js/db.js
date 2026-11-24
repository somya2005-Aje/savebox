/* SaveBox — data layer (v1.2.0)
 * localStorage key "savebox_db_v1" holds users, session, folders, items,
 * settings, shares, activity and backups (metadata only).
 * File BYTES live in IndexedDB database "savebox-files", store "blobs",
 * keyed by item id. Files survive reloads via IndexedDB, never localStorage.
 */
(function () {
  'use strict';

  var DB_KEY = 'savebox_db_v1';
  var IDB_NAME = 'savebox-files';
  var IDB_STORE = 'blobs';
  var IDB_VERSION = 2; // v2 adds the "photos" store for profile pictures
  var PHOTO_STORE = 'photos';

  function uid() { return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function now() { return Date.now(); }

  function emptyDb() {
    return {
      users: [], session: { userId: null },
      folders: [], items: [],
      settings: { theme: 'light', pinHash: '', pinLength: 4, lockMode: 'pin', passwordLockHash: '', webauthnCredId: '', appLockEnabled: false, autoLock: 'background', privateFolderEnabled: false, gridDefault: 'grid', cloudChain: [] },
      shares: [], activity: [], backups: [], sessions: []
    };
  }

  function loadDb() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      if (!raw) return emptyDb();
      var db = JSON.parse(raw);
      if (!db || typeof db !== 'object') return emptyDb();
      ['users','folders','items','shares','activity','backups','sessions'].forEach(function (k) { if (!Array.isArray(db[k])) db[k] = []; });
      if (!db.session || typeof db.session !== 'object') db.session = { userId: null };
      if (!db.settings || typeof db.settings !== 'object') db.settings = emptyDb().settings;
      return db;
    } catch (e) { return emptyDb(); }
  }

  function saveDb(db) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* quota: metadata is small; ignore */ }
  }

  /* ---------- crypto ---------- */
  function sha256Hex(str) {
    var buf = new TextEncoder().encode(str);
    return crypto.subtle.digest('SHA-256', buf).then(function (hash) {
      return Array.prototype.map.call(new Uint8Array(hash), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  /* ---------- IndexedDB blobs ---------- */
  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
        if (!d.objectStoreNames.contains(PHOTO_STORE)) d.createObjectStore(PHOTO_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbTx(storeName, mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function blobPut(id, blob) {
    return idbTx(IDB_STORE, 'readwrite', function (s) { return s.put(blob, id); }).then(function () { return true; });
  }
  function blobGet(id) {
    return idbTx(IDB_STORE, 'readonly', function (s) { return s.get(id); });
  }
  function blobDelete(id) {
    return idbTx(IDB_STORE, 'readwrite', function (s) { return s.delete(id); }).then(function () { return true; });
  }

  /* ---------- profile photos (IndexedDB, keyed by user id) ---------- */
  function photoPut(userId, blob) {
    return idbTx(PHOTO_STORE, 'readwrite', function (s) { return s.put(blob, userId); }).then(function () { return true; });
  }
  function photoGet(userId) {
    return idbTx(PHOTO_STORE, 'readonly', function (s) { return s.get(userId); });
  }
  function photoDelete(userId) {
    return idbTx(PHOTO_STORE, 'readwrite', function (s) { return s.delete(userId); }).then(function () { return true; });
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
    return (bytes >= 100 ? Math.round(bytes) : bytes.toFixed(1)) + ' ' + units[i];
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' • ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDateShort(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase() || '?';
  }
  function extOf(name) {
    var m = String(name || '').match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }
  function typeOf(item) {
    if (item.kind === 'link') return 'link';
    if (item.kind === 'note') return 'note';
    var ext = extOf(item.fileName || item.title || '');
    if (['jpg','jpeg','png','gif','webp','svg','bmp'].indexOf(ext) >= 0) return 'image';
    if (['mp4','mov','webm','mkv','avi'].indexOf(ext) >= 0) return 'video';
    if (['mp3','wav','ogg','m4a','flac'].indexOf(ext) >= 0) return 'audio';
    if (ext === 'pdf') return 'pdf';
    if (['doc','docx','xls','xlsx','ppt','pptx','txt','csv','json','html','md'].indexOf(ext) >= 0) return 'doc';
    if (['zip','rar','7z'].indexOf(ext) >= 0) return 'archive';
    return 'file';
  }
  var TYPE_ICON = { link: '🔗', note: '📝', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', doc: '📄', archive: '🗜️', file: '📁' };
  function typeIcon(item) { return TYPE_ICON[typeOf(item)] || '📁'; }

  var ALLOWED_EXTS = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','jpg','jpeg','png','gif','webp','mp4','mov','webm','mp3','wav','ogg','zip','rar','json','html'];
  var MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file

  function detectPlatform(url) {
    try {
      var h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') return 'YouTube';
      if (/(^|\.)instagram\.com$/.test(h)) return 'Instagram';
      if (/(^|\.)facebook\.com$/.test(h) || h === 'fb.watch') return 'Facebook';
      if (/(^|\.)tiktok\.com$/.test(h)) return 'TikTok';
      if (/(^|\.)x\.com$/.test(h) || /(^|\.)twitter\.com$/.test(h)) return 'X (Twitter)';
      return 'Website';
    } catch (e) { return 'Website'; }
  }

  var DEFAULT_FOLDERS = [
    ['YouTube Videos', '▶️', '#E0245E'], ['Instagram Reels', '📸', '#C13584'],
    ['Documents', '📄', '#1769AA'], ['College Notes', '🎓', '#2F8FE5'],
    ['Government Documents', '🏛️', '#102A43'], ['Photos', '🖼️', '#39BDEB'],
    ['Videos', '🎬', '#7C3AED'], ['Websites', '🌐', '#0EA5E9'],
    ['Work Files', '💼', '#0F766E'], ['Personal Notes', '📝', '#F5B301']
  ];
  function seedFolders(db, userId) {
    DEFAULT_FOLDERS.forEach(function (f) {
      db.folders.push({ id: uid(), userId: userId, name: f[0], icon: f[1], color: f[2], parentId: null, createdAt: now(), isPrivate: false });
    });
  }

  function logActivity(db, event, detail) {
    db.activity.unshift({ ts: now(), event: event, detail: String(detail || '') });
    if (db.activity.length > 200) db.activity.length = 200;
  }

  window.SaveBoxDB = {
    DB_KEY: DB_KEY, uid: uid, now: now, loadDb: loadDb, saveDb: saveDb, emptyDb: emptyDb,
    sha256Hex: sha256Hex, blobPut: blobPut, blobGet: blobGet, blobDelete: blobDelete,
    photoPut: photoPut, photoGet: photoGet, photoDelete: photoDelete,
    esc: esc, fmtSize: fmtSize, fmtDate: fmtDate, fmtDateShort: fmtDateShort,
    initials: initials, extOf: extOf, typeOf: typeOf, typeIcon: typeIcon,
    ALLOWED_EXTS: ALLOWED_EXTS, MAX_FILE_BYTES: MAX_FILE_BYTES,
    detectPlatform: detectPlatform, seedFolders: seedFolders, logActivity: logActivity
  };
})();
