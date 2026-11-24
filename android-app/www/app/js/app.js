/* SaveBox v1.5.8 — main app logic (MEGA cloud files only) */
(function () {
  'use strict';
  var APP_VERSION = '1.5.8'; // v1.5.8 — used by the in-app update check; bump with every release
  var UPDATE_REPO = 'somya2005-Aje/savebox';
  var D = window.SaveBoxDB;
  var FBx = window.SaveBoxFirebase; // null-safe: firebase.js loads before app.js
  var R2x = window.SaveBoxR2; // null-safe: r2.js loads before app.js (dormant in v1.4.0 — R2 was dropped, see R2_SETUP.md)
  var MegaX = window.SaveBoxMega; // null-safe: mega.js loads before app.js
  var db = D.loadDb();
  // Merge new settings keys into DBs created by older versions
  // (v1.2.0 adds lockMode / passwordLockHash / webauthnCredId).
  db.settings = Object.assign(D.emptyDb().settings, db.settings);
  var photoUrl = null; // object URL of the signed-in user's profile photo (IndexedDB)
  var syncInProgress = false;
  var state = {
    view: 'home', folderId: null, search: '', sort: 'date', filter: 'all',
    grid: db.settings.gridDefault || 'grid', selected: new Set(), selectMode: false,
    settingsTab: 'profile', privateUnlocked: false, previewList: [], previewIdx: 0,
    lastActivity: Date.now(), lockTimer: null, imgZoom: 1,
    googleAuthNeeded: false, // v1.5.3 — true only after a sync failed with an auth/permission error; shows the "Reconnect Google" button in Cloud Sync
    updateAvailable: null // v1.5.8 — { tag, url } when the update check found a newer release; shown as a banner on Home
  };

  function save() { D.saveDb(db); }
  function me() { return db.users.find(function (u) { return u.id === db.session.userId; }) || null; }

  /* ---------- profile photo + avatar ---------- */
  function avatarHtml(u) {
    if (photoUrl) return '<img src="' + photoUrl + '" alt="Profile photo">';
    return D.initials(u.name);
  }
  function refreshAvatars() {
    var u = me(); if (!u) return;
    ['sideAvatar', 'headerAvatar'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.innerHTML = avatarHtml(u);
    });
    var pf = document.getElementById('pfAvatar'); if (pf) pf.innerHTML = avatarHtml(u);
  }
  function loadPhoto() {
    var u = me(); if (!u) return;
    D.photoGet(u.id).then(function (blob) {
      if (blob) { if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = URL.createObjectURL(blob); refreshAvatars(); }
    }).catch(function () { /* no photo yet */ });
  }
  function compressPhoto(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var max = 512, w = img.width, h = img.height;
        var scale = Math.min(1, max / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
        cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('compress failed')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { reject(new Error('not an image')); };
      img.src = URL.createObjectURL(file);
    });
  }
  function onPhotoPicked(e) {
    var file = e.target.files && e.target.files[0]; if (!file) return;
    var u = me(); if (!u) return;
    if (file.type.indexOf('image/') !== 0) { toast('Please choose an image file.', 'err'); return; }
    compressPhoto(file).then(function (blob) {
      return D.photoPut(u.id, blob).then(function () {
        if (photoUrl) URL.revokeObjectURL(photoUrl);
        photoUrl = URL.createObjectURL(blob);
        D.logActivity(db, 'profile_photo', 'Profile photo updated');
        save(); refreshAvatars(); renderView();
        toast('Profile photo updated ✓', 'ok');
      });
    }).catch(function () { toast('Could not use that image. Try a JPG or PNG photo.', 'err'); });
  }
  function changePhoto() { var inp = document.getElementById('photoInput'); if (inp) { inp.value = ''; inp.click(); } }
  function removePhoto() {
    var u = me(); if (!u) return;
    D.photoDelete(u.id).then(function () {
      if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
      D.logActivity(db, 'profile_photo', 'Profile photo removed');
      save(); refreshAvatars(); renderView();
      toast('Profile photo removed — back to initials.', 'ok');
    });
  }
  function myItems() { return db.items.filter(function (i) { return i.userId === me().id && !i.isDeleted; }); }
  function myFolders() { return db.folders.filter(function (f) { return f.userId === me().id; }); }
  function folderById(id) { return db.folders.find(function (f) { return f.id === id; }) || null; }
  function itemById(id) { return db.items.find(function (i) { return i.id === id; }) || null; }
  function visibleItems(list) {
    // Private-folder items are hidden everywhere until unlocked
    if (state.privateUnlocked) return list;
    var pf = db.folders.find(function (f) { return f.userId === me().id && f.isPrivate; });
    if (!pf) return list;
    return list.filter(function (i) { return i.folderId !== pf.id; });
  }
  function applySearch(list) {
    var q = state.search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (i) {
      var hay = [i.title, i.customName, i.fileName, i.description, i.platform, D.extOf(i.fileName || ''), (i.tags || []).join(' '), (folderById(i.folderId) || {}).name].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortItems(list) {
    var s = state.sort, arr = list.slice();
    if (s === 'name') arr.sort(function (a, b) { return (a.customName || a.title || '').localeCompare(b.customName || b.title || ''); });
    else if (s === 'size') arr.sort(function (a, b) { return (b.fileSize || 0) - (a.fileSize || 0); });
    else if (s === 'type') arr.sort(function (a, b) { return D.typeOf(a).localeCompare(D.typeOf(b)); });
    else arr.sort(function (a, b) { return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt); });
    return arr;
  }
  function filterByChip(list) {
    var f = state.filter;
    if (f === 'all') return list;
    if (f === 'images') return list.filter(function (i) { return D.typeOf(i) === 'image'; });
    if (f === 'pdfs') return list.filter(function (i) { return D.typeOf(i) === 'pdf'; });
    if (f === 'docs') return list.filter(function (i) { return ['doc', 'pdf'].indexOf(D.typeOf(i)) >= 0; });
    if (f === 'videos') return list.filter(function (i) { return D.typeOf(i) === 'video'; });
    if (f === 'audio') return list.filter(function (i) { return D.typeOf(i) === 'audio'; });
    if (f === 'links') return list.filter(function (i) { return i.kind === 'link'; });
    if (f === 'notes') return list.filter(function (i) { return i.kind === 'note'; });
    return list.filter(function (i) { return ['image', 'video', 'audio', 'pdf', 'doc', 'link', 'note'].indexOf(D.typeOf(i)) < 0; });
  }
  function displayName(i) { return i.customName || i.title || i.fileName || 'Untitled'; }

  /* ---------- logo ---------- */
  var LOGO_SVG = '<svg width="38" height="38" viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<path d="M24 4 42 12v14c0 9-7.5 15-18 18C13.5 41 6 35 6 26V12L24 4z" fill="#1769AA"/>' +
    '<path d="M24 4 42 12v14c0 9-7.5 15-18 18V4z" fill="#2F8FE5" opacity=".85"/>' +
    '<path d="M14 27a6 6 0 0 1 2-4.5A8 8 0 0 1 30 20a6.5 6.5 0 0 1 1 12.9H16A5 5 0 0 1 14 27z" fill="#fff"/>' +
    '<path d="M20.5 26.5l2.5 2.5 4.5-5" stroke="#1769AA" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
    '<circle cx="36" cy="12" r="3.2" fill="#F5B301"/></svg>';
  ['logoAuth', 'logoSide', 'logoTop'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.innerHTML = LOGO_SVG;
  });

  /* ---------- theme ---------- */
  function applyTheme() {
    var dark = db.settings.theme === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    var t = dark ? '☀️' : '🌙';
    ['themeBtn', 'authThemeBtn'].forEach(function (id) { var b = document.getElementById(id); if (b) b.textContent = t; });
    applyStatusBarStyle(); // v1.5.8 — keep the status-bar text readable in both themes (native only)
  }
  function toggleTheme() { db.settings.theme = db.settings.theme === 'dark' ? 'light' : 'dark'; save(); applyTheme(); }

  /* ---------- v1.5.8 — native status bar: the WebView starts BELOW the
     status bar instead of drawing under it, so the header never slides under
     the notification area. The CSS safe-area insets (app.css) handle the rest
     on web + native; when this plugin runs, env(safe-area-inset-top) reports
     0, so the two fixes never double up. No-ops on the website. */
  function nativeStatusBar() {
    if (typeof Capacitor === 'undefined' || !Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) return null;
    var g = window.capacitorStatusBar;
    return (g && g.StatusBar) || null;
  }
  function setupNativeChrome() {
    var SB = nativeStatusBar(); if (!SB) return;
    try { var p = SB.setOverlaysWebView({ overlay: false }); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    applyStatusBarStyle();
  }
  function applyStatusBarStyle() {
    var SB = nativeStatusBar(); if (!SB) return;
    var dark = document.documentElement.classList.contains('dark');
    try { var p1 = SB.setStyle({ style: dark ? 'LIGHT' : 'DARK' }); if (p1 && p1.catch) p1.catch(function () {}); } catch (e) {}
    try { var p2 = SB.setBackgroundColor({ color: dark ? '#0B1B2B' : '#F4F8FC' }); if (p2 && p2.catch) p2.catch(function () {}); } catch (e) {}
  }

  /* ---------- v1.5.8 — in-app update check ----------
     Silently asks GitHub for the latest SaveBox release and compares it with
     this build. Never blocks startup, never shows an error when offline or
     when the check fails — it just stays quiet. When a newer release exists
     a banner appears on Home; Settings → About has a manual "Check for
     updates" button. Download always opens the release APK URL in the
     system browser / download manager (never a silent in-WebView download). */
  var updateCheckDone = false;
  function parseSemver(v) {
    var m = String(v || '').replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
  }
  function isNewerVersion(latest, current) {
    var a = parseSemver(latest), b = parseSemver(current);
    if (!a || !b) return false;
    for (var i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
    return false;
  }
  function checkForUpdate(manual) {
    var ctrl = null, timer = null;
    try { ctrl = new AbortController(); timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 8000); } catch (e) { ctrl = null; }
    fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', { signal: ctrl ? ctrl.signal : undefined, headers: { 'Accept': 'application/vnd.github+json' } })
      .then(function (r) { if (timer) clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (rel) {
        var tag = rel && rel.tag_name ? String(rel.tag_name) : '';
        if (!tag) { if (manual) toast('Could not check for updates — try again later.', 'err'); return; }
        var dl = 'https://github.com/' + UPDATE_REPO + '/releases/download/' + tag + '/savebox-' + tag + '.apk';
        if (rel && rel.assets) {
          for (var i = 0; i < rel.assets.length; i++) {
            if (rel.assets[i].name === 'savebox-' + tag + '.apk' && rel.assets[i].browser_download_url) { dl = rel.assets[i].browser_download_url; break; }
          }
        }
        if (isNewerVersion(tag, APP_VERSION)) {
          state.updateAvailable = { tag: tag, url: dl };
          if (state.view === 'home') renderView();
          if (manual) toast('Naya update available: ' + tag + ' — Download button se update karo.');
        } else {
          state.updateAvailable = null;
          if (manual) toast('You are on the latest version (v' + APP_VERSION + ').', 'ok');
        }
      })
      .catch(function () { if (timer) clearTimeout(timer); if (manual) toast('Could not check for updates — check your connection and try again.', 'err'); });
  }
  function scheduleUpdateCheck() {
    if (updateCheckDone) return; updateCheckDone = true;
    setTimeout(function () { try { checkForUpdate(false); } catch (e) {} }, 2500);
  }

  /* ---------- toasts & modals ---------- */
  function toast(msg, kind) {
    var root = document.getElementById('toastRoot');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(function () { el.remove(); }, 320); }, 3400);
  }
  function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
  function openModal(html, wide) {
    var root = document.getElementById('modalRoot');
    root.innerHTML = '<div class="modal-bg" id="modalBg"><div class="modal-card' + (wide ? ' wide' : '') + '">' + html + '</div></div>';
    document.getElementById('modalBg').addEventListener('click', function (e) { if (e.target.id === 'modalBg') closeModal(); });
  }
  function modalHead(title, sub) {
    return '<div class="flex items-start justify-between gap-3 mb-4"><div><h3 class="text-lg font-extrabold text-navy dark:text-white">' + D.esc(title) + '</h3>' +
      (sub ? '<p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">' + D.esc(sub) + '</p>' : '') + '</div>' +
      '<button type="button" class="btn-ghost shrink-0" onclick="SaveBoxUI.closeModal()">✕</button></div>';
  }
  function confirmModal(title, body, dangerLabel, onYes) {
    var id = 'cf_' + D.uid();
    window[id] = function () { closeModal(); onYes(); };
    openModal(modalHead(title) + '<p class="text-sm text-slate-600 dark:text-slate-300 mb-5">' + body + '</p>' +
      '<div class="flex gap-2 justify-end"><button type="button" class="btn-outline" onclick="SaveBoxUI.closeModal()">Cancel</button>' +
      '<button type="button" class="btn-danger" onclick="window[\'' + id + '\']()">' + D.esc(dangerLabel) + '</button></div>');
  }

  /* ---------- auth ---------- */
  function showAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    document.getElementById('loginForm').classList.toggle('hidden', tab !== 'login');
    document.getElementById('registerForm').classList.toggle('hidden', tab !== 'register');
    document.getElementById('forgotForm').classList.toggle('hidden', tab !== 'forgot');
  }
  document.querySelectorAll('.auth-tab').forEach(function (b) { b.addEventListener('click', function () { showAuthTab(b.dataset.tab); }); });
  document.getElementById('forgotLink').addEventListener('click', function () { showAuthTab('forgot'); });
  document.getElementById('forgotBack').addEventListener('click', function () { showAuthTab('login'); });
  function startGoogleSignIn(btn) {
    if (FBx && FBx.init()) {
      if (btn) btn.disabled = true;
      FBx.signInWithGoogle().then(function (fbUser) {
        if (btn) btn.disabled = false;
        if (fbUser) linkFirebaseUser(fbUser);
        else toast('Google sign-in opened — finish it there and you will be signed in here.');
      }).catch(function (err) {
        if (btn) btn.disabled = false;
        openModal(modalHead('Google Sign-In didn’t work') +
          '<p class="text-sm text-slate-600 dark:text-slate-300 mb-4">' + D.esc(FBx.friendlyError(err)) + '</p>' +
          '<button class="btn-primary w-full" type="button" onclick="SaveBoxUI.closeModal()">Got it</button>');
      });
      return;
    }
    openModal(modalHead('Google Sign-In needs Firebase') +
      '<p class="text-sm text-slate-600 dark:text-slate-300 mb-3">Google Sign-In is a cloud feature. This version of SaveBox (v1.5.8) stores accounts on this device only, so Google Sign-In is not available yet.</p>' +
      '<p class="text-sm text-slate-600 dark:text-slate-300 mb-4">To enable it, connect a free Firebase project — see FIREBASE_SETUP.md in the SaveBox project folder (free, about 10 minutes, no payment). Once connected, this button signs you in with Google — no code changes needed.</p>' +
      '<button class="btn-primary w-full" type="button" onclick="SaveBoxUI.closeModal()">Got it</button>');
  }
  /* v1.5.3 — shown ONLY when a sync failed with an auth/permission
   * error (state.googleAuthNeeded). Re-runs Google sign-in; on success
   * the stored firebaseUid updates (linkFirebaseUser) and enterApp's
   * silent sync retries with the live uid. */
  function reconnectGoogle(btn) {
    if (!(FBx && FBx.init())) { toast('Google Sign-In needs Firebase — see FIREBASE_SETUP.md in the SaveBox project folder.', 'err'); return; }
    if (btn) btn.disabled = true;
    FBx.signInWithGoogle().then(function (fbUser) {
      if (btn) btn.disabled = false;
      if (fbUser) {
        linkFirebaseUser(fbUser);
        toast('Google reconnected ✓ — syncing…', 'ok');
      } else {
        toast('Google sign-in opened — finish it there and you will be signed in here.');
      }
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      openModal(modalHead('Google Sign-In didn’t work') +
        '<p class="text-sm text-slate-600 dark:text-slate-300 mb-4">' + D.esc(FBx.friendlyError(err)) + '</p>' +
        '<button class="btn-primary w-full" type="button" onclick="SaveBoxUI.closeModal()">Got it</button>');
    });
  }
  ['googleBtn', 'googleBtnReg'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function () { startGoogleSignIn(b); });
  });

  document.getElementById('registerForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('regName').value.trim();
    var email = document.getElementById('regEmail').value.trim().toLowerCase();
    var pass = document.getElementById('regPassword').value;
    var err = document.getElementById('regError');
    if (FBx && FBx.init()) { firebaseRegister(name, email, pass); return; }
    if (!name || !email || pass.length < 6) { err.textContent = 'Please fill all fields — password must be at least 6 characters.'; err.classList.remove('hidden'); return; }
    if (db.users.some(function (u) { return u.email === email; })) { err.textContent = 'An account with this email already exists on this device. Try signing in.'; err.classList.remove('hidden'); return; }
    D.sha256Hex(pass).then(function (hash) {
      var user = { id: D.uid(), email: email, name: name, passwordHash: hash, photoInitials: D.initials(name), createdAt: Date.now(), lastLogin: Date.now() };
      db.users.push(user);
      db.session.userId = user.id;
      D.seedFolders(db, user.id);
      db.sessions.push({ id: D.uid(), userId: user.id, device: 'This device', startedAt: Date.now(), current: true });
      D.logActivity(db, 'account_created', 'Account created for ' + email);
      D.logActivity(db, 'login', 'Signed in');
      save();
      enterApp();
      toast('Welcome to SaveBox, ' + name + '! 🎉', 'ok');
    });
  });

  document.getElementById('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('loginEmail').value.trim().toLowerCase();
    var pass = document.getElementById('loginPassword').value;
    var err = document.getElementById('loginError');
    if (FBx && FBx.init()) { firebaseLogin(email, pass); return; }
    var user = db.users.find(function (u) { return u.email === email; });
    if (!user) { err.textContent = 'No account found with this email on this device.'; err.classList.remove('hidden'); return; }
    D.sha256Hex(pass).then(function (hash) {
      if (hash !== user.passwordHash) { err.textContent = 'Wrong password. Try again or use “Forgot password?”.'; err.classList.remove('hidden'); return; }
      user.lastLogin = Date.now();
      db.session.userId = user.id;
      db.sessions.forEach(function (s) { s.current = false; });
      db.sessions.push({ id: D.uid(), userId: user.id, device: 'This device', startedAt: Date.now(), current: true });
      D.logActivity(db, 'login', 'Signed in');
      save();
      enterApp();
    });
  });

  document.getElementById('forgotForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('forgotEmail').value.trim().toLowerCase();
    var step2 = document.getElementById('forgotStep2');
    var err = document.getElementById('forgotError');
    if (FBx && FBx.init()) { firebaseForgot(email); return; }
    var user = db.users.find(function (u) { return u.email === email; });
    if (!user) { err.textContent = 'No account with this email exists on this device.'; err.classList.remove('hidden'); return; }
    if (step2.classList.contains('hidden')) {
      step2.classList.remove('hidden');
      err.textContent = ''; err.classList.add('hidden');
      toast('Account found. Set your new password below.', 'ok');
      return;
    }
    var np = document.getElementById('forgotNewPass').value;
    if (np.length < 6) { err.textContent = 'New password must be at least 6 characters.'; err.classList.remove('hidden'); return; }
    D.sha256Hex(np).then(function (hash) {
      user.passwordHash = hash;
      D.logActivity(db, 'password_reset', 'Password reset (on this device) for ' + email);
      save();
      toast('Password updated. Please sign in.', 'ok');
      showAuthTab('login');
      document.getElementById('loginEmail').value = email;
    });
  });

  function logout() {
    if (FBx && FBx.ready) FBx.signOut();
    if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
    D.logActivity(db, 'logout', 'Signed out');
    db.session.userId = null;
    state.privateUnlocked = false;
    save();
    document.getElementById('appView').classList.add('hidden');
    document.getElementById('authView').classList.remove('hidden');
    showAuthTab('login');
    toast('Signed out. Your files stay safe on this device.');
  }

  /* ---------- Firebase auth linking ---------- */
  function linkFirebaseUser(fbUser, fallbackName) {
    var email = (fbUser.email || '').toLowerCase();
    var name = fbUser.displayName || fallbackName || (email ? email.split('@')[0] : 'SaveBox User');
    var u = db.users.find(function (x) { return x.firebaseUid === fbUser.uid; }) ||
            db.users.find(function (x) { return x.email === email; });
    if (u) {
      u.firebaseUid = fbUser.uid;
      if (fbUser.displayName) u.name = fbUser.displayName;
      u.lastLogin = Date.now();
    } else {
      u = { id: D.uid(), email: email, name: name, passwordHash: '', firebaseUid: fbUser.uid, createdAt: Date.now(), lastLogin: Date.now() };
      db.users.push(u);
      D.seedFolders(db, u.id);
      D.logActivity(db, 'account_created', 'Account created via Firebase');
    }
    db.session.userId = u.id;
    db.sessions.forEach(function (s) { s.current = false; });
    db.sessions.push({ id: D.uid(), userId: u.id, device: 'This device', startedAt: Date.now(), current: true });
    D.logActivity(db, 'login', 'Signed in with Firebase');
    state.googleAuthNeeded = false; // a live Firebase user just linked — auth is healthy again
    save();
    if (FBx && FBx.ready) FBx.userDoc(fbUser.uid, { email: u.email, name: u.name }).catch(function () {});
    enterApp();
    toast('Welcome to SaveBox, ' + u.name.split(' ')[0] + '! 🎉', 'ok');
  }
  function firebaseRegister(name, email, pass) {
    var err = document.getElementById('regError');
    if (!name || !email || email.indexOf('@') < 0 || pass.length < 6) { err.textContent = 'Please fill all fields — password must be at least 6 characters.'; err.classList.remove('hidden'); return; }
    FBx.registerWithEmail(email, pass, name).then(function (fbUser) {
      linkFirebaseUser(fbUser, name);
    }).catch(function (e) { err.textContent = FBx.friendlyError(e); err.classList.remove('hidden'); });
  }
  function firebaseLogin(email, pass) {
    var err = document.getElementById('loginError');
    if (!email || !pass) { err.textContent = 'Please enter your email and password.'; err.classList.remove('hidden'); return; }
    FBx.signInWithEmail(email, pass).then(function (fbUser) {
      linkFirebaseUser(fbUser);
    }).catch(function (e) { err.textContent = FBx.friendlyError(e); err.classList.remove('hidden'); });
  }
  function firebaseForgot(email) {
    var err = document.getElementById('forgotError');
    if (!email || email.indexOf('@') < 0) { err.textContent = 'Please enter a valid email address.'; err.classList.remove('hidden'); return; }
    FBx.resetPassword(email).then(function () {
      D.logActivity(db, 'password_reset', 'Firebase password reset email sent to ' + email);
      save();
      toast('Password reset email sent to ' + email + ' — check your inbox.', 'ok');
      showAuthTab('login');
      document.getElementById('loginEmail').value = email;
    }).catch(function (e) { err.textContent = FBx.friendlyError(e); err.classList.remove('hidden'); });
  }

  /* ---------- app shell ---------- */
  var NAV = [
    ['home', '🏠', 'Home'], ['folders', '📁', 'Folders'], ['files', '🗂️', 'All Files'],
    ['favourites', '⭐', 'Favourites'], ['private', '🔒', 'Private'], ['downloads', '⬇️', 'Downloads'],
    ['trash', '🗑️', 'Trash'], ['settings', '⚙️', 'Settings']
  ];
  function renderNav() {
    var side = document.getElementById('sideNav');
    side.innerHTML = NAV.map(function (n) {
      return '<button type="button" data-nav="' + n[0] + '" class="nav-item' + (state.view === n[0] ? ' active' : '') + '"><span>' + n[1] + '</span>' + n[2] + '</button>';
    }).join('');
    side.querySelectorAll('[data-nav]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.nav); }); });
    var bottom = document.getElementById('bottomNav');
    var mob = [['home', '🏠', 'Home'], ['folders', '📁', 'Folders'], ['files', '🗂️', 'Files'], ['favourites', '⭐', 'Saved'], ['settings', '⚙️', 'Settings']];
    bottom.innerHTML = mob.map(function (n) {
      return '<button type="button" data-nav="' + n[0] + '" class="bnav-item' + (state.view === n[0] ? ' active' : '') + '"><span class="ic">' + n[1] + '</span>' + n[2] + '</button>';
    }).join('');
    bottom.querySelectorAll('[data-nav]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.nav); }); });
  }
  function go(view, opts) {
    state.view = view;
    state.selected.clear(); state.selectMode = false;
    if (opts && opts.folderId !== undefined) state.folderId = opts.folderId;
    if (view !== 'folders') state.folderId = state.folderId; // keep folder context only in folders view
    renderNav();
    var v = document.getElementById('view');
    if (v) v.innerHTML = skeletonHtml();
    window.scrollTo({ top: 0 });
    setTimeout(renderView, 130);
  }
  function skeletonHtml() {
    return '<div class="space-y-3" aria-hidden="true"><div class="skel h-8 w-48"></div>' +
      '<div class="grid grid-cols-2 lg:grid-cols-4 gap-3"><div class="skel h-20"></div><div class="skel h-20"></div><div class="skel h-20"></div><div class="skel h-20"></div></div>' +
      '<div class="skel h-16"></div><div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3"><div class="skel h-44"></div><div class="skel h-44"></div><div class="skel h-44"></div><div class="skel h-44"></div></div></div>';
  }
  function enterApp() {
    document.getElementById('authView').classList.add('hidden');
    document.getElementById('appView').classList.remove('hidden');
    var u = me();
    document.getElementById('sideUserName').textContent = u.name;
    document.getElementById('sideUserEmail').textContent = u.email;
    refreshAvatars();
    loadPhoto();
    renderNav();
    renderView();
    updateStorageWidget();
    setupNativeChrome(); // v1.5.8 — WebView below the status bar (native only)
    scheduleUpdateCheck(); // v1.5.8 — silent GitHub release check, never blocks
    armAutoLock();
    if (db.settings.appLockEnabled && hasLockMethod()) showLockScreen();
    setTimeout(function () { syncNow(false); }, 900); // silent background cloud sync
  }
  function updateStorageWidget() {
    // v1.5.2: device storage is never displayed — the sidebar widget was removed.
  }

  /* ---------- view router ---------- */
  function renderView() {
    var v = document.getElementById('view');
    if (state.view === 'home') v.innerHTML = viewHome();
    else if (state.view === 'folders') v.innerHTML = viewFolders();
    else if (state.view === 'files') v.innerHTML = viewFiles();
    else if (state.view === 'favourites') v.innerHTML = viewFavourites();
    else if (state.view === 'trash') v.innerHTML = viewTrash();
    else if (state.view === 'private') v.innerHTML = viewPrivate();
    else if (state.view === 'downloads') v.innerHTML = viewDownloads();
    else if (state.view === 'settings') v.innerHTML = viewSettings();
    bindView(v);
  }
  function emptyState(icon, title, sub, ctaHtml) {
    return '<div class="empty card"><div class="big">' + icon + '</div><h3 class="font-bold text-lg text-navy dark:text-white mt-2">' + title + '</h3>' +
      '<p class="text-sm mt-1 max-w-sm mx-auto">' + sub + '</p>' + (ctaHtml ? '<div class="mt-4 flex gap-2 justify-center flex-wrap">' + ctaHtml + '</div>' : '') + '</div>';
  }

  /* ---------- shared item rendering ---------- */
  function itemCard(i, list) {
    var sel = state.selected.has(i.id);
    var thumbHtml;
    if (i.kind === 'link' && i.thumbnail) thumbHtml = '<img src="' + D.esc(i.thumbnail) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<div class=&quot;text-5xl&quot;>' + D.typeIcon(i) + '</div>\'">';
    else thumbHtml = '<span class="text-5xl">' + D.typeIcon(i) + '</span>';
    var badge = i.kind === 'link' ? (i.platform || 'Website') : (D.extOf(i.fileName || '') || D.typeOf(i)).toUpperCase();
    var sizeTxt = i.kind === 'file' ? D.fmtSize(i.fileSize) : (i.kind === 'link' ? (i.platform || 'Link') : 'Note');
    return '<article class="item-card' + (sel ? ' selected' : '') + '" data-item="' + i.id + '">' +
      '<div class="thumb" data-act="open" data-id="' + i.id + '">' + thumbHtml + '<span class="plat">' + D.esc(badge) + '</span></div>' +
      '<div class="p-3">' +
      '<div class="flex items-start gap-2"><input type="checkbox" class="cb mt-0.5 shrink-0 item-check" data-id="' + i.id + '"' + (sel ? ' checked' : '') + '>' +
      '<h4 class="font-semibold text-sm line-clamp-2 flex-1 cursor-pointer" data-act="open" data-id="' + i.id + '">' + D.esc(displayName(i)) + '</h4>' +
      '<button type="button" class="text-lg leading-none shrink-0" data-act="fav" data-id="' + i.id + '" title="Favourite">' + (i.isFavourite ? '⭐' : '☆') + '</button></div>' +
      '<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5">' + sizeTxt + ' • ' + D.fmtDateShort(i.updatedAt || i.createdAt) + '</p>' +
      (i.tags && i.tags.length ? '<p class="mt-1.5 flex flex-wrap gap-1">' + i.tags.slice(0, 3).map(function (t) { return '<span class="badge bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">#' + D.esc(t) + '</span>'; }).join('') + '</p>' : '') +
      '<div class="flex gap-1.5 mt-3">' +
      '<button type="button" class="btn-soft flex-1" data-act="open" data-id="' + i.id + '">Open</button>' +
      '<button type="button" class="btn-soft flex-1" data-act="share" data-id="' + i.id + '">Share</button>' +
      '<button type="button" class="btn-soft" data-act="menu" data-id="' + i.id + '" title="More">⋯</button></div>' +
      '</div></article>';
  }
  function itemRow(i) {
    var sel = state.selected.has(i.id);
    return '<div class="card flex items-center gap-3 p-3' + (sel ? ' !border-electric' : '') + '">' +
      '<input type="checkbox" class="cb shrink-0 item-check" data-id="' + i.id + '"' + (sel ? ' checked' : '') + '>' +
      '<span class="text-2xl shrink-0">' + D.typeIcon(i) + '</span>' +
      '<div class="min-w-0 flex-1 cursor-pointer" data-act="open" data-id="' + i.id + '"><p class="font-semibold text-sm truncate">' + D.esc(displayName(i)) + '</p>' +
      '<p class="text-xs text-slate-500 dark:text-slate-400">' + (i.kind === 'file' ? D.fmtSize(i.fileSize) + ' • ' : '') + D.fmtDateShort(i.updatedAt || i.createdAt) + (i.platform ? ' • ' + D.esc(i.platform) : '') + '</p></div>' +
      '<button type="button" class="text-lg shrink-0" data-act="fav" data-id="' + i.id + '">' + (i.isFavourite ? '⭐' : '☆') + '</button>' +
      '<button type="button" class="btn-soft shrink-0" data-act="menu" data-id="' + i.id + '">⋯</button></div>';
  }
  function listHtml(items, opts) {
    opts = opts || {};
    if (!items.length) return emptyState(opts.emptyIcon || '📭', opts.emptyTitle || 'Nothing here yet', opts.emptySub || 'Save a link, upload a file or write a note to get started.', opts.emptyCta);
    var body = state.grid === 'grid'
      ? '<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">' + items.map(function (i) { return itemCard(i); }).join('') + '</div>'
      : '<div class="space-y-2">' + items.map(itemRow).join('') + '</div>';
    return body;
  }
  function bulkBarHtml() {
    if (!state.selected.size) return '';
    return '<div class="sticky top-[4.4rem] z-20 card !bg-navy !text-white dark:!bg-navy p-3 mb-4 flex flex-wrap items-center gap-2">' +
      '<b>' + state.selected.size + ' selected</b>' +
      '<button type="button" class="btn-soft" data-bulk="move">📁 Move</button>' +
      '<button type="button" class="btn-soft" data-bulk="fav">⭐ Favourite</button>' +
      '<button type="button" class="btn-soft" data-bulk="tag">🏷️ Add tag</button>' +
      '<button type="button" class="btn-soft danger" data-bulk="delete">🗑️ Delete</button>' +
      '<button type="button" class="ml-auto underline text-sm" data-bulk="clear">Clear</button></div>';
  }
  function toolbarHtml(showFilters) {
    var chips = [['all', 'All'], ['images', 'Images'], ['pdfs', 'PDFs'], ['docs', 'Documents'], ['videos', 'Videos'], ['audio', 'Audio'], ['links', 'Links'], ['notes', 'Notes'], ['other', 'Other']];
    return '<div class="flex flex-wrap items-center gap-2 mb-4">' +
      (showFilters ? chips.map(function (c) { return '<button type="button" class="chip' + (state.filter === c[0] ? ' active' : '') + '" data-chip="' + c[0] + '">' + c[1] + '</button>'; }).join('') : '') +
      '<span class="ml-auto flex items-center gap-2">' +
      '<select id="sortSel" class="inp !w-auto !py-1.5 text-sm"><option value="date">Newest first</option><option value="name">Name A–Z</option><option value="size">Largest first</option><option value="type">By type</option></select>' +
      '<button type="button" class="btn-ghost !w-9 !h-9" id="gridToggle" title="Toggle grid/list">' + (state.grid === 'grid' ? '☰' : '▦') + '</button></span></div>';
  }

  /* ---------- HOME ---------- */
  function viewHome() {
    var items = visibleItems(myItems());
    var folders = myFolders();
    var links = items.filter(function (i) { return i.kind === 'link'; });
    var docs = items.filter(function (i) { return ['doc', 'pdf'].indexOf(D.typeOf(i)) >= 0; });
    var totalBytes = items.reduce(function (s, i) { return s + (i.fileSize || 0); }, 0);
    var recent = sortItems(items).slice(0, 8);
    var opened = items.filter(function (i) { return i.openedAt; }).sort(function (a, b) { return b.openedAt - a.openedAt; }).slice(0, 6);
    var favs = items.filter(function (i) { return i.isFavourite; }).slice(0, 8);
    function stat(icon, label, val, sub) {
      return '<div class="stat-card"><div class="flex items-center gap-2"><span class="text-2xl">' + icon + '</span><span class="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">' + label + '</span></div>' +
        '<p class="text-2xl font-extrabold text-navy dark:text-white mt-1">' + val + '</p><p class="text-xs text-slate-500 dark:text-slate-400">' + sub + '</p></div>';
    }
    return (state.updateAvailable ? '<div class="card p-4 mb-4 flex flex-wrap items-center gap-3" style="border-color:#1769AA">' +
      '<span class="text-2xl">⬆️</span><div class="flex-1 min-w-[12rem]"><p class="font-bold">Naya update available: ' + D.esc(state.updateAvailable.tag) + '</p>' +
      '<p class="text-xs text-slate-500 dark:text-slate-400">Download karke install karo — v1.5.8 ya uske baad ke version se seedha update ho jata hai, uninstall nahi karna padta.</p></div>' +
      '<button type="button" class="btn-primary !py-2" data-qa="downloadUpdate">Download</button>' +
      '<button type="button" class="btn-ghost" data-qa="dismissUpdate" title="Dismiss">✕</button></div>' : '') +
      '<h1 class="text-2xl font-extrabold text-navy dark:text-white">Hello, ' + D.esc(me().name.split(' ')[0]) + ' 👋</h1>' +
      '<p class="text-sm text-slate-500 dark:text-slate-400 mb-5">Your locker at a glance.</p>' +
      '<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">' +
      stat('📦', 'Total items', items.length, 'files, links &amp; notes') +
      stat('📁', 'Folders', folders.length, 'including subfolders') +
      stat('🔗', 'Links saved', links.length, 'YouTube, Instagram &amp; more') +
      stat('📄', 'Documents', docs.length, D.fmtSize(totalBytes) + ' total') + '</div>' +
      '<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">' +
      '<button type="button" class="btn-primary" data-qa="save">＋ Save Link</button>' +
      '<button type="button" class="btn-outline" data-qa="upload">⬆ Upload File</button>' +
      '<button type="button" class="btn-outline" data-qa="folder">📁 New Folder</button>' +
      '<button type="button" class="btn-outline" data-qa="note">📝 New Note</button></div>' +
      (favs.length ? '<h2 class="sec-h">⭐ Favourites</h2><div class="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">' + favs.map(function (i) {
        return '<button type="button" class="card shrink-0 w-44 p-3 text-left" data-act="open" data-id="' + i.id + '"><span class="text-3xl">' + D.typeIcon(i) + '</span><p class="font-semibold text-sm truncate mt-1">' + D.esc(displayName(i)) + '</p><p class="text-xs text-slate-500">' + (i.kind === 'file' ? D.fmtSize(i.fileSize) : (i.platform || 'Note')) + '</p></button>';
      }).join('') + '</div>' : '') +
      '<h2 class="sec-h">🕒 Recently Saved</h2>' +
      (recent.length ? listHtml(recent, { emptyTitle: '' }) : emptyState('📭', 'Nothing saved yet', 'Save your first link or upload a file — it will show up here.', '<button type="button" class="btn-primary" data-qa="save">＋ Save Link</button><button type="button" class="btn-outline" data-qa="upload">⬆ Upload File</button>')) +
      (opened.length ? '<h2 class="sec-h">👁️ Recently Opened</h2><div class="space-y-2">' + opened.map(itemRow).join('') + '</div>' : '');
  }

  /* ---------- FOLDERS ---------- */
  function folderCrumbs() {
    var parts = [{ id: null, name: 'All Folders' }];
    var cur = folderById(state.folderId);
    var chain = [];
    while (cur) { chain.unshift(cur); cur = cur.parentId ? folderById(cur.parentId) : null; }
    return parts.concat(chain);
  }
  function viewFolders() {
    var folders = myFolders().filter(function (f) { return (f.parentId || null) === (state.folderId || null) && !f.isPrivate; });
    var items = visibleItems(myItems()).filter(function (i) { return (i.folderId || null) === (state.folderId || null); });
    items = sortItems(filterByChip(applySearch(items)));
    var crumbs = folderCrumbs();
    var html = '<div class="flex flex-wrap items-center gap-2 mb-4"><nav class="flex items-center gap-1 text-sm font-semibold flex-wrap">' +
      crumbs.map(function (c, idx) {
        return (idx ? '<span class="text-slate-400">›</span>' : '') + '<button type="button" class="link" data-crumb="' + (c.id || '') + '">' + D.esc(c.name) + '</button>';
      }).join('') + '</nav>' +
      '<span class="ml-auto flex gap-2"><button type="button" class="btn-soft" data-qa="subfolder">＋ Subfolder</button><button type="button" class="btn-primary !py-2" data-qa="folder">＋ New Folder</button></span></div>';
    if (folders.length) {
      html += '<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 mb-6">' + folders.map(function (f) {
        var count = myItems().filter(function (i) { return i.folderId === f.id && !i.isDeleted; }).length;
        var subs = myFolders().filter(function (x) { return x.parentId === f.id; }).length;
        return '<div class="card folder-card p-4" data-folder="' + f.id + '">' +
          '<div class="flex items-start justify-between"><span class="text-3xl" style="color:' + D.esc(f.color || '#1769AA') + '">' + D.esc(f.icon || '📁') + '</span>' +
          '<button type="button" class="btn-soft !px-2 !py-1" data-folder-menu="' + f.id + '" title="Folder options">⋯</button></div>' +
          '<p class="font-bold mt-2 truncate">' + D.esc(f.name) + '</p>' +
          '<p class="text-xs text-slate-500 dark:text-slate-400">' + count + ' item' + (count === 1 ? '' : 's') + (subs ? ' • ' + subs + ' subfolder' + (subs === 1 ? '' : 's') : '') + '</p></div>';
      }).join('') + '</div>';
    } else if (!state.folderId) {
      html += emptyState('📁', 'No folders here', 'Folders help you organise everything. Create your first folder below.', '<button type="button" class="btn-primary" data-qa="folder">＋ New Folder</button>');
    }
    html += '<h2 class="sec-h">' + (state.folderId ? 'Items in this folder' : '📄 All files (no folder)') + '</h2>';
    html += bulkBarHtml() + listHtml(items, { emptyTitle: 'No items here', emptySub: 'Items you move into this folder will appear here.', emptyIcon: '🗂️' });
    return html;
  }

  /* ---------- ALL FILES ---------- */
  function viewFiles() {
    var items = sortItems(filterByChip(applySearch(visibleItems(myItems()))));
    return '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">All Files</h1>' +
      '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">' + items.length + ' item' + (items.length === 1 ? '' : 's') + ' • tap a card to open, ⋯ for more actions</p>' +
      bulkBarHtml() + toolbarHtml(true) + listHtml(items, { emptyTitle: 'No files match', emptySub: 'Try a different search or filter, or save something new.', emptyCta: '<button type="button" class="btn-primary" data-qa="save">＋ Save Link</button><button type="button" class="btn-outline" data-qa="upload">⬆ Upload File</button>' });
  }
  function viewFavourites() {
    var items = sortItems(filterByChip(applySearch(visibleItems(myItems()).filter(function (i) { return i.isFavourite; }))));
    return '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">⭐ Favourites</h1><p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Your starred items, in one place.</p>' +
      bulkBarHtml() + toolbarHtml(true) + listHtml(items, { emptyTitle: 'No favourites yet', emptySub: 'Tap the ☆ on any item to star it — it will appear here.', emptyIcon: '⭐' });
  }
  function viewTrash() {
    var items = db.items.filter(function (i) { return i.userId === me().id && i.isDeleted; }).sort(function (a, b) { return (b.deletedAt || 0) - (a.deletedAt || 0); });
    var html = '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">🗑️ Trash</h1>' +
      '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Deleted items stay here until you restore or permanently delete them. Permanent deletion removes the local copy; cloud backups follow the retention policy after Firebase setup.</p>';
    if (items.length) {
      html += '<div class="flex gap-2 mb-4"><button type="button" class="btn-soft" data-trash="restoreAll">↩ Restore all</button>' +
        '<button type="button" class="btn-soft danger" data-trash="empty">Empty Trash</button></div>' +
        '<div class="space-y-2">' + items.map(function (i) {
          return '<div class="card flex items-center gap-3 p-3"><span class="text-2xl">' + D.typeIcon(i) + '</span>' +
            '<div class="min-w-0 flex-1"><p class="font-semibold text-sm truncate">' + D.esc(displayName(i)) + '</p>' +
            '<p class="text-xs text-slate-500 dark:text-slate-400">Deleted ' + D.fmtDate(i.deletedAt) + '</p></div>' +
            '<button type="button" class="btn-soft" data-trash-restore="' + i.id + '">Restore</button>' +
            '<button type="button" class="btn-soft danger" data-trash-hard="' + i.id + '">Delete forever</button></div>';
        }).join('') + '</div>';
    } else html += emptyState('🗑️', 'Trash is empty', 'Deleted items will appear here so you can restore them.', null);
    return html;
  }
  function viewDownloads() {
    var events = db.activity.filter(function (a) { return a.event === 'download'; });
    var ids = [];
    events.forEach(function (a) { var m = /id=([a-z0-9_]+)/.exec(a.detail || ''); if (m && ids.indexOf(m[1]) < 0) ids.push(m[1]); });
    var items = ids.map(itemById).filter(Boolean).filter(function (i) { return !i.isDeleted; });
    items = visibleItems(items);
    return '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">⬇️ Downloads</h1>' +
      '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Items you have downloaded in this app, most recent first. (Downloads go to your device\'s Downloads folder.)</p>' +
      listHtml(items, { emptyTitle: 'No downloads yet', emptySub: 'Use Download on any file or link to save a copy to your device.', emptyIcon: '⬇️' });
  }
  function viewPrivate() {
    var pf = db.folders.find(function (f) { return f.userId === me().id && f.isPrivate; });
    if (!db.settings.privateFolderEnabled || !pf) {
      return '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">🔒 Private Folder</h1>' +
        '<div class="card p-6 mt-4 text-center"><div class="text-5xl">🔒</div><h2 class="font-bold text-lg mt-3">Private Folder is off</h2>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">Move sensitive files here and they disappear from Home, All Files and search until you unlock with your PIN. Enabling it requires setting a PIN first.</p>' +
        '<button type="button" class="btn-primary mt-4" data-qa="enablePrivate">Set up Private Folder</button></div>';
    }
    if (!state.privateUnlocked) {
      return '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">🔒 Private Folder</h1>' +
        '<div class="card p-6 mt-4 text-center"><div class="text-5xl">🔐</div><h2 class="font-bold text-lg mt-3">Locked</h2>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Unlock with your PIN, app-lock password or fingerprint — whichever you have set up.</p>' +
        '<button type="button" class="btn-primary mt-4" data-qa="unlockPrivate">🔓 Unlock Private Folder</button>' +
        '<p class="text-xs text-slate-400 mt-3">No lock method set yet? Go to Settings → Security → Lock Type &amp; Setup.</p></div>';
    }
    var items = sortItems(applySearch(myItems().filter(function (i) { return i.folderId === pf.id && !i.isDeleted; })));
    return '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">🔒 Private Folder</h1>' +
      '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Unlocked — items here are hidden from every other view. <button type="button" class="link" data-qa="lockPrivate">Lock now</button></p>' +
      bulkBarHtml() + listHtml(items, { emptyTitle: 'Private folder is empty', emptySub: 'Use Move on any item and choose “Private Folder” to hide it here.', emptyIcon: '🔒' });
  }

  /* ---------- SETTINGS ---------- */
  function viewSettings() {
    var tabs = [
      ['profile', '👤', 'Profile', 'Name, email, photo & appearance'],
      ['security', '🔐', 'Security', 'PIN, password, fingerprint & app lock'],
      ['storage', '💾', 'Storage', 'Usage, largest files & cleanup'],
      ['backup', '💿', 'Backup', 'Backup, restore & export'],
      ['cloud', '☁️', 'Cloud Sync', 'MEGA cloud files'],
      ['about', 'ℹ️', 'About', 'Version, features & limits']
    ];
    var html = '<h1 class="text-2xl font-extrabold text-navy dark:text-white mb-1">⚙️ Settings</h1>' +
      '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Choose a section below — each one opens on its own, line by line.</p>' +
      '<div class="settings-list">' + tabs.map(function (t) {
        return '<button type="button" class="settings-row' + (state.settingsTab === t[0] ? ' active' : '') + '" data-stab="' + t[0] + '">' +
          '<span class="s-ic">' + t[1] + '</span><span class="min-w-0"><span class="s-title block">' + t[2] + '</span>' +
          '<span class="s-sub block truncate">' + t[3] + '</span></span><span class="s-chev">›</span></button>';
      }).join('') + '</div><div id="settingsBody" class="mt-4">' + settingsBody() + '</div>';
    return html;
  }
  /* MEGA section for Settings → Cloud Sync (form when logged out, status
   * when connected). The MEGA password is typed here and goes only to
   * MEGA — it is never stored, never sent anywhere else, and the field
   * is cleared after every attempt. */
  function megaCloudHtml() {
    var isConn = megaReady();
    var h = '<div class="mt-5 pt-4 border-t border-slate-200 dark:border-slate-700"><h3 class="font-bold text-base mb-1">📦 MEGA Cloud Files (20 GB free)</h3>';
    if (isConn) {
      var em = (MegaX.accountEmail ? MegaX.accountEmail() : '') || '';
      h += '<p class="text-sm"><span class="badge bg-green-100 text-green-700">● Connected</span> <b>' + D.esc(em) + '</b></p>' +
        '<p id="megaStatusLine" class="text-sm text-slate-500 dark:text-slate-400 mt-1">MEGA folder <b>SaveBox</b> in your Cloud drive — checking quota…</p>' +
        '<div class="flex flex-wrap gap-2 mt-3"><button type="button" class="btn-primary" data-qa="syncNow">⇅ Sync Now</button>' +
        '<button type="button" class="btn-outline" data-qa="megaLogout">Disconnect MEGA</button></div>' +
        '<p class="text-xs text-slate-500 dark:text-slate-400 mt-2">Files are end-to-end encrypted by MEGA. Free accounts have a limited download/transfer quota — very large or frequent downloads can pause until the quota resets.</p>';
    } else {
      h += '<p class="text-sm"><span class="badge bg-amber-100 text-amber-700">Not connected</span></p>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400 mt-2">Connect your free MEGA account (20 GB, no card) and files upload to a <b>SaveBox</b> folder in your MEGA Cloud drive.</p>' +
        '<div class="grid gap-3 mt-3"><div><label class="lbl">MEGA email</label><input id="megaEmail" class="inp" type="email" placeholder="you@example.com" autocomplete="username"></div>' +
        '<div><label class="lbl">MEGA password</label><input id="megaPass" class="inp" type="password" placeholder="Your MEGA password" autocomplete="current-password"></div>' +
        '<div><span class="lbl">Two-step authentication (2FA)</span>' +
        '<label class="flex items-start gap-2 text-sm mt-1"><input type="radio" name="mega2faMode" value="off" checked class="accent-blue-600 mt-1"> <span><b>No 2FA</b> — log in without a code</span></label>' +
        '<label class="flex items-start gap-2 text-sm mt-2"><input type="radio" name="mega2faMode" value="on" class="accent-blue-600 mt-1"> <span><b>2FA is on</b> — I\'ll enter the code</span></label>' +
        '<div id="mega2faWrap" class="hidden mt-2"><label class="lbl">6-digit code</label><input id="mega2fa" class="inp" type="text" inputmode="numeric" placeholder="6-digit code" autocomplete="one-time-code"></div></div></div>' +
        '<label class="flex items-center gap-2 text-sm mt-3"><input id="megaRemember" type="checkbox" class="accent-blue-600"> Keep me signed in on this device</label>' +
        '<p id="megaLoginErr" class="err hidden"></p>' +
        '<div class="flex flex-wrap gap-2 mt-3"><button type="button" class="btn-primary" data-qa="megaLogin">Connect MEGA</button></div>' +
        '<p class="text-xs text-slate-500 dark:text-slate-400 mt-2">Your MEGA email &amp; password go only to MEGA (mega.nz) — SaveBox never stores them, never sends them anywhere else, and never shows your password. Without “Keep me signed in”, you log in again each time you open the app.</p>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">New to MEGA? MEGA is a free cloud drive (20 GB free, no card). <a href="https://mega.nz/" target="_blank" rel="noopener" class="font-semibold text-blue-600 dark:text-blue-400 underline">Open MEGA — mega.nz</a></p>';
    }
    /* v1.5.3 — shown ONLY after a sync failed with an auth/permission
     * error (expired Google session / mismatched account). Never shown
     * otherwise: the permanent Google block stays removed. */
    if (state.googleAuthNeeded && FBx && FBx.ready) {
      h += '<div class="mt-4 pt-4 border-t border-amber-200 dark:border-amber-800"><p class="text-sm"><b>⚠️ Google sync needs sign-in again</b></p>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Your Google session expired, so folders &amp; links can\'t sync to Google right now. Your files are safe in MEGA.</p>' +
        '<div class="flex flex-wrap gap-2 mt-3"><button type="button" class="btn-primary" data-qa="reconnectGoogle">Reconnect Google</button></div></div>';
    }
    return h + '</div>';
  }
  function settingsBody() {
    var u = me(), s = db.settings, tab = state.settingsTab;
    if (tab === 'profile') {
      return '<div class="card p-5"><div class="flex items-center gap-4"><span class="avatar-wrap"><span id="pfAvatar" class="avatar lg">' + avatarHtml(u) + '</span>' +
        '<label for="photoInput" class="avatar-edit" title="Change profile photo — tap to pick from your gallery">📷</label></span>' +
        '<div><h2 class="font-extrabold text-lg">' + D.esc(u.name) + '</h2><p class="text-sm text-slate-500">' + D.esc(u.email) + '</p><p class="text-xs text-slate-400 mt-1">Member since ' + D.fmtDateShort(u.createdAt) + ' • Last login ' + D.fmtDate(u.lastLogin) + '</p>' +
        (u.firebaseUid ? '' : '<p class="text-xs text-slate-400 mt-1">On-device account — connect MEGA in Cloud Sync for cloud files.</p>') + '</div></div>' +
        '<div class="grid gap-3 mt-5"><div><label class="lbl">Name</label><input id="pfName" class="inp" value="' + D.esc(u.name) + '"></div>' +
        '<div><label class="lbl">Email</label><input id="pfEmail" class="inp" value="' + D.esc(u.email) + '" type="email"></div></div>' +
        '<div class="flex gap-2 mt-4"><button type="button" class="btn-primary" data-qa="saveProfile">Save profile</button>' +
        '<button type="button" class="btn-outline" data-qa="changePass">Change password</button></div>' +
        '<div class="flex flex-wrap gap-2 mt-3"><label for="photoInput" class="btn-soft">📷 Change photo (gallery)</label>' +
        (photoUrl ? '<button type="button" class="btn-soft danger" data-qa="removePhoto">Remove photo</button>' : '') + '</div>' +
        '<div class="mt-6 pt-4 border-t border-slate-200 dark:border-slate-700"><label class="lbl">Appearance</label>' +
        '<div class="flex gap-2"><button type="button" class="chip' + (s.theme === 'light' ? ' active' : '') + '" data-theme="light">☀️ Light</button>' +
        '<button type="button" class="chip' + (s.theme === 'dark' ? ' active' : '') + '" data-theme="dark">🌙 Dark</button></div></div>' +
        '<div class="mt-4"><label class="lbl">Default view layout</label><div class="flex gap-2">' +
        '<button type="button" class="chip' + (s.gridDefault === 'grid' ? ' active' : '') + '" data-grid="grid">▦ Grid</button>' +
        '<button type="button" class="chip' + (s.gridDefault === 'list' ? ' active' : '') + '" data-grid="list">☰ List</button></div></div>' +
        '<div class="mt-6 pt-4 border-t border-slate-200 dark:border-slate-700"><button type="button" class="btn-outline w-full" data-qa="logout">↩ Log out</button>' +
        '<button type="button" class="btn-soft danger mt-3" data-qa="deleteAccount">Delete my account…</button></div></div>';
    }
    if (tab === 'security') {
      var acts = db.activity.slice(0, 30);
      var sessions = db.sessions.filter(function (x) { return x.userId === u.id; });
      return '<div class="space-y-4">' +
        '<div class="card p-5"><h2 class="font-bold text-lg mb-3">🔐 App Lock &amp; Lock Methods</h2>' +
        '<div class="space-y-2 text-sm">' +
        '<p>App lock: <b>' + (s.appLockEnabled ? 'ON' : 'OFF') + '</b> • Lock type: <b>' + D.esc((LOCK_MODES[s.lockMode] || LOCK_MODES.pin).label) + '</b></p>' +
        '<p>PIN: <b>' + (s.pinHash ? 'Set (' + s.pinLength + '-digit)' : 'Not set') + '</b> • Password: <b>' + (s.passwordLockHash ? 'Set' : 'Not set') + '</b></p>' +
        '<p id="fpStatusLine">Fingerprint: <b>Checking device support…</b></p>' +
        '<p>Auto-lock: <b>' + D.esc({ immediately: 'Immediately', '30s': '30 seconds', '1m': '1 minute', '5m': '5 minutes', background: 'On background' }[s.autoLock] || s.autoLock) + '</b></p></div>' +
        '<div class="flex flex-wrap gap-2 mt-4"><button type="button" class="btn-primary" data-qa="lockSetup">Lock Type &amp; Setup</button>' +
        '<button type="button" class="btn-outline" data-qa="toggleLock">' + (s.appLockEnabled ? 'Disable app lock' : 'Enable app lock') + '</button>' +
        '<button type="button" class="btn-outline" data-qa="autoLock">Auto-lock options</button></div>' +
        '<p class="text-xs text-slate-500 dark:text-slate-400 mt-3">Fingerprint uses your device\'s built-in biometrics (WebAuthn). SaveBox never sees or stores your fingerprint — only a credential ID stays on this device. If this device has no fingerprint / face unlock, Fingerprint stays honestly disabled.</p></div>' +
        '<div class="card p-5"><h2 class="font-bold text-lg mb-3">👤 Signed-in account</h2>' +
        '<p class="text-sm"><b>' + D.esc(u.name) + '</b> • ' + D.esc(u.email) + '<br>Last login: ' + D.fmtDate(u.lastLogin) + '</p>' +
        '<h3 class="font-bold mt-4 mb-2 text-sm">Active sessions</h3>' +
        (sessions.length ? sessions.map(function (x) { return '<p class="text-sm py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">📱 ' + D.esc(x.device) + ' • ' + D.fmtDate(x.startedAt) + (x.current ? ' • <b>This session</b>' : '') + '</p>'; }).join('') : '<p class="text-sm text-slate-500">No sessions recorded.</p>') +
        '<button type="button" class="btn-soft danger mt-3" data-qa="signOutOthers">Sign out other sessions</button></div>' +
        '<div class="card p-5"><h2 class="font-bold text-lg mb-3">📋 Recent activity</h2>' +
        (acts.length ? '<div class="space-y-1 max-h-72 overflow-y-auto">' + acts.map(function (a) {
          return '<p class="text-sm flex justify-between gap-3"><span>' + D.esc(a.event.replace(/_/g, ' ')) + ' — ' + D.esc(a.detail) + '</span><span class="text-slate-400 shrink-0">' + D.fmtDate(a.ts) + '</span></p>';
        }).join('') + '</div>' : '<p class="text-sm text-slate-500">No activity yet.</p>') + '</div></div>';
    }
    if (tab === 'storage') {
      var items = visibleItems(myItems());
      var byType = {};
      items.forEach(function (i) { var t = D.typeOf(i); byType[t] = (byType[t] || 0) + (i.fileSize || 0); });
      var largest = items.filter(function (i) { return i.kind === 'file'; }).sort(function (a, b) { return (b.fileSize || 0) - (a.fileSize || 0); }).slice(0, 10);
      var groups = {};
      items.filter(function (i) { return i.kind === 'file'; }).forEach(function (i) { var k = (i.fileName || '').toLowerCase() + '|' + (i.fileSize || 0); (groups[k] = groups[k] || []).push(i); });
      var dups = Object.keys(groups).filter(function (k) { return groups[k].length > 1; });
      var trashCount = db.items.filter(function (i) { return i.userId === u.id && i.isDeleted; }).length;
      var sugg = [];
      if (largest.length && (largest[0].fileSize || 0) > 20 * 1024 * 1024) sugg.push({ t: 'Large file: ' + displayName(largest[0]) + ' (' + D.fmtSize(largest[0].fileSize) + ')', id: largest[0].id });
      if (dups.length) sugg.push({ t: dups.length + ' duplicate group' + (dups.length === 1 ? '' : 's') + ' found (same name + size)', id: groups[dups[0]][0].id });
      if (trashCount) sugg.push({ t: trashCount + ' item' + (trashCount === 1 ? '' : 's') + ' sitting in Trash', id: null, view: 'trash' });
      if (!sugg.length) sugg.push({ t: 'All clean — no large files, duplicates or old trash found.', id: null });
      var megaItems = items.filter(function (i) { return i.kind === 'file' && i.storagePath && i.storagePath.indexOf('mega:') === 0; });
      var megaBytes = megaItems.reduce(function (s, i) { return s + (i.fileSize || 0); }, 0);
      var megaPct = Math.min(100, Math.round(megaBytes / (window.SAVEBOX_MEGA_QUOTA_BYTES || 21474836480) * 100));
      var megaCard = '<div class="card p-5"><h2 class="font-bold text-lg">☁️ Cloud files (MEGA)</h2>' +
        (megaReady() ?
          '<div class="flex justify-between text-sm font-semibold mt-3"><span>' + megaItems.length + ' file' + (megaItems.length === 1 ? '' : 's') + ' in the cloud</span><span>' + D.fmtSize(megaBytes) + ' of 20 GB free</span></div>' +
          '<div class="progress mt-2"><div style="width:' + megaPct + '%"></div></div>' +
          '<p id="megaQuotaLine" class="text-xs text-slate-500 dark:text-slate-400 mt-2">MEGA folder <b>SaveBox</b> — end-to-end encrypted, 20 GB free. Checking live quota…</p>' :
          '<p class="text-sm text-slate-500 dark:text-slate-400 mt-2">Not connected — connect your MEGA account in Settings → Cloud Sync. Files upload to a <b>SaveBox</b> folder in your MEGA Cloud drive (20 GB free, no card).</p>') + '</div>';
      return '<div class="space-y-4">' + megaCard + '<div class="card p-5">' +
        '<h3 class="font-bold mb-2 text-sm">Breakdown by type</h3>' +
        (Object.keys(byType).length ? Object.keys(byType).sort(function (a, b) { return byType[b] - byType[a]; }).map(function (t) {
          return '<div class="flex justify-between text-sm py-1"><span class="capitalize">' + t + '</span><b>' + D.fmtSize(byType[t]) + '</b></div>';
        }).join('') : '<p class="text-sm text-slate-500">No files yet.</p>') + '</div>' +
        '<div class="card p-5"><h2 class="font-bold text-lg mb-2">📦 Largest files (top 10)</h2>' +
        (largest.length ? largest.map(function (i) { return '<button type="button" class="w-full text-left flex justify-between text-sm py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0" data-act="open" data-id="' + i.id + '"><span class="truncate">' + D.typeIcon(i) + ' ' + D.esc(displayName(i)) + '</span><b class="shrink-0 ml-2">' + D.fmtSize(i.fileSize) + '</b></button>'; }).join('') : '<p class="text-sm text-slate-500">No files uploaded yet.</p>') + '</div>' +
        '<div class="card p-5"><h2 class="font-bold text-lg mb-2">👯 Duplicate candidates</h2>' +
        (dups.length ? dups.map(function (k) { return '<p class="text-sm py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">“' + D.esc(groups[k][0].fileName || '') + '” — ' + groups[k].length + ' copies • ' + D.fmtSize(groups[k][0].fileSize || 0) + ' each ' +
          '<button type="button" class="link ml-1" data-act="open" data-id="' + groups[k][0].id + '">Review →</button></p>'; }).join('') : '<p class="text-sm text-slate-500">No duplicates found (same name + size).</p>') + '</div>' +
        '<div class="card p-5"><h2 class="font-bold text-lg mb-2">🧹 Cleanup suggestions</h2><p class="text-xs text-slate-500 mb-2">Suggestions only — SaveBox never auto-deletes anything.</p>' +
        sugg.map(function (s2) { return '<p class="text-sm py-1.5 flex justify-between gap-3"><span>' + D.esc(s2.t) + '</span>' + (s2.id ? '<button type="button" class="link shrink-0" data-act="open" data-id="' + s2.id + '">Review →</button>' : (s2.view ? '<button type="button" class="link shrink-0" data-goto="' + s2.view + '">Open Trash →</button>' : '')) + '</p>'; }).join('') + '</div></div>';
    }
    if (tab === 'backup') {
      return '<div class="space-y-4"><div class="card p-5"><h2 class="font-bold text-lg mb-2">💿 Backup &amp; Restore</h2>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Backups are JSON files on your device. Files under 10 MB are included; larger files are listed as skipped — re-upload them manually after restore.</p>' +
        '<div class="flex flex-wrap gap-2"><button type="button" class="btn-primary" data-qa="backupNow">⬇ Backup Now</button>' +
        '<button type="button" class="btn-outline" data-qa="restoreBackup">↩ Restore from backup…</button></div>' +
        '<h3 class="font-bold mt-5 mb-2 text-sm">Backup history</h3>' +
        (db.backups.length ? db.backups.slice().reverse().map(function (b) { return '<p class="text-sm py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">📦 ' + D.esc(b.name) + ' • ' + D.fmtSize(b.size) + ' • ' + D.fmtDate(b.ts) + '</p>'; }).join('') : '<p class="text-sm text-slate-500">No backups yet.</p>') + '</div>' +
        '<div class="card p-5"><h2 class="font-bold text-lg mb-2">📤 Export</h2>' +
        '<div class="flex flex-wrap gap-2"><button type="button" class="btn-soft" data-qa="exportLinksCsv">Export Links (CSV)</button>' +
        '<button type="button" class="btn-soft" data-qa="exportLinksJson">Export Links (JSON)</button>' +
        '<button type="button" class="btn-soft" data-qa="exportAccount">Export Account Data (JSON)</button></div>' +
        '<p class="text-xs text-slate-500 dark:text-slate-400 mt-3">Account Data export is metadata only — file contents are not included. Use Backup for full files.</p></div></div>';
    }
    if (tab === 'cloud') {
      return '<div class="card p-5"><h2 class="font-bold text-lg mb-2">☁️ Cloud Sync</h2>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400">Connect MEGA to keep your files safe across devices. New uploads go to your MEGA SaveBox folder (20 GB free).</p>' +
        megaCloudHtml() + '</div>';
    }
    return '<div class="card p-5"><h2 class="font-bold text-lg mb-2">ℹ️ About SaveBox</h2>' +
      '<p class="text-sm">SaveBox <b>v1.5.8</b> — Personal Cloud Storage &amp; Digital Locker.</p>' +
      '<div class="flex flex-wrap items-center gap-2 mt-3"><button type="button" class="btn-soft" data-qa="checkUpdate">🔄 Check for updates</button><span class="text-xs text-slate-500 dark:text-slate-400">Current version: v1.5.8 — new versions install directly over the old app, no uninstall needed (from v1.5.8).</span></div>' +
      '<h3 class="font-bold mt-4 mb-1 text-sm">What works in v1.5.8</h3><ul class="text-sm list-disc pl-5 space-y-1 text-slate-600 dark:text-slate-300">' +
      '<li>Save links (YouTube, Instagram, Facebook, TikTok, any website) with real metadata fetch</li>' +
      '<li>Upload files up to 50 MB each — your connected cloud is used first, this device only when every connected cloud is full</li>' +
      '<li>Notes, folders &amp; subfolders, favourites, trash, multi-select, search &amp; filters</li>' +
      '<li>PIN-locked Private Folder and optional App Lock — PIN, password or fingerprint (5 lock types)</li>' +
      '<li>Google Sign-In button on the login screen (works once Firebase is connected — no code change needed)</li>' +
      '<li>Fingerprint unlock via WebAuthn device biometrics, where the device supports it</li>' +
      '<li>Share links with expiry + password, backup / restore, CSV &amp; JSON export</li>' +
      '<li>Profile photo from your gallery, vertical Settings menu, 3D smooth design</li>' +
      '<li>MEGA cloud files (20 GB free) — connect your MEGA account in Settings → Cloud Sync; files upload to a SaveBox folder in your Cloud drive, no Firebase needed.</li>' +
      '<li>Google Drive was removed in v1.5.1 — MEGA is the only cloud storage now.</li>' +
      '<li>Sync fixed in v1.5.3 — if your Google session expires, sync falls back to MEGA instead of an error, and a “Reconnect Google” button appears in Cloud Sync until you sign in again.</li>' +
      '<li>Pink theme in v1.5.4 — buttons, links and highlights are now pink on the same dark theme.</li>' +
      '<li>Blue theme restored in v1.5.5 — the original blue colours are back (pink removed).</li>' +
      '<li>App icon in v1.5.6 — the SaveBox shield is now the APK launcher icon (and the Add-to-Home-Screen icon).</li>' +
      '<li>Google Sign-In in v1.5.7 — in the installed app, “Continue with Google” now opens the Google account chooser INSIDE the app (no Chrome, no localhost error); on the website the sign-in flow is unchanged.</li>' +
      '<li>Safe area in v1.5.8 — the header stays below the phone’s status bar and the bottom nav stays above the back/home buttons; the app also feels a bit more compact.</li>' +
      '<li>Updates in v1.5.8 — the app checks GitHub for new versions on start (silently, never blocks) and shows a Download banner on Home; Settings → About has a “Check for updates” button. New versions install directly over the old app — no uninstall needed from v1.5.7 (v1.5.6 users must uninstall once, because v1.5.6 was signed with a different key).</li>' +
      '<li>MEGA login asks about two-step authentication first — pick “No 2FA” to log in without a code, or “2FA is on” to enter your 6-digit code; new to MEGA? A link to mega.nz sits under the login form.</li>' +
      (window.FIREBASE_ENABLED ? '<li>Firebase connected — Google Sign-In + Firestore sync (folders, links &amp; notes).</li>' : '') +
      (window.R2_ENABLED ? '<li>Cloud files on Cloudflare R2 (10 GB free) — uploads go to your private bucket when signed in.</li>' : '') + '</ul>' +
      '<h3 class="font-bold mt-4 mb-1 text-sm">Honest limits</h3><ul class="text-sm list-disc pl-5 space-y-1 text-slate-600 dark:text-slate-300">' +
      '<li>New files upload to your connected cloud first (MEGA SaveBox folder, 20 GB free). Files are stored on this device only when every connected cloud is full or none is connected — cloud files need internet to open.</li>' +
      '<li>MEGA free accounts have a limited download/transfer quota — very large or frequent downloads can pause until the quota resets</li>' +
      '<li>MEGA sessions expire — without “Keep me signed in”, log in again each time you open the app</li>' +
      '<li>MEGA files are end-to-end encrypted by MEGA; SaveBox never sees your MEGA password</li>' +
      '<li>Fingerprint unlock needs a device with fingerprint / face unlock and a WebAuthn-capable browser — otherwise it stays honestly disabled</li>' +
      '<li>On the native Android app, fingerprint can also use BiometricPrompt (Phase 6)</li>' +
      '<li>Some websites block metadata fetching — you can always enter the title manually</li>' +
      '<li>Backups skip files over 10 MB (re-upload those manually after restore)</li></ul>' +
      '<p class="text-xs text-slate-400 mt-4">Made for somya • Free • v1.5.8</p></div>';
  }

  /* ---------- event binding for the current view ---------- */
  function bindView(root) {
    root.querySelectorAll('[data-qa]').forEach(function (b) { b.addEventListener('click', function () { quickAction(b.dataset.qa); }); });
    root.querySelectorAll('[data-nav]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.nav); }); });
    root.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.goto); }); });
    root.querySelectorAll('[data-stab]').forEach(function (b) { b.addEventListener('click', function () { state.settingsTab = b.dataset.stab; renderView(); }); });
    root.querySelectorAll('[data-theme]').forEach(function (b) { b.addEventListener('click', function () { db.settings.theme = b.dataset.theme; save(); applyTheme(); renderView(); }); });
    root.querySelectorAll('[data-grid]').forEach(function (b) { b.addEventListener('click', function () { db.settings.gridDefault = b.dataset.grid; state.grid = b.dataset.grid; save(); renderView(); toast('Default layout set to ' + b.dataset.grid + '.'); }); });
    root.querySelectorAll('[data-chip]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.dataset.chip; renderView(); }); });
    var sortSel = root.querySelector('#sortSel');
    if (sortSel) { sortSel.value = state.sort; sortSel.addEventListener('change', function () { state.sort = sortSel.value; renderView(); }); }
    root.querySelectorAll('input[name="mega2faMode"]').forEach(function (r) {
      r.addEventListener('change', function () { toggleMega2fa(); });
    });
    var gt = root.querySelector('#gridToggle');
    if (gt) gt.addEventListener('click', function () { state.grid = state.grid === 'grid' ? 'list' : 'grid'; renderView(); });
    root.querySelectorAll('[data-crumb]').forEach(function (b) { b.addEventListener('click', function () { state.folderId = b.dataset.crumb || null; renderView(); }); });
    root.querySelectorAll('[data-folder]').forEach(function (el) { el.addEventListener('click', function (e) { if (e.target.closest('[data-folder-menu]')) return; state.folderId = el.dataset.folder; go('folders'); }); });
    root.querySelectorAll('[data-folder-menu]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); folderMenu(b.dataset.folderMenu); }); });
    root.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var act = el.dataset.act, id = el.dataset.id;
        if (act === 'open') openItem(id);
        else if (act === 'fav') toggleFavourite(id);
        else if (act === 'share') shareModal(id);
        else if (act === 'menu') itemMenu(id);
      });
    });
    root.querySelectorAll('.item-check').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.checked) state.selected.add(cb.dataset.id); else state.selected.delete(cb.dataset.id);
        renderView();
      });
    });
    root.querySelectorAll('[data-bulk]').forEach(function (b) { b.addEventListener('click', function () { bulkAction(b.dataset.bulk); }); });
    root.querySelectorAll('[data-trash]').forEach(function (b) { b.addEventListener('click', function () { trashAction(b.dataset.trash); }); });
    root.querySelectorAll('[data-trash-restore]').forEach(function (b) { b.addEventListener('click', function () { restoreItem(b.dataset.trashRestore); }); });
    root.querySelectorAll('[data-trash-hard]').forEach(function (b) { b.addEventListener('click', function () { hardDeleteItem(b.dataset.trashHard); }); });
    // (v1.5.2: device storage is never displayed — no quota fill here.)
    // Fingerprint status line in Settings → Security (async device check)
    var fpLine = root.querySelector('#fpStatusLine');
    if (fpLine) {
      webauthnSupport().then(function (sup) {
        var el = document.getElementById('fpStatusLine'); if (!el) return;
        el.innerHTML = 'Fingerprint: <b>' + (db.settings.webauthnCredId ? 'Enrolled ✓' : (!sup.api || !sup.platform) ? 'Not supported on this device/browser' : 'Not enrolled (supported on this device)') + '</b>';
      });
    }
    // MEGA status line in Settings → Cloud Sync + Storage (async live quota)
    var megaLine = root.querySelector('#megaStatusLine');
    if (megaLine && MegaX && MegaX.quota) {
      MegaX.quota().then(function (q) {
        var el = document.getElementById('megaStatusLine'); if (!el) return;
        el.innerHTML = 'MEGA folder <b>SaveBox</b> in your Cloud drive — <b>' + D.fmtSize(q.used) + ' of ' + D.fmtSize(q.total) + ' used</b>' +
          (q.downloadTotal ? ' • downloads ' + D.fmtSize(q.downloadUsed) + ' of ' + D.fmtSize(q.downloadTotal) : '');
      }).catch(function () {
        var el = document.getElementById('megaStatusLine'); if (el) el.textContent = 'MEGA folder SaveBox in your Cloud drive — quota unavailable right now.';
      });
    }
    var megaQuotaLine = root.querySelector('#megaQuotaLine');
    if (megaQuotaLine && MegaX && MegaX.quota) {
      MegaX.quota().then(function (q) {
        var el = document.getElementById('megaQuotaLine'); if (!el) return;
        el.textContent = 'MEGA folder SaveBox — end-to-end encrypted, ' + D.fmtSize(q.used) + ' of ' + D.fmtSize(q.total) + ' used (live from MEGA). Transfer quota is limited on the free plan.';
      }).catch(function () { /* keep the static text */ });
    }
  }

  /* ---------- quick actions ---------- */
  function quickAction(qa) {
    if (qa === 'save') saveLinkModal();
    else if (qa === 'upload') uploadModal();
    else if (qa === 'folder') folderModal(null, state.view === 'folders' ? state.folderId : null);
    else if (qa === 'subfolder') folderModal(null, state.folderId);
    else if (qa === 'note') noteModal(null);
    else if (qa === 'saveProfile') saveProfile();
    else if (qa === 'changePhoto') changePhoto();
    else if (qa === 'removePhoto') removePhoto();
    else if (qa === 'syncNow') syncNow(true);
    else if (qa === 'megaLogin') megaLogin();
    else if (qa === 'megaLogout') megaLogout();
    else if (qa === 'changePass') changePasswordModal();
    else if (qa === 'deleteAccount') deleteAccountModal();
    else if (qa === 'logout') logout();
    else if (qa === 'pinSetup') pinSetupModal();
    else if (qa === 'lockSetup') lockSetupModal();
    else if (qa === 'passLockSetup') passwordLockModal();
    else if (qa === 'googleSignIn') startGoogleSignIn(null);
    else if (qa === 'checkUpdate') checkForUpdate(true);
    else if (qa === 'downloadUpdate') { if (state.updateAvailable && state.updateAvailable.url) window.open(state.updateAvailable.url, '_system'); }
    else if (qa === 'dismissUpdate') { state.updateAvailable = null; renderView(); }
    else if (qa === 'reconnectGoogle') reconnectGoogle();
    else if (qa === 'toggleLock') toggleAppLock();
    else if (qa === 'autoLock') autoLockModal();
    else if (qa === 'signOutOthers') signOutOthers();
    else if (qa === 'backupNow') backupNow();
    else if (qa === 'restoreBackup') restoreBackupPicker();
    else if (qa === 'exportLinksCsv') exportLinks('csv');
    else if (qa === 'exportLinksJson') exportLinks('json');
    else if (qa === 'exportAccount') exportAccount();
    else if (qa === 'googleInfo') {
      if (FBx && FBx.ready) { toast('Google Sign-In is connected for this app. To switch Google accounts, sign out first.', 'ok'); return; }
      openModal(modalHead('Google Sign-In needs Firebase') +
        '<p class="text-sm text-slate-600 dark:text-slate-300 mb-3">Google Sign-In is a cloud feature. Connect a free Firebase project (see FIREBASE_SETUP.md in the SaveBox project folder) to enable it — it takes about 10 minutes and needs no payment.</p>' +
        '<button class="btn-primary w-full" type="button" onclick="SaveBoxUI.closeModal()">Got it</button>');
    }
    else if (qa === 'enablePrivate') pinSetupModal(true);
    else if (qa === 'unlockPrivate') unlockPrivate();
    else if (qa === 'lockPrivate') { state.privateUnlocked = false; renderView(); toast('Private Folder locked. 🔒'); }
  }

  function folderOptionsHtml(selectedId) {
    return myFolders().map(function (f) {
      return '<option value="' + f.id + '"' + (f.id === selectedId ? ' selected' : '') + '>' + D.esc(f.isPrivate ? '🔒 ' : '') + D.esc(f.name) + '</option>';
    }).join('');
  }

  /* ----- Save Link ----- */
  function saveLinkModal() {
    openModal(modalHead('Save a Link', 'Paste any YouTube, Instagram, Facebook, TikTok or website link.') +
      '<div class="space-y-4"><div><label class="lbl">Link URL</label><input id="slUrl" class="inp" type="url" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"></div>' +
      '<p id="slErr" class="err hidden"></p>' +
      '<div id="slFetch" class="hidden text-sm text-slate-500">⏳ Fetching title &amp; thumbnail…</div>' +
      '<div id="slForm" class="hidden space-y-4">' +
      '<div id="slPreview" class="card !shadow-none p-3 flex gap-3 items-start"></div>' +
      '<div><label class="lbl">Title</label><input id="slTitle" class="inp"></div>' +
      '<div><label class="lbl">Description</label><textarea id="slDesc" class="inp"></textarea></div>' +
      '<div><label class="lbl">Custom name (optional)</label><input id="slCustom" class="inp" placeholder="Your own name for this item"></div>' +
      '<div><label class="lbl">Tags (comma separated)</label><input id="slTags" class="inp" placeholder="e.g. study, music"></div>' +
      '<div><label class="lbl">Save to folder</label><select id="slFolder" class="inp"><option value="">All Files (no folder)</option>' + folderOptionsHtml('') + '</select></div>' +
      '<p id="slMetaNote" class="text-xs text-amber-600"></p>' +
      '<button type="button" class="btn-primary w-full" id="slSaveBtn">💾 Save to SaveBox</button></div>' +
      '<button type="button" class="btn-primary w-full" id="slFetchBtn">Fetch Details →</button></div>');
    document.getElementById('slFetchBtn').addEventListener('click', fetchLinkMeta);
    document.getElementById('slUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fetchLinkMeta(); } });
  }
  function fetchWithTimeout(url, ms) {
    return Promise.race([fetch(url), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Timed out')); }, ms); })]);
  }
  function fetchLinkMeta() {
    var url = document.getElementById('slUrl').value.trim();
    var err = document.getElementById('slErr');
    err.classList.add('hidden');
    var ok = false;
    try { var u = new URL(url); ok = (u.protocol === 'http:' || u.protocol === 'https:'); } catch (e) { ok = false; }
    if (!ok) { err.textContent = 'Please paste a valid link starting with http:// or https:// — javascript: and data: links are not allowed.'; err.classList.remove('hidden'); return; }
    var platform = D.detectPlatform(url);
    var fetchEl = document.getElementById('slFetch');
    var fetchBtn = document.getElementById('slFetchBtn');
    fetchEl.classList.remove('hidden'); fetchBtn.disabled = true;
    var metaPromise;
    if (platform === 'YouTube') {
      metaPromise = fetchWithTimeout('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json', 10000)
        .then(function (r) { if (!r.ok) throw new Error('oEmbed failed'); return r.json(); })
        .then(function (j) { return { title: j.title || '', description: '', thumbnail: j.thumbnail_url || '', author: j.author_name || '' }; });
    } else {
      metaPromise = fetchWithTimeout('https://api.allorigins.win/get?url=' + encodeURIComponent(url), 12000)
        .then(function (r) { if (!r.ok) throw new Error('Proxy failed'); return r.json(); })
        .then(function (j) {
          var html = j.contents || '';
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var og = function (p) { var m = doc.querySelector('meta[property="' + p + '"]') || doc.querySelector('meta[name="' + p + '"]'); return m ? m.getAttribute('content') || '' : ''; };
          return { title: og('og:title') || doc.title || '', description: og('og:description') || og('description') || '', thumbnail: og('og:image') || '' };
        });
    }
    metaPromise.then(function (meta) { showLinkForm(url, platform, meta, false); })
      .catch(function () { showLinkForm(url, platform, { title: '', description: '', thumbnail: '' }, true); });
  }
  function showLinkForm(url, platform, meta, failed) {
    document.getElementById('slFetch').classList.add('hidden');
    document.getElementById('slFetchBtn').classList.add('hidden');
    var form = document.getElementById('slForm');
    form.classList.remove('hidden');
    var prev = document.getElementById('slPreview');
    prev.innerHTML = (meta.thumbnail ? '<img src="' + D.esc(meta.thumbnail) + '" class="w-20 h-20 object-cover rounded-lg shrink-0" alt="" onerror="this.remove()">' : '<span class="text-4xl shrink-0">' + (platform === 'YouTube' ? '▶️' : platform === 'Instagram' ? '📸' : platform === 'Facebook' ? '👍' : platform === 'TikTok' ? '🎵' : '🌐') + '</span>') +
      '<div class="min-w-0"><span class="badge bg-royal text-white">' + D.esc(platform) + '</span><p class="font-semibold text-sm mt-1 line-clamp-2">' + D.esc(meta.title || 'Untitled link') + '</p><p class="text-xs text-slate-500 truncate">' + D.esc(url) + '</p></div>';
    document.getElementById('slTitle').value = meta.title || '';
    document.getElementById('slDesc').value = meta.description || '';
    document.getElementById('slMetaNote').textContent = failed
      ? '⚠️ Could not fetch details automatically (site blocked it or no connection). Please fill the title yourself — everything is editable.'
      : 'Details fetched. Edit anything before saving.';
    document.getElementById('slSaveBtn').addEventListener('click', function () {
      var title = document.getElementById('slTitle').value.trim();
      if (!title) { toast('Please add a title for this link.', 'err'); return; }
      var item = {
        id: D.uid(), userId: me().id, kind: 'link', folderId: document.getElementById('slFolder').value || null,
        title: title, customName: document.getElementById('slCustom').value.trim() || '',
        description: document.getElementById('slDesc').value.trim(),
        tags: document.getElementById('slTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
        platform: platform, originalUrl: url, thumbnail: meta.thumbnail || '', favicon: '',
        fileName: '', fileType: '', fileSize: 0, mime: '',
        createdAt: Date.now(), updatedAt: Date.now(), isFavourite: false, isDeleted: false, deletedAt: null, openedAt: null
      };
      db.items.push(item);
      D.logActivity(db, 'link_saved', 'Saved link: ' + title + ' (' + platform + ')');
      save(); closeModal(); renderView(); updateStorageWidget();
      toast('Link saved to SaveBox ✓', 'ok');
    });
  }

  /* ----- Upload ----- */
  function uploadModal() {
    openModal(modalHead('Upload Files', 'Up to 50 MB per file. Your connected cloud is used first — this device only when every connected cloud is full.') +
      '<div class="border-2 border-dashed border-blue-300 dark:border-blue-700 rounded-xl p-6 text-center">' +
      '<div class="text-4xl">⬆️</div><p class="font-semibold mt-2">Choose files to upload</p>' +
      '<p class="text-xs text-slate-500 mt-1">Allowed: pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, jpg, jpeg, png, gif, webp, mp4, mov, webm, mp3, wav, ogg, zip, rar, json, html</p>' +
      '<button type="button" class="btn-primary mt-4" id="upPickBtn">Choose Files</button></div>' +
      '<div id="upList" class="mt-4 space-y-3"></div>' +
      '<div class="mt-4"><label class="lbl">Save to folder</label><select id="upFolder" class="inp"><option value="">All Files (no folder)</option>' + folderOptionsHtml('') + '</select></div>');
    document.getElementById('upPickBtn').addEventListener('click', function () {
      var inp = document.getElementById('hiddenFileInput');
      inp.value = '';
      inp.onchange = function () { handleUploadFiles(Array.prototype.slice.call(inp.files)); };
      inp.click();
    });
  }
  function handleUploadFiles(files) {
    var list = document.getElementById('upList');
    if (!list) return;
    files.forEach(function (file) {
      var ext = D.extOf(file.name);
      var row = document.createElement('div');
      row.className = 'card !shadow-none p-3';
      row.innerHTML = '<div class="flex justify-between gap-2 text-sm"><span class="font-semibold truncate">' + D.esc(file.name) + '</span><span class="shrink-0 text-slate-500">' + D.fmtSize(file.size) + '</span></div>' +
        '<div class="progress mt-2"><div style="width:0%"></div></div><p class="text-xs mt-1.5 up-status text-slate-500">Waiting…</p>';
      list.appendChild(row);
      var bar = row.querySelector('.progress > div'), status = row.querySelector('.up-status');
      if (D.ALLOWED_EXTS.indexOf(ext) < 0) { status.textContent = '❌ Not allowed: .' + ext + ' files cannot be uploaded.'; status.className = 'text-xs mt-1.5 up-status text-red-600 font-semibold'; return; }
      if (file.size > D.MAX_FILE_BYTES) { status.textContent = '❌ Too large — max 50 MB per file.'; status.className = 'text-xs mt-1.5 up-status text-red-600 font-semibold'; return; }
      var itemId = D.uid();
      var reader = new FileReader();
      reader.onprogress = function (e) { if (e.lengthComputable) { var p = Math.round(e.loaded / e.total * 100); bar.style.width = p + '%'; status.textContent = 'Reading… ' + p + '%'; } };
      reader.onerror = function () {
        status.innerHTML = '❌ Read failed. <button type="button" class="link retry">Retry</button>';
        row.querySelector('.retry').addEventListener('click', function () { handleUploadFiles([file]); row.remove(); });
      };
      reader.onload = function () {
        status.textContent = 'Uploading…';
        var blob = new Blob([reader.result], { type: file.type || 'application/octet-stream' });
        var item = {
          id: itemId, userId: me().id, kind: 'file', folderId: (document.getElementById('upFolder') || {}).value || null,
          title: file.name, customName: '', description: '', tags: [], platform: '', originalUrl: '',
          thumbnail: '', favicon: '', fileName: file.name, fileType: ext, fileSize: file.size, mime: file.type || '',
          createdAt: Date.now(), updatedAt: Date.now(), isFavourite: false, isDeleted: false, deletedAt: null, openedAt: null
        };
        db.items.push(item);
        // Cloud first (v1.5.2): the file goes to MEGA when connected and
        // there is space; the device is only the fallback — no device copy
        // is kept when the cloud upload succeeds.
        maybeUploadToCloud(item, blob).then(function (where) {
          if (where === 'failed') {
            db.items = db.items.filter(function (x) { return x.id !== item.id; });
            save();
            status.innerHTML = '❌ Could not save the file. <button type="button" class="link retry">Retry</button>';
            row.querySelector('.retry').addEventListener('click', function () { handleUploadFiles([file]); row.remove(); });
            return;
          }
          D.logActivity(db, 'file_uploaded', 'Uploaded ' + file.name + ' (' + D.fmtSize(file.size) + ')' + (where === 'cloud' ? ' to MEGA' : ''));
          save();
          bar.style.width = '100%';
          status.textContent = where === 'cloud' ? '✅ Saved to MEGA ✓' : '✅ Saved ✓';
          renderView(); updateStorageWidget();
        });
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ----- Notes ----- */
  function noteModal(item) {
    var isEdit = !!item;
    openModal(modalHead(isEdit ? 'Edit Note' : 'New Note', isEdit ? '' : 'Notes are saved as items you can search, tag and favourite.') +
      '<div class="space-y-4"><div><label class="lbl">Title</label><input id="ntTitle" class="inp" value="' + D.esc(item ? displayName(item) : '') + '" placeholder="Note title"></div>' +
      '<div><label class="lbl">Note</label><textarea id="ntBody" class="inp" style="min-height:180px" placeholder="Write your note here…">' + D.esc(item ? (item.description || '') : '') + '</textarea></div>' +
      '<div><label class="lbl">Tags (comma separated)</label><input id="ntTags" class="inp" value="' + D.esc(item ? (item.tags || []).join(', ') : '') + '"></div>' +
      '<div><label class="lbl">Save to folder</label><select id="ntFolder" class="inp"><option value="">All Files (no folder)</option>' + folderOptionsHtml(item ? item.folderId : '') + '</select></div>' +
      '<button type="button" class="btn-primary w-full" id="ntSaveBtn">' + (isEdit ? 'Save Changes' : '💾 Save Note') + '</button></div>');
    document.getElementById('ntSaveBtn').addEventListener('click', function () {
      var title = document.getElementById('ntTitle').value.trim();
      var body = document.getElementById('ntBody').value;
      if (!title && !body.trim()) { toast('Write a title or some text first.', 'err'); return; }
      if (isEdit) {
        item.title = title || 'Untitled note'; item.description = body;
        item.tags = document.getElementById('ntTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        item.folderId = document.getElementById('ntFolder').value || null; item.updatedAt = Date.now();
        D.logActivity(db, 'note_edited', 'Edited note: ' + item.title);
      } else {
        db.items.push({
          id: D.uid(), userId: me().id, kind: 'note', folderId: document.getElementById('ntFolder').value || null,
          title: title || 'Untitled note', customName: '', description: body,
          tags: document.getElementById('ntTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
          platform: '', originalUrl: '', thumbnail: '', favicon: '', fileName: '', fileType: '', fileSize: 0, mime: 'text/plain',
          createdAt: Date.now(), updatedAt: Date.now(), isFavourite: false, isDeleted: false, deletedAt: null, openedAt: null
        });
        D.logActivity(db, 'note_created', 'Created note: ' + (title || 'Untitled note'));
      }
      save(); closeModal(); renderView();
      toast(isEdit ? 'Note updated ✓' : 'Note saved ✓', 'ok');
    });
  }

  /* ----- Folders ----- */
  var FOLDER_ICONS = ['📁', '📂', '🎓', '💼', '🏛️', '🖼️', '🎬', '📸', '📝', '💰', '❤️', '✈️', '🎵', '📚'];
  var FOLDER_COLORS = ['#1769AA', '#2F8FE5', '#39BDEB', '#102A43', '#0F766E', '#7C3AED', '#E0245E', '#C13584', '#F5B301', '#DC2626', '#16A34A'];
  function folderModal(folder, parentId) {
    var isEdit = !!folder;
    openModal(modalHead(isEdit ? 'Edit Folder' : (parentId ? 'New Subfolder' : 'New Folder')) +
      '<div class="space-y-4"><div><label class="lbl">Folder name</label><input id="fdName" class="inp" value="' + D.esc(folder ? folder.name : '') + '" placeholder="e.g. College Notes"></div>' +
      '<div><label class="lbl">Icon</label><div class="flex flex-wrap gap-2" id="fdIcons">' + FOLDER_ICONS.map(function (ic, idx) {
        return '<button type="button" data-ic="' + ic + '" class="fd-ic text-2xl p-2 rounded-lg border-2 ' + ((folder ? folder.icon : FOLDER_ICONS[0]) === ic ? 'border-electric bg-blue-50 dark:bg-blue-900' : 'border-slate-200 dark:border-slate-700') + '">' + ic + '</button>';
      }).join('') + '</div></div>' +
      '<div><label class="lbl">Colour</label><div class="flex flex-wrap gap-2" id="fdColors">' + FOLDER_COLORS.map(function (c) {
        return '<button type="button" data-col="' + c + '" class="fd-col w-9 h-9 rounded-full border-2 ' + ((folder ? folder.color : FOLDER_COLORS[0]) === c ? 'border-navy dark:border-white scale-110' : 'border-transparent') + '" style="background:' + c + '"></button>';
      }).join('') + '</div></div>' +
      '<button type="button" class="btn-primary w-full" id="fdSaveBtn">' + (isEdit ? 'Save Changes' : 'Create Folder') + '</button></div>');
    var selIcon = folder ? folder.icon : FOLDER_ICONS[0];
    var selColor = folder ? folder.color : FOLDER_COLORS[0];
    document.querySelectorAll('.fd-ic').forEach(function (b) { b.addEventListener('click', function () { selIcon = b.dataset.ic; document.querySelectorAll('.fd-ic').forEach(function (x) { x.className = 'fd-ic text-2xl p-2 rounded-lg border-2 ' + (x.dataset.ic === selIcon ? 'border-electric bg-blue-50 dark:bg-blue-900' : 'border-slate-200 dark:border-slate-700'); }); }); });
    document.querySelectorAll('.fd-col').forEach(function (b) { b.addEventListener('click', function () { selColor = b.dataset.col; document.querySelectorAll('.fd-col').forEach(function (x) { x.className = 'fd-col w-9 h-9 rounded-full border-2 ' + (x.dataset.col === selColor ? 'border-navy dark:border-white scale-110' : 'border-transparent'); }); }); });
    document.getElementById('fdSaveBtn').addEventListener('click', function () {
      var name = document.getElementById('fdName').value.trim();
      if (!name) { toast('Please give the folder a name.', 'err'); return; }
      if (isEdit) {
        folder.name = name; folder.icon = selIcon; folder.color = selColor;
        D.logActivity(db, 'folder_edited', 'Renamed folder to ' + name);
      } else {
        db.folders.push({ id: D.uid(), userId: me().id, name: name, icon: selIcon, color: selColor, parentId: parentId || null, createdAt: Date.now(), isPrivate: false });
        D.logActivity(db, 'folder_created', 'Created folder: ' + name);
      }
      save(); closeModal(); renderView();
      toast(isEdit ? 'Folder updated ✓' : 'Folder created ✓', 'ok');
    });
  }
  function folderMenu(folderId) {
    var f = folderById(folderId);
    if (!f) return;
    openModal(modalHead(f.name, 'Folder options') +
      '<div class="space-y-1">' +
      '<button type="button" class="menu-item" data-fm="open">📂 Open folder</button>' +
      '<button type="button" class="menu-item" data-fm="sub">＋ New subfolder</button>' +
      '<button type="button" class="menu-item" data-fm="edit">✏️ Rename / change icon &amp; colour</button>' +
      '<button type="button" class="menu-item danger" data-fm="del">🗑️ Delete folder (items move to All Files)</button></div>');
    document.querySelectorAll('[data-fm]').forEach(function (b) {
      b.addEventListener('click', function () {
        closeModal();
        if (b.dataset.fm === 'open') { state.folderId = folderId; go('folders'); }
        else if (b.dataset.fm === 'sub') folderModal(null, folderId);
        else if (b.dataset.fm === 'edit') folderModal(f, f.parentId);
        else if (b.dataset.fm === 'del') {
          confirmModal('Delete folder “' + f.name + '”?', 'The folder will be deleted, but <b>its items are NOT deleted</b> — they move to All Files (no folder). Subfolders move up one level.', 'Delete Folder', function () {
            db.items.forEach(function (i) { if (i.folderId === folderId) i.folderId = null; });
            db.folders.forEach(function (x) { if (x.parentId === folderId) x.parentId = f.parentId || null; });
            db.folders = db.folders.filter(function (x) { return x.id !== folderId; });
            D.logActivity(db, 'folder_deleted', 'Deleted folder: ' + f.name + ' (items moved to All Files)');
            save(); renderView(); toast('Folder deleted — items moved to All Files.', 'ok');
          });
        }
      });
    });
  }

  /* ---------- item actions ---------- */
  function markOpened(item) {
    item.openedAt = Date.now();
    D.logActivity(db, 'item_opened', 'Opened ' + displayName(item));
    save();
  }
  function openItem(id) {
    var item = itemById(id);
    if (!item || item.isDeleted) return;
    markOpened(item);
    if (item.kind === 'link') {
      if (item.originalUrl) window.open(item.originalUrl, '_blank', 'noopener');
      else toast('This link has no URL saved.', 'err');
      renderView();
      return;
    }
    if (item.kind === 'note') { noteModal(item); renderView(); return; }
    // file preview
    var list = state.previewList = visibleItems(myItems()).filter(function (i) { return i.kind === 'file' && !i.isDeleted; });
    var idx = list.findIndex(function (i) { return i.id === id; });
    state.previewIdx = idx < 0 ? 0 : idx;
    showPreview();
    renderView();
  }
  function showPreview() {
    var item = state.previewList[state.previewIdx];
    if (!item) return;
    state.imgZoom = 1;
    var root = document.getElementById('previewRoot');
    var type = D.typeOf(item);
    root.innerHTML = '<div class="modal-bg" id="pvBg" style="align-items:center"><div class="modal-card wide !max-h-[94vh] flex flex-col">' +
      '<div class="flex items-start justify-between gap-2 mb-2"><div class="min-w-0"><h3 class="font-extrabold text-navy dark:text-white truncate">' + D.esc(displayName(item)) + '</h3>' +
      '<p class="text-xs text-slate-500">' + D.fmtSize(item.fileSize) + ' • ' + D.fmtDate(item.createdAt) + ' • ' + D.esc(item.fileType.toUpperCase() || type) + '</p></div>' +
      '<button type="button" class="btn-ghost shrink-0" id="pvClose">✕</button></div>' +
      '<div id="pvBody" class="flex-1 overflow-auto rounded-xl bg-slate-100 dark:bg-slate-900 grid place-items-center min-h-[16rem]"><p class="text-slate-500 p-6">⏳ Loading preview…</p></div>' +
      '<div class="flex flex-wrap items-center gap-2 mt-3">' +
      '<button type="button" class="btn-soft" id="pvPrev">← Prev</button><button type="button" class="btn-soft" id="pvNext">Next →</button>' +
      (type === 'image' ? '<button type="button" class="btn-soft" id="pvZoomOut">− Zoom</button><button type="button" class="btn-soft" id="pvZoomIn">+ Zoom</button><button type="button" class="btn-soft" id="pvFull">⛶ Fullscreen</button>' : '') +
      '<span class="ml-auto flex gap-2"><button type="button" class="btn-soft" id="pvDownload">⬇ Download</button><button type="button" class="btn-soft" id="pvMenu">⋯ More</button></span></div></div></div>';
    document.getElementById('pvBg').addEventListener('click', function (e) { if (e.target.id === 'pvBg') closePreview(); });
    document.getElementById('pvClose').addEventListener('click', closePreview);
    document.getElementById('pvPrev').addEventListener('click', function () { state.previewIdx = (state.previewIdx - 1 + state.previewList.length) % state.previewList.length; showPreview(); });
    document.getElementById('pvNext').addEventListener('click', function () { state.previewIdx = (state.previewIdx + 1) % state.previewList.length; showPreview(); });
    document.getElementById('pvDownload').addEventListener('click', function () { downloadItem(item.id); });
    document.getElementById('pvMenu').addEventListener('click', function () { closePreview(); itemMenu(item.id); });
    var zi = document.getElementById('pvZoomIn'), zo = document.getElementById('pvZoomOut'), fu = document.getElementById('pvFull');
    if (zi) zi.addEventListener('click', function () { state.imgZoom = Math.min(3, state.imgZoom + 0.25); applyZoom(); });
    if (zo) zo.addEventListener('click', function () { state.imgZoom = Math.max(0.5, state.imgZoom - 0.25); applyZoom(); });
    if (fu) fu.addEventListener('click', function () { var img = document.querySelector('#pvBody img'); if (img && img.requestFullscreen) img.requestFullscreen(); });
    var body = document.getElementById('pvBody');
    resolveFileBlob(item).then(function (blob) {
      if (!blob) { body.innerHTML = '<div class="text-center p-6"><p class="text-4xl">⚠️</p><p class="font-semibold mt-2">File data not found on this device</p><p class="text-sm text-slate-500">The file may have been removed from device storage. Try re-uploading it.</p></div>'; return; }
      var url = URL.createObjectURL(blob);
      if (type === 'image') body.innerHTML = '<img id="pvImg" src="' + url + '" class="max-w-full max-h-[60vh] object-contain transition-transform" alt="' + D.esc(displayName(item)) + '">';
      else if (type === 'video') body.innerHTML = '<video src="' + url + '" controls autoplay class="max-w-full max-h-[60vh] w-full"></video>';
      else if (type === 'audio') body.innerHTML = '<div class="p-8 w-full text-center"><div class="text-6xl mb-4">🎵</div><audio src="' + url + '" controls autoplay class="w-full max-w-md mx-auto"></audio></div>';
      else if (type === 'pdf') body.innerHTML = '<iframe src="' + url + '" class="w-full h-[60vh] bg-white" title="PDF preview"></iframe>';
      else if (['txt', 'json', 'html', 'md', 'csv'].indexOf(D.extOf(item.fileName || '')) >= 0) {
        blob.text().then(function (txt) { body.innerHTML = '<pre class="w-full h-[60vh] overflow-auto p-4 text-xs text-left whitespace-pre-wrap">' + D.esc(txt.slice(0, 200000)) + '</pre>'; });
      } else {
        body.innerHTML = '<div class="text-center p-8"><p class="text-5xl">' + D.typeIcon(item) + '</p><p class="font-semibold mt-3">No in-app preview for this file type</p><p class="text-sm text-slate-500 mt-1">Download it to open with another app on your device.</p><div class="flex gap-2 justify-center mt-4"><button type="button" class="btn-primary" onclick="SaveBoxUI.downloadItem(\'' + item.id + '\')">⬇ Download</button><button type="button" class="btn-outline" onclick="SaveBoxUI.openWith(\'' + item.id + '\')">Open With…</button></div></div>';
      }
    }).catch(function () { body.innerHTML = '<p class="text-red-600 p-6 font-semibold">Could not load this file from device storage.</p>'; });
  }
  function applyZoom() { var img = document.getElementById('pvImg'); if (img) img.style.transform = 'scale(' + state.imgZoom + ')'; }
  function closePreview() { document.getElementById('previewRoot').innerHTML = ''; }

  function toggleFavourite(id) {
    var item = itemById(id); if (!item) return;
    item.isFavourite = !item.isFavourite; item.updatedAt = Date.now(); save(); renderView();
    toast(item.isFavourite ? 'Added to Favourites ⭐' : 'Removed from Favourites', 'ok');
  }
  function itemMenu(id) {
    var item = itemById(id); if (!item) return;
    var rows = [
      ['open', '👁️ Open / Preview'], ['rename', '✏️ Rename'], ['edit', '📝 Edit details (title, tags, folder)'],
      ['replace', '🔄 Replace file'], ['download', '⬇️ Download'], ['share', '🔗 Share…'],
      ['dup', '⧉ Duplicate'], ['move', '📁 Move to folder'], ['copy', '📋 Copy to folder'],
      ['fav', item.isFavourite ? '☆ Remove from Favourites' : '⭐ Add to Favourites'],
      ['del', '🗑️ Move to Trash']
    ];
    if (item.kind !== 'file') rows = rows.filter(function (r) { return r[0] !== 'replace'; });
    if (item.kind === 'note') rows = rows.filter(function (r) { return ['replace', 'download'].indexOf(r[0]) < 0; });
    openModal(modalHead(displayName(item), (item.kind === 'link' ? (item.platform || 'Link') : D.typeOf(item)) + ' • ' + (item.kind === 'file' ? D.fmtSize(item.fileSize) : 'saved ' + D.fmtDateShort(item.createdAt))) +
      '<div class="space-y-1">' + rows.map(function (r) {
        return '<button type="button" class="menu-item' + (r[0] === 'del' ? ' danger' : '') + '" data-im="' + r[0] + '">' + r[1] + '</button>';
      }).join('') + '</div>');
    document.querySelectorAll('[data-im]').forEach(function (b) {
      b.addEventListener('click', function () {
        closeModal();
        var a = b.dataset.im;
        if (a === 'open') openItem(id);
        else if (a === 'rename') renameModal(item);
        else if (a === 'edit') editMetaModal(item);
        else if (a === 'replace') replaceFile(item);
        else if (a === 'download') downloadItem(id);
        else if (a === 'share') shareModal(id);
        else if (a === 'dup') duplicateItem(id);
        else if (a === 'move') moveCopyModal(item, false);
        else if (a === 'copy') moveCopyModal(item, true);
        else if (a === 'fav') toggleFavourite(id);
        else if (a === 'del') deleteItem(id);
      });
    });
  }
  function renameModal(item) {
    openModal(modalHead('Rename', displayName(item)) +
      '<div class="space-y-4"><div><label class="lbl">New name</label><input id="rnName" class="inp" value="' + D.esc(displayName(item)) + '"></div>' +
      '<button type="button" class="btn-primary w-full" id="rnSave">Save</button></div>');
    document.getElementById('rnSave').addEventListener('click', function () {
      var v = document.getElementById('rnName').value.trim();
      if (!v) { toast('Name cannot be empty.', 'err'); return; }
      item.customName = v; item.updatedAt = Date.now(); save(); closeModal(); renderView();
      toast('Renamed ✓', 'ok');
    });
  }
  function editMetaModal(item) {
    openModal(modalHead('Edit Details', displayName(item)) +
      '<div class="space-y-4">' +
      '<div><label class="lbl">Title</label><input id="emTitle" class="inp" value="' + D.esc(item.title || '') + '"></div>' +
      '<div><label class="lbl">Custom name (shown instead of title)</label><input id="emCustom" class="inp" value="' + D.esc(item.customName || '') + '"></div>' +
      '<div><label class="lbl">Description</label><textarea id="emDesc" class="inp">' + D.esc(item.description || '') + '</textarea></div>' +
      '<div><label class="lbl">Tags (comma separated)</label><input id="emTags" class="inp" value="' + D.esc((item.tags || []).join(', ')) + '"></div>' +
      '<div><label class="lbl">Folder</label><select id="emFolder" class="inp"><option value="">All Files (no folder)</option>' + folderOptionsHtml(item.folderId) + '</select></div>' +
      (item.kind === 'link' ? '<div><label class="lbl">Original URL</label><input id="emUrl" class="inp" value="' + D.esc(item.originalUrl || '') + '"></div>' : '') +
      '<button type="button" class="btn-primary w-full" id="emSave">Save Changes</button></div>');
    document.getElementById('emSave').addEventListener('click', function () {
      item.title = document.getElementById('emTitle').value.trim() || item.title;
      item.customName = document.getElementById('emCustom').value.trim();
      item.description = document.getElementById('emDesc').value.trim();
      item.tags = document.getElementById('emTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      item.folderId = document.getElementById('emFolder').value || null;
      if (item.kind === 'link') { var u = document.getElementById('emUrl').value.trim(); if (u) item.originalUrl = u; }
      item.updatedAt = Date.now(); save(); closeModal(); renderView();
      toast('Details saved ✓', 'ok');
    });
  }
  function replaceFile(item) {
    var inp = document.getElementById('hiddenFileInput');
    inp.value = '';
    inp.onchange = function () {
      var file = inp.files[0];
      if (!file) return;
      var ext = D.extOf(file.name);
      if (D.ALLOWED_EXTS.indexOf(ext) < 0) { toast('Not allowed: .' + ext + ' files cannot be uploaded.', 'err'); return; }
      if (file.size > D.MAX_FILE_BYTES) { toast('Too large — max 50 MB per file.', 'err'); return; }
      openModal(modalHead('Replace File', 'Uploading the new file first — the old file is only replaced after the new one saves successfully.') +
        '<div class="flex gap-2 items-center text-sm"><input type="checkbox" id="rpKeep" class="cb" checked> <label for="rpKeep">Keep existing filename (“' + D.esc(item.fileName || '') + '”)</label></div>' +
        '<div class="progress mt-4"><div id="rpBar" style="width:0%"></div></div><p id="rpStatus" class="text-sm text-slate-500 mt-2">Reading new file…</p>');
      var reader = new FileReader();
      reader.onprogress = function (e) { if (e.lengthComputable) document.getElementById('rpBar').style.width = Math.round(e.loaded / e.total * 100) + '%'; };
      reader.onerror = function () { document.getElementById('rpStatus').textContent = '❌ Read failed. Nothing was changed.'; };
      reader.onload = function () {
        var blob = new Blob([reader.result], { type: file.type || 'application/octet-stream' });
        var oldPath = item.storagePath || null;
        var keep = document.getElementById('rpKeep').checked;
        if (!keep) { item.fileName = file.name; item.title = file.name; }
        item.fileType = ext; item.fileSize = file.size; item.mime = file.type || '';
        item.updatedAt = Date.now();
        // Cloud first (v1.5.2): new content goes to the cloud when possible.
        maybeUploadToCloud(item, blob).then(function (where) {
          if (where === 'failed') { document.getElementById('rpStatus').textContent = '❌ Could not save the new file. Old file kept.'; return; }
          if (where === 'cloud') {
            // New content lives only in the cloud — drop the old device copy.
            D.blobDelete(item.id).catch(function () {});
            if (oldPath && oldPath !== item.storagePath) deleteCloudFile({ storagePath: oldPath });
          } else {
            // Device fallback: the item is device-only now.
            item.storagePath = null;
            if (oldPath) deleteCloudFile({ storagePath: oldPath });
          }
          D.logActivity(db, 'file_replaced', 'Replaced file: ' + displayName(item));
          save(); closeModal(); renderView();
          toast('File replaced ✓', 'ok');
        });
      };
      reader.readAsArrayBuffer(file);
    };
    inp.click();
  }
  function downloadItem(id) {
    var item = itemById(id); if (!item) return;
    if (item.kind === 'link') {
      if (item.originalUrl) window.open(item.originalUrl, '_blank', 'noopener');
      D.logActivity(db, 'download', 'Opened/downloaded link id=' + item.id + ' (' + displayName(item) + ')');
      save(); renderView(); return;
    }
    if (item.kind === 'note') {
      var blob = new Blob([item.title + '\n\n' + (item.description || '')], { type: 'text/plain' });
      triggerDownload(blob, (item.title || 'note').replace(/[^\w\- ]+/g, '') + '.txt');
      D.logActivity(db, 'download', 'Downloaded note id=' + item.id + ' (' + displayName(item) + ')');
      save(); renderView(); toast('Note downloaded ✓', 'ok'); return;
    }
    resolveFileBlob(item).then(function (blob) {
      if (!blob) { toast('File data not found on this device.', 'err'); return; }
      triggerDownload(blob, item.fileName || 'download');
      D.logActivity(db, 'download', 'Downloaded file id=' + item.id + ' (' + displayName(item) + ')');
      save(); renderView(); toast('Download started ✓', 'ok');
    });
  }
  function openWith(id) {
    var item = itemById(id); if (!item) return;
    resolveFileBlob(item).then(function (blob) {
      if (!blob) { toast('File data not found on this device.', 'err'); return; }
      var url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      toast('Opened in a new tab — use your browser\'s “Open with” / share options there.');
    });
  }
  function triggerDownload(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function duplicateItem(id) {
    var item = itemById(id); if (!item) return;
    var copy = JSON.parse(JSON.stringify(item));
    copy.id = D.uid(); copy.customName = (item.customName || item.title || '') + ' (copy)';
    copy.createdAt = Date.now(); copy.updatedAt = Date.now(); copy.isFavourite = false; copy.openedAt = null;
    db.items.push(copy);
    if (item.kind === 'file') {
      D.blobGet(item.id).then(function (blob) { if (blob) D.blobPut(copy.id, blob); });
    }
    D.logActivity(db, 'item_duplicated', 'Duplicated ' + displayName(item));
    save(); renderView(); toast('Duplicated ✓', 'ok');
  }
  function moveCopyModal(item, isCopy) {
    var pf = db.folders.find(function (f) { return f.userId === me().id && f.isPrivate; });
    openModal(modalHead((isCopy ? 'Copy to folder' : 'Move to folder'), displayName(item)) +
      '<div class="space-y-1">' +
      '<button type="button" class="menu-item" data-mf="">📂 All Files (no folder)</button>' +
      myFolders().map(function (f) {
        return '<button type="button" class="menu-item" data-mf="' + f.id + '">' + D.esc(f.icon || '📁') + ' ' + D.esc(f.isPrivate ? '🔒 Private Folder' : f.name) + '</button>';
      }).join('') + '</div>' +
      (pf ? '<p class="text-xs text-slate-500 mt-3">🔒 Items in the Private Folder are hidden from all other views until unlocked with your PIN.</p>' : ''));
    document.querySelectorAll('[data-mf]').forEach(function (b) {
      b.addEventListener('click', function () {
        var target = b.dataset.mf || null;
        if (isCopy) {
          var copy = JSON.parse(JSON.stringify(item));
          copy.id = D.uid(); copy.folderId = target; copy.createdAt = Date.now(); copy.updatedAt = Date.now(); copy.openedAt = null;
          db.items.push(copy);
          if (item.kind === 'file') D.blobGet(item.id).then(function (blob) { if (blob) D.blobPut(copy.id, blob); });
          D.logActivity(db, 'item_copied', 'Copied ' + displayName(item) + ' to ' + (target ? (folderById(target) || {}).name : 'All Files'));
          toast('Copied ✓', 'ok');
        } else {
          item.folderId = target; item.updatedAt = Date.now();
          D.logActivity(db, 'item_moved', 'Moved ' + displayName(item) + ' to ' + (target ? (folderById(target) || {}).name : 'All Files'));
          toast('Moved ✓', 'ok');
        }
        save(); closeModal(); renderView();
      });
    });
  }
  function deleteItem(id) {
    var item = itemById(id); if (!item) return;
    confirmModal('Move to Trash?', '“' + D.esc(displayName(item)) + '” will move to Trash. You can restore it from there.', 'Move to Trash', function () {
      item.isDeleted = true; item.deletedAt = Date.now(); state.selected.delete(id);
      D.logActivity(db, 'item_deleted', 'Moved to Trash: ' + displayName(item));
      save(); renderView(); toast('Moved to Trash 🗑️', 'ok');
    });
  }
  function restoreItem(id) {
    var item = itemById(id); if (!item) return;
    item.isDeleted = false; item.deletedAt = null;
    D.logActivity(db, 'item_restored', 'Restored: ' + displayName(item));
    save(); renderView(); toast('Restored ✓', 'ok');
  }
  function hardDeleteItem(id) {
    var item = itemById(id); if (!item) return;
    confirmModal('Delete forever?', '“' + D.esc(displayName(item)) + '” will be <b>permanently deleted</b> — its file and record are removed from this device and cannot be recovered. This cannot be undone.', 'Delete Forever', function () {
      deleteCloudFile(item);
      db.items = db.items.filter(function (i) { return i.id !== id; });
      if (item.kind === 'file') D.blobDelete(id);
      D.logActivity(db, 'item_hard_deleted', 'Permanently deleted: ' + displayName(item));
      save(); renderView(); toast('Permanently deleted.', 'ok');
    });
  }
  function trashAction(a) {
    var trash = db.items.filter(function (i) { return i.userId === me().id && i.isDeleted; });
    if (a === 'restoreAll') {
      trash.forEach(function (i) { i.isDeleted = false; i.deletedAt = null; });
      D.logActivity(db, 'trash_restored_all', 'Restored ' + trash.length + ' items from Trash');
      save(); renderView(); toast('All items restored ✓', 'ok');
    } else if (a === 'empty') {
      confirmModal('Empty Trash?', trash.length + ' item(s) will be <b>permanently deleted</b> — files and records removed from this device, cannot be recovered.', 'Empty Trash', function () {
        trash.forEach(function (i) { if (i.kind === 'file') { D.blobDelete(i.id); deleteCloudFile(i); } });
        db.items = db.items.filter(function (i) { return !(i.userId === me().id && i.isDeleted); });
        D.logActivity(db, 'trash_emptied', 'Emptied Trash (' + trash.length + ' items)');
        save(); renderView(); toast('Trash emptied.', 'ok');
      });
    }
  }
  function bulkAction(a) {
    var ids = Array.from(state.selected);
    if (!ids.length) return;
    if (a === 'clear') { state.selected.clear(); renderView(); return; }
    if (a === 'fav') {
      ids.forEach(function (id) { var it = itemById(id); if (it) it.isFavourite = true; });
      save(); state.selected.clear(); renderView(); toast(ids.length + ' item(s) added to Favourites ⭐', 'ok');
      return;
    }
    if (a === 'delete') {
      confirmModal('Move ' + ids.length + ' item(s) to Trash?', 'You can restore them from Trash later.', 'Move to Trash', function () {
        ids.forEach(function (id) { var it = itemById(id); if (it) { it.isDeleted = true; it.deletedAt = Date.now(); } });
        D.logActivity(db, 'bulk_delete', 'Moved ' + ids.length + ' items to Trash');
        save(); state.selected.clear(); renderView(); toast(ids.length + ' item(s) moved to Trash.', 'ok');
      });
      return;
    }
    if (a === 'tag') {
      openModal(modalHead('Add Tag', ids.length + ' item(s) selected') +
        '<div class="space-y-4"><div><label class="lbl">Tag</label><input id="bkTag" class="inp" placeholder="e.g. important"></div>' +
        '<button type="button" class="btn-primary w-full" id="bkAdd">Add Tag</button></div>');
      document.getElementById('bkAdd').addEventListener('click', function () {
        var tag = document.getElementById('bkTag').value.trim();
        if (!tag) { toast('Type a tag first.', 'err'); return; }
        ids.forEach(function (id) { var it = itemById(id); if (it) { it.tags = it.tags || []; if (it.tags.indexOf(tag) < 0) it.tags.push(tag); } });
        save(); closeModal(); state.selected.clear(); renderView(); toast('Tag added ✓', 'ok');
      });
      return;
    }
    if (a === 'move') {
      openModal(modalHead('Move ' + ids.length + ' item(s)', 'Choose a destination folder') +
        '<div class="space-y-1"><button type="button" class="menu-item" data-bmf="">📂 All Files (no folder)</button>' +
        myFolders().map(function (f) { return '<button type="button" class="menu-item" data-bmf="' + f.id + '">' + D.esc(f.icon || '📁') + ' ' + D.esc(f.isPrivate ? '🔒 Private Folder' : f.name) + '</button>'; }).join('') + '</div>');
      document.querySelectorAll('[data-bmf]').forEach(function (b) {
        b.addEventListener('click', function () {
          var target = b.dataset.bmf || null;
          ids.forEach(function (id) { var it = itemById(id); if (it) it.folderId = target; });
          D.logActivity(db, 'bulk_move', 'Moved ' + ids.length + ' items to ' + (target ? (folderById(target) || {}).name : 'All Files'));
          save(); closeModal(); state.selected.clear(); renderView(); toast('Moved ✓', 'ok');
        });
      });
    }
  }

  /* ---------- share ---------- */
  function shareModal(id) {
    var item = itemById(id); if (!item) return;
    var existing = db.shares.filter(function (s) { return s.itemId === id && !s.revoked; });
    openModal(modalHead('Share', displayName(item)) +
      '<div class="space-y-4">' +
      (item.kind === 'link' && item.originalUrl ? '<button type="button" class="btn-outline w-full" id="shCopyUrl">📋 Copy original link</button>' : '') +
      '<button type="button" class="btn-outline w-full" id="shNative">📤 Share via device…</button>' +
      '<div class="border-t border-slate-200 dark:border-slate-700 pt-4"><h4 class="font-bold text-sm mb-2">Private SaveBox share link</h4>' +
      '<p class="text-xs text-slate-500 mb-3">Anyone with this link can open the shared item page. Add an expiry and/or password for safety.</p>' +
      '<div class="grid grid-cols-2 gap-3"><div><label class="lbl">Expires</label><select id="shExpiry" class="inp"><option value="3600000">1 hour</option><option value="86400000" selected>1 day</option><option value="604800000">7 days</option><option value="2592000000">30 days</option><option value="0">Never</option></select></div>' +
      '<div><label class="lbl">Password (optional)</label><input id="shPass" class="inp" type="password" placeholder="Leave blank for none"></div></div>' +
      '<button type="button" class="btn-primary w-full mt-3" id="shCreate">🔗 Create Share Link</button></div>' +
      '<div id="shList">' + (existing.length ? '<h4 class="font-bold text-sm mt-2 mb-2">Active share links</h4>' + existing.map(function (s) {
        var url = location.origin + location.pathname + '#share=' + s.token;
        var expired = s.expiry && s.expiry < Date.now();
        return '<div class="card !shadow-none p-3 mb-2 text-sm"><p class="break-all text-xs">' + D.esc(url) + '</p><p class="text-xs text-slate-500 mt-1">' + (s.expiry ? (expired ? '⏰ Expired ' : 'Expires ') + D.fmtDate(s.expiry) : 'Never expires') + (s.passwordHash ? ' • 🔒 Password protected' : '') + '</p>' +
          '<div class="flex gap-2 mt-2"><button type="button" class="btn-soft" data-copy="' + D.esc(url) + '">Copy</button><button type="button" class="btn-soft danger" data-revoke="' + s.id + '">Revoke</button></div></div>';
      }).join('') : '') + '</div></div>');
    var cu = document.getElementById('shCopyUrl');
    if (cu) cu.addEventListener('click', function () { copyText(item.originalUrl); });
    document.getElementById('shNative').addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({ title: displayName(item), text: item.description || displayName(item), url: item.originalUrl || location.href }).catch(function () { /* user cancelled */ });
      } else { copyText(item.kind === 'link' ? item.originalUrl : location.origin + location.pathname); toast('Device share is not available here — link copied instead.'); }
    });
    document.querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyText(b.dataset.copy); }); });
    document.querySelectorAll('[data-revoke]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = db.shares.find(function (x) { return x.id === b.dataset.revoke; });
        if (s) { s.revoked = true; D.logActivity(db, 'share_revoked', 'Revoked share link for ' + displayName(item)); save(); closeModal(); shareModal(id); toast('Share link revoked.', 'ok'); }
      });
    });
    document.getElementById('shCreate').addEventListener('click', function () {
      var expMs = Number(document.getElementById('shExpiry').value);
      var pass = document.getElementById('shPass').value;
      var share = { id: D.uid(), itemId: id, token: D.uid().replace('id_', '') + Math.random().toString(36).slice(2, 8), expiry: expMs ? Date.now() + expMs : 0, passwordHash: '', createdAt: Date.now(), revoked: false };
      var done = function () {
        db.shares.push(share);
        D.logActivity(db, 'share_created', 'Created share link for ' + displayName(item));
        save();
        var url = location.origin + location.pathname + '#share=' + share.token;
        copyText(url);
        closeModal(); shareModal(id);
        toast('Share link created & copied ✓', 'ok');
      };
      if (pass) D.sha256Hex(pass).then(function (h) { share.passwordHash = h; done(); });
      else done();
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied to clipboard ✓', 'ok'); }).catch(function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard ✓', 'ok'); } catch (e) { toast('Copy failed — long-press to copy manually.', 'err'); }
    ta.remove();
  }

  /* ---------- WebAuthn (device fingerprint / face) ---------- */
  // Real device biometrics: the fingerprint/face never leaves the device.
  // SaveBox only stores the credential ID (webauthnCredId) on this device.
  function b64urlEncode(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function webauthnApiAvailable() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create && navigator.credentials.get);
  }
  var _waSupport = null;
  function webauthnSupport() {
    if (_waSupport) return _waSupport;
    _waSupport = Promise.resolve().then(function () {
      if (!webauthnApiAvailable()) return { api: false, platform: false };
      if (window.PublicKeyCredential && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
        return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function (ok) {
          return { api: true, platform: !!ok };
        }).catch(function () { return { api: true, platform: false }; });
      }
      return { api: true, platform: false };
    });
    return _waSupport;
  }
  function enrollFingerprint() {
    return webauthnSupport().then(function (sup) {
      if (!sup.api) throw new Error('unsupported');
      if (!sup.platform) throw new Error('no-platform-authenticator');
      var challenge = new Uint8Array(32); crypto.getRandomValues(challenge);
      var userId = new Uint8Array(16); crypto.getRandomValues(userId);
      var u = me();
      return navigator.credentials.create({ publicKey: {
        challenge: challenge,
        rp: { name: 'SaveBox', id: location.hostname },
        user: { id: userId, name: u.email, displayName: u.name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000, attestation: 'none'
      } }).then(function (cred) {
        db.settings.webauthnCredId = b64urlEncode(cred.rawId);
        D.logActivity(db, 'fingerprint_enrolled', 'Fingerprint / face unlock enrolled');
        save();
        return true;
      });
    });
  }
  function verifyFingerprint() {
    if (!db.settings.webauthnCredId) return Promise.resolve(false);
    var challenge = new Uint8Array(32); crypto.getRandomValues(challenge);
    return navigator.credentials.get({ publicKey: {
      challenge: challenge,
      allowCredentials: [{ id: b64urlDecode(db.settings.webauthnCredId), type: 'public-key', transports: ['internal'] }],
      userVerification: 'required', timeout: 60000
    } }).then(function () { return true; }).catch(function () { return false; });
  }

  /* ---------- lock modes (spec §12) ---------- */
  var LOCK_MODES = {
    pin: { label: 'PIN only', needs: ['pin'] },
    password: { label: 'Password only', needs: ['password'] },
    fingerprint: { label: 'Fingerprint only', needs: ['fingerprint'] },
    fingerprint_pin: { label: 'Fingerprint + PIN', needs: ['fingerprint', 'pin'] },
    fingerprint_password: { label: 'Fingerprint + Password', needs: ['fingerprint', 'password'] }
  };
  function lockMethodSet(m) {
    if (m === 'pin') return !!db.settings.pinHash;
    if (m === 'password') return !!db.settings.passwordLockHash;
    if (m === 'fingerprint') return !!db.settings.webauthnCredId;
    return false;
  }
  function hasLockMethod() { return lockMethodSet('pin') || lockMethodSet('password') || lockMethodSet('fingerprint'); }
  function lockModeReady(mode) { var m = LOCK_MODES[mode] || LOCK_MODES.pin; return m.needs.every(lockMethodSet); }
  function activeLockMethods() { var m = LOCK_MODES[db.settings.lockMode] || LOCK_MODES.pin; return m.needs; }
  function lockMethodName(m) { return m === 'pin' ? 'a PIN' : m === 'password' ? 'an app-lock password' : 'fingerprint'; }

  function passwordLockModal() {
    var s = db.settings;
    openModal(modalHead(s.passwordLockHash ? 'Change App-Lock Password' : 'Set App-Lock Password', 'A separate password just for unlocking SaveBox — stored only as a secure hash, never as plain text.') +
      '<div class="space-y-4">' +
      (s.passwordLockHash ? '<div><label class="lbl">Current app-lock password</label><input id="lpCurrent" class="inp" type="password" placeholder="Current app-lock password"></div>' : '') +
      '<div><label class="lbl">New app-lock password (min 6 characters)</label><input id="lpNew" class="inp" type="password" placeholder="Choose a password"></div>' +
      '<div><label class="lbl">Confirm new password</label><input id="lpConfirm" class="inp" type="password" placeholder="Repeat password"></div>' +
      '<p id="lpErr" class="err hidden"></p>' +
      '<button type="button" class="btn-primary w-full" id="lpSave">Save Password</button></div>');
    document.getElementById('lpSave').addEventListener('click', function () {
      var err = document.getElementById('lpErr');
      var np = document.getElementById('lpNew').value;
      var cp = document.getElementById('lpConfirm').value;
      if (!np || np.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.classList.remove('hidden'); return; }
      if (np !== cp) { err.textContent = 'Passwords do not match.'; err.classList.remove('hidden'); return; }
      var apply = function () {
        D.sha256Hex(np).then(function (h) {
          db.settings.passwordLockHash = h;
          D.logActivity(db, 'lock_password_set', 'App-lock password set');
          save(); closeModal(); renderView();
          toast('App-lock password saved ✓', 'ok');
        });
      };
      if (s.passwordLockHash) {
        var cur = document.getElementById('lpCurrent').value;
        D.sha256Hex(cur).then(function (h) {
          if (h !== s.passwordLockHash) { err.textContent = 'Current app-lock password is wrong.'; err.classList.remove('hidden'); return; }
          apply();
        });
      } else apply();
    });
  }

  function lockSetupModal(initialSel) {
    var preSel = initialSel || db.settings.lockMode;
    openModal(modalHead('Lock Type & Setup', 'Choose how SaveBox locks. Fingerprint uses your device biometrics — SaveBox never sees or stores your fingerprint, only a credential ID on this device.') +
      '<div id="lockSetupBody"><p class="text-sm text-slate-500">Checking device support…</p></div>');
    webauthnSupport().then(function (sup) {
      var body = document.getElementById('lockSetupBody'); if (!body) return;
      var sel = preSel;
      var fpNote = !sup.api ? '⚠️ WebAuthn is not available in this browser — Fingerprint options are disabled here.'
        : !sup.platform ? '⚠️ This device/browser has no platform authenticator (no fingerprint or face unlock available) — Fingerprint options are disabled here.'
        : (db.settings.webauthnCredId ? '✓ Fingerprint is enrolled on this device.' : '✓ This device supports fingerprint / face unlock.');
      var rows = Object.keys(LOCK_MODES).map(function (key) {
        var m = LOCK_MODES[key];
        var ready = lockModeReady(key);
        var disabled = m.needs.indexOf('fingerprint') >= 0 && !sup.platform;
        var needTxt = m.needs.map(function (n) { return n === 'pin' ? 'PIN' : n === 'password' ? 'Password' : 'Fingerprint'; }).join(' + ');
        return '<button type="button" class="lock-opt' + (sel === key ? ' active' : '') + '"' + (disabled ? ' disabled' : '') + ' data-mode="' + key + '">' +
          '<span class="lock-opt-ic">' + (key.indexOf('fingerprint') === 0 ? '👆' : key === 'password' ? '🔑' : '🔢') + '</span>' +
          '<span class="min-w-0"><span class="block font-bold text-sm">' + m.label + '</span>' +
          '<span class="block text-xs text-slate-500">Needs: ' + needTxt + ' • ' + (ready ? '✓ Ready' : '✗ Not set up yet') + '</span></span>' +
          '<span class="ml-auto text-lg">' + (sel === key ? '●' : '○') + '</span></button>';
      }).join('');
      body.innerHTML = '<p class="text-xs text-slate-500 mb-3">' + fpNote + '</p>' + rows +
        '<div class="flex flex-wrap gap-2 mt-4">' +
        '<button type="button" class="btn-soft" id="lsPin">' + (db.settings.pinHash ? 'Change PIN' : 'Set PIN') + '</button>' +
        '<button type="button" class="btn-soft" id="lsPass">' + (db.settings.passwordLockHash ? 'Change Password' : 'Set Password') + '</button>' +
        '<button type="button" class="btn-soft" id="lsFp"' + ((!sup.api || !sup.platform) ? ' disabled' : '') + '>' + (db.settings.webauthnCredId ? 'Re-enroll Fingerprint' : 'Enroll Fingerprint') + '</button></div>' +
        '<p id="lsErr" class="err hidden mt-3"></p>' +
        '<button type="button" class="btn-primary w-full mt-4" id="lsSave">Save Lock Type</button>';
      body.querySelectorAll('[data-mode]').forEach(function (b) {
        b.addEventListener('click', function () { lockSetupModal(b.dataset.mode); });
      });
      document.getElementById('lsPin').addEventListener('click', function () { pinSetupModal(false); });
      document.getElementById('lsPass').addEventListener('click', function () { passwordLockModal(); });
      var fpBtn = document.getElementById('lsFp');
      if (fpBtn) fpBtn.addEventListener('click', function () {
        enrollFingerprint().then(function () { toast('Fingerprint enrolled ✓ — you can now unlock with your fingerprint.', 'ok'); lockSetupModal(); })
          .catch(function (e) {
            var msg = (e && e.message === 'no-platform-authenticator') ? 'This device has no fingerprint / face unlock to enroll.' :
              (e && e.message === 'unsupported') ? 'WebAuthn is not supported in this browser.' :
              'Fingerprint enrollment was cancelled or failed. Try again.';
            toast(msg, 'err');
          });
      });
      document.getElementById('lsSave').addEventListener('click', function () {
        var err = document.getElementById('lsErr');
        if (!lockModeReady(sel)) {
          err.textContent = 'Set up ' + LOCK_MODES[sel].needs.filter(function (n) { return !lockMethodSet(n); }).map(lockMethodName).join(' and ') + ' first (buttons above).';
          err.classList.remove('hidden'); return;
        }
        db.settings.lockMode = sel;
        D.logActivity(db, 'lock_mode', 'Lock type set to ' + LOCK_MODES[sel].label);
        save(); closeModal(); renderView();
        toast('Lock type saved: ' + LOCK_MODES[sel].label + ' ✓', 'ok');
      });
    });
  }

  /* ---------- private folder / PIN / app lock ---------- */
  function ensurePrivateFolder() {
    var pf = db.folders.find(function (f) { return f.userId === me().id && f.isPrivate; });
    if (!pf) {
      pf = { id: D.uid(), userId: me().id, name: 'Private Folder', icon: '🔒', color: '#102A43', parentId: null, createdAt: Date.now(), isPrivate: true };
      db.folders.push(pf);
    }
    return pf;
  }
  function unlockPrivate() {
    // Any single configured method unlocks the Private Folder.
    var methods = [];
    if (db.settings.pinHash) methods.push('pin');
    if (db.settings.passwordLockHash) methods.push('password');
    if (db.settings.webauthnCredId) methods.push('fingerprint');
    if (!methods.length) { toast('Set a PIN, password or fingerprint first (Settings → Security → Lock Type & Setup).', 'err'); return; }
    openModal(modalHead('Unlock Private Folder', 'Use any method you have set up.') +
      '<div class="space-y-3">' +
      (methods.indexOf('fingerprint') >= 0 ? '<button type="button" class="btn-primary w-full" id="upFp">👆 Unlock with Fingerprint / Face</button>' : '') +
      (methods.indexOf('pin') >= 0 ? '<div><label class="lbl">PIN (' + db.settings.pinLength + ' digits)</label><div class="flex gap-2"><input id="upPin" type="password" inputmode="numeric" class="inp" placeholder="PIN" maxlength="8"><button type="button" class="btn-primary shrink-0" id="upPinGo">Unlock</button></div></div>' : '') +
      (methods.indexOf('password') >= 0 ? '<div><label class="lbl">App-lock password</label><div class="flex gap-2"><input id="upPass" type="password" class="inp" placeholder="App-lock password"><button type="button" class="btn-primary shrink-0" id="upPassGo">Unlock</button></div></div>' : '') +
      '<p id="upErr" class="err hidden"></p></div>');
    var ok = function () {
      state.privateUnlocked = true;
      D.logActivity(db, 'private_unlocked', 'Private Folder unlocked');
      save(); closeModal(); renderView(); toast('Private Folder unlocked 🔓', 'ok');
    };
    var showErr = function () { var e = document.getElementById('upErr'); if (e) { e.textContent = 'That did not match — try again.'; e.classList.remove('hidden'); } };
    var fpBtn = document.getElementById('upFp');
    if (fpBtn) fpBtn.addEventListener('click', function () { verifyFingerprint().then(function (ok2) { ok2 ? ok() : showErr(); }); });
    var pinGo = document.getElementById('upPinGo');
    if (pinGo) pinGo.addEventListener('click', function () {
      D.sha256Hex(document.getElementById('upPin').value.trim()).then(function (h) { if (h === db.settings.pinHash) ok(); else showErr(); });
    });
    var passGo = document.getElementById('upPassGo');
    if (passGo) passGo.addEventListener('click', function () {
      D.sha256Hex(document.getElementById('upPass').value).then(function (h) { if (h === db.settings.passwordLockHash) ok(); else showErr(); });
    });
  }

  function pinSetupModal(forPrivate) {
    var s = db.settings;
    openModal(modalHead(forPrivate ? 'Set up Private Folder' : (s.pinHash ? 'Change PIN' : 'Set PIN'), 'Your PIN is stored only as a secure hash on this device — never as plain text.') +
      '<div class="space-y-4">' +
      (s.pinHash ? '<div><label class="lbl">Current PIN</label><input id="pinCurrent" class="inp" type="password" inputmode="numeric" maxlength="8" placeholder="Current PIN"></div>' : '') +
      '<div><label class="lbl">PIN length</label><select id="pinLen" class="inp"><option value="4">4 digits</option><option value="6">6 digits</option><option value="custom">Custom (4–8 digits)</option></select></div>' +
      '<div id="pinCustomWrap" class="hidden"><label class="lbl">Custom length (4–8)</label><input id="pinCustomLen" class="inp" type="number" min="4" max="8" value="5"></div>' +
      '<div><label class="lbl">New PIN (numbers only)</label><input id="pinNew" class="inp" type="password" inputmode="numeric" maxlength="8" placeholder="e.g. 2468"></div>' +
      '<div><label class="lbl">Confirm new PIN</label><input id="pinConfirm" class="inp" type="password" inputmode="numeric" maxlength="8" placeholder="Repeat PIN"></div>' +
      '<p id="pinErr" class="err hidden"></p>' +
      '<button type="button" class="btn-primary w-full" id="pinSave">Save PIN</button></div>');
    document.getElementById('pinLen').addEventListener('change', function (e) {
      document.getElementById('pinCustomWrap').classList.toggle('hidden', e.target.value !== 'custom');
    });
    document.getElementById('pinSave').addEventListener('click', function () {
      var err = document.getElementById('pinErr');
      var lenSel = document.getElementById('pinLen').value;
      var len = lenSel === 'custom' ? Number(document.getElementById('pinCustomLen').value) : Number(lenSel);
      if (!len || len < 4 || len > 8) { err.textContent = 'PIN length must be between 4 and 8 digits.'; err.classList.remove('hidden'); return; }
      var np = document.getElementById('pinNew').value.trim();
      var cp = document.getElementById('pinConfirm').value.trim();
      if (!/^\d+$/.test(np) || np.length !== len) { err.textContent = 'PIN must be exactly ' + len + ' digits (numbers only).'; err.classList.remove('hidden'); return; }
      if (np !== cp) { err.textContent = 'PINs do not match.'; err.classList.remove('hidden'); return; }
      var apply = function () {
        D.sha256Hex(np).then(function (h) {
          db.settings.pinHash = h; db.settings.pinLength = len;
          if (forPrivate) { ensurePrivateFolder(); db.settings.privateFolderEnabled = true; }
          D.logActivity(db, 'pin_set', 'PIN ' + (forPrivate ? 'set for Private Folder' : 'updated'));
          save(); closeModal(); renderView();
          toast(forPrivate ? 'Private Folder is ready 🔒' : 'PIN saved ✓', 'ok');
        });
      };
      if (s.pinHash) {
        var cur = document.getElementById('pinCurrent').value.trim();
        D.sha256Hex(cur).then(function (h) {
          if (h !== s.pinHash) { err.textContent = 'Current PIN is wrong.'; err.classList.remove('hidden'); return; }
          apply();
        });
      } else apply();
    });
  }
  function toggleAppLock() {
    var s = db.settings;
    if (s.appLockEnabled) {
      s.appLockEnabled = false; save(); renderView(); toast('App lock disabled.');
      return;
    }
    if (!hasLockMethod()) { lockSetupModal(); toast('Set up a lock method first (PIN, password or fingerprint).'); return; }
    if (!lockModeReady(s.lockMode)) { lockSetupModal(); toast('Your lock type needs setup first — finish it in Lock Type & Setup.'); return; }
    s.appLockEnabled = true; save(); renderView();
    toast('App lock enabled 🔐 — SaveBox will ask for your ' + (LOCK_MODES[s.lockMode] || LOCK_MODES.pin).label.toLowerCase() + ' when it locks.', 'ok');
  }
  function autoLockModal() {
    var opts = [['immediately', 'Immediately'], ['30s', '30 seconds'], ['1m', '1 minute'], ['5m', '5 minutes'], ['background', 'On background (when tab/app is hidden)']];
    openModal(modalHead('Auto-lock', 'When should SaveBox lock itself?') +
      '<div class="space-y-1">' + opts.map(function (o) {
        return '<button type="button" class="menu-item" data-al="' + o[0] + '">' + (db.settings.autoLock === o[0] ? '● ' : '○ ') + o[1] + '</button>';
      }).join('') + '</div>');
    document.querySelectorAll('[data-al]').forEach(function (b) {
      b.addEventListener('click', function () {
        db.settings.autoLock = b.dataset.al; save(); closeModal(); renderView(); armAutoLock();
        toast('Auto-lock set: ' + b.textContent.trim(), 'ok');
      });
    });
  }
  function armAutoLock() {
    clearTimeout(state.lockTimer);
    if (!db.settings.appLockEnabled || !hasLockMethod()) return;
    var ms = { immediately: 0, '30s': 30000, '1m': 60000, '5m': 300000, background: 0 }[db.settings.autoLock];
    if (ms) state.lockTimer = setTimeout(function () { showLockScreen(); }, ms);
  }
  function showLockScreen() {
    if (!db.settings.appLockEnabled || !hasLockMethod()) return;
    var methods = activeLockMethods();
    var step = 0;
    var root = document.getElementById('lockRoot');
    function methodLabel(m) {
      return m === 'pin' ? db.settings.pinLength + '-digit PIN' : m === 'password' ? 'app-lock password' : 'fingerprint / face';
    }
    function renderStep() {
      var m = methods[step];
      var body = '';
      if (m === 'pin') {
        body = '<div class="flex justify-center gap-3 my-5" id="lockDots">' + Array.from({ length: db.settings.pinLength }, function () { return '<span class="pin-dot"></span>'; }).join('') + '</div>' +
          '<div class="grid grid-cols-3 gap-3 max-w-[15rem] mx-auto">' +
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, '⌫'].map(function (k) { return '<button type="button" class="pin-key" data-k="' + k + '">' + k + '</button>'; }).join('') + '</div>';
      } else if (m === 'password') {
        body = '<div class="my-5"><input id="lockPassInput" type="password" class="inp !bg-white/10 !border-white/30 !text-white text-center" placeholder="App-lock password" autocomplete="off">' +
          '<button type="button" class="btn-primary w-full mt-3" id="lockPassGo">Unlock</button></div>';
      } else {
        body = '<div class="my-6"><button type="button" class="fp-btn" id="lockFpGo">👆<span>Use Fingerprint / Face</span></button>' +
          '<p class="text-xs text-blue-100 mt-3">Touch your fingerprint sensor or look at the camera when asked.</p></div>';
      }
      root.innerHTML = '<div class="lock-screen"><div class="w-full max-w-xs text-center text-white">' +
        '<div class="flex justify-center">' + LOGO_SVG + '</div>' +
        '<h2 class="text-2xl font-extrabold mt-3">SaveBox is locked</h2>' +
        '<p class="text-sm text-blue-100 mt-1">Step ' + (step + 1) + ' of ' + methods.length + ' — unlock with your ' + methodLabel(m) + '</p>' + body +
        '<p id="lockErr" class="err !text-yellow-200 hidden mt-3 font-semibold"></p>' +
        '<button type="button" class="underline text-sm mt-4 text-blue-100" id="lockForgot">Forgot? Unlock with account password</button>' +
        '<button type="button" class="underline text-xs mt-2 text-blue-100/80 block mx-auto" id="lockSignOut">Sign out &amp; switch account</button>' +
        '</div></div>';
      bindStep(m);
    }
    function fail(msg) { var e = document.getElementById('lockErr'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } }
    function next() {
      step++;
      if (step >= methods.length) {
        root.innerHTML = ''; state.lastActivity = Date.now(); armAutoLock();
        toast('Unlocked ✓', 'ok');
      } else renderStep();
    }
    function bindStep(m) {
      if (m === 'pin') {
        var entered = '';
        var paint = function () { document.querySelectorAll('#lockDots .pin-dot').forEach(function (d, i) { d.classList.toggle('filled', i < entered.length); }); };
        root.querySelectorAll('[data-k]').forEach(function (b) {
          b.addEventListener('click', function () {
            var k = b.dataset.k;
            if (k === 'C') entered = '';
            else if (k === '⌫') entered = entered.slice(0, -1);
            else if (entered.length < db.settings.pinLength) entered += k;
            paint();
            if (entered.length === db.settings.pinLength) {
              D.sha256Hex(entered).then(function (h) {
                if (h === db.settings.pinHash) next();
                else { fail('Wrong PIN — try again.'); entered = ''; paint(); }
              });
            }
          });
        });
      } else if (m === 'password') {
        var go = function () {
          var v = document.getElementById('lockPassInput').value;
          D.sha256Hex(v).then(function (h) {
            if (h === db.settings.passwordLockHash) next();
            else fail('Wrong password — try again.');
          });
        };
        document.getElementById('lockPassGo').addEventListener('click', go);
        document.getElementById('lockPassInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        document.getElementById('lockPassInput').focus();
      } else {
        document.getElementById('lockFpGo').addEventListener('click', function () {
          verifyFingerprint().then(function (ok) {
            if (ok) next();
            else fail('Fingerprint did not match or was cancelled — try again.');
          });
        });
      }
      document.getElementById('lockForgot').addEventListener('click', forgotFlow);
      document.getElementById('lockSignOut').addEventListener('click', function () {
        confirmModal('Sign out?', 'This signs you out on this device. Your files and folders stay saved — sign in again to see them.', 'Sign out', function () {
          document.getElementById('lockRoot').innerHTML = '';
          logout();
        });
      });
    }
    function forgotFlow() {
      var u = me();
      if (u && u.firebaseUid) {
        openModal(modalHead('Forgot your lock?', 'Your account is a Firebase cloud account, so the lock resets by email.') +
          '<p class="text-sm text-slate-600 dark:text-slate-300 mb-4">We will send a password-reset email to <b>' + D.esc(u.email) + '</b>. After resetting your account password, sign in again and set up your lock in Settings → Security.</p>' +
          '<p id="fpErr" class="err hidden"></p><button type="button" class="btn-primary w-full" id="fpGo">Send Reset Email</button>');
        document.getElementById('fpGo').addEventListener('click', function () {
          FBx.resetPassword(u.email).then(function () { closeModal(); toast('Password reset email sent — check your inbox.', 'ok'); })
            .catch(function (e) { var err = document.getElementById('fpErr'); err.textContent = FBx.friendlyError(e); err.classList.remove('hidden'); });
        });
        return;
      }
      openModal(modalHead('Forgot your lock?', 'Enter your account password to reset your lock. Your files are never locked away with no recovery.') +
        '<div class="space-y-4"><div><label class="lbl">Account password (' + D.esc(u ? u.email : '') + ')</label><input id="fpPass" class="inp" type="password" placeholder="Your SaveBox password"></div>' +
        '<p id="fpErr" class="err hidden"></p><button type="button" class="btn-primary w-full" id="fpGo">Verify &amp; Reset Lock</button></div>');
      document.getElementById('fpGo').addEventListener('click', function () {
        D.sha256Hex(document.getElementById('fpPass').value).then(function (h) {
          if (!u || h !== u.passwordHash) { var e = document.getElementById('fpErr'); e.textContent = 'Wrong password.'; e.classList.remove('hidden'); return; }
          closeModal();
          document.getElementById('lockRoot').innerHTML = '';
          lockSetupModal();
          toast('Password verified — set up your lock again.');
        });
      });
    }
    renderStep();
  }

  /* ---------- profile / password / account ---------- */
  function saveProfile() {
    var u = me();
    var name = document.getElementById('pfName').value.trim();
    var email = document.getElementById('pfEmail').value.trim().toLowerCase();
    if (!name || !email || email.indexOf('@') < 0) { toast('Please enter a valid name and email.', 'err'); return; }
    if (email !== u.email && db.users.some(function (x) { return x.email === email; })) { toast('Another account already uses this email on this device.', 'err'); return; }
    u.name = name; u.email = email;
    D.logActivity(db, 'profile_updated', 'Profile updated');
    save(); enterApp(); toast('Profile saved ✓', 'ok');
  }
  function changePasswordModal() {
    if (FBx && FBx.ready && me() && me().firebaseUid) {
      openModal(modalHead('Change Password', 'Your account is a Firebase cloud account.') +
        '<p class="text-sm text-slate-600 dark:text-slate-300 mb-4">Cloud accounts reset their password by email. We’ll send a reset link to <b>' + D.esc(me().email) + '</b>.</p>' +
        '<p id="cpErr" class="err hidden"></p><button type="button" class="btn-primary w-full" id="cpGo">Send Reset Email</button>');
      document.getElementById('cpGo').addEventListener('click', function () {
        FBx.resetPassword(me().email).then(function () { closeModal(); toast('Password reset email sent — check your inbox.', 'ok'); })
          .catch(function (e) { var err = document.getElementById('cpErr'); err.textContent = FBx.friendlyError(e); err.classList.remove('hidden'); });
      });
      return;
    }
    openModal(modalHead('Change Password') +
      '<div class="space-y-4"><div><label class="lbl">Current password</label><input id="cpOld" class="inp" type="password"></div>' +
      '<div><label class="lbl">New password (min 6 characters)</label><input id="cpNew" class="inp" type="password"></div>' +
      '<p id="cpErr" class="err hidden"></p><button type="button" class="btn-primary w-full" id="cpGo">Change Password</button></div>');
    document.getElementById('cpGo').addEventListener('click', function () {
      var err = document.getElementById('cpErr');
      D.sha256Hex(document.getElementById('cpOld').value).then(function (h) {
        if (h !== me().passwordHash) { err.textContent = 'Current password is wrong.'; err.classList.remove('hidden'); return; }
        var np = document.getElementById('cpNew').value;
        if (np.length < 6) { err.textContent = 'New password must be at least 6 characters.'; err.classList.remove('hidden'); return; }
        D.sha256Hex(np).then(function (h2) { me().passwordHash = h2; D.logActivity(db, 'password_changed', 'Password changed'); save(); closeModal(); toast('Password changed ✓', 'ok'); });
      });
    });
  }
  function deleteAccountModal() {
    var u = me();
    var count = myItems().length;
    confirmModal('Delete your account?', 'This will <b>permanently delete</b> your account, all ' + count + ' saved item(s), folders, file data on this device, backups and share links' + (u.firebaseUid ? ' — including your Firebase cloud copy' : '') + '. <b>This cannot be undone.</b> If you want to keep anything, export or back up first (Settings → Backup).', 'Delete My Account Forever', function () {
      var uid = u.id;
      db.items.filter(function (i) { return i.userId === uid && i.kind === 'file'; }).forEach(function (i) { D.blobDelete(i.id); });
      db.users = db.users.filter(function (x) { return x.id !== uid; });
      db.folders = db.folders.filter(function (f) { return f.userId !== uid; });
      db.items = db.items.filter(function (i) { return i.userId !== uid; });
      db.shares = db.shares.filter(function (s) { return !db.items.some(function (i) { return i.id === s.itemId; }); });
      db.sessions = db.sessions.filter(function (s) { return s.userId !== uid; });
      if (FBx && FBx.ready && u.firebaseUid) { FBx.deleteUserDocs(u.firebaseUid); FBx.signOut(); }
      db.session.userId = null;
      save();
      document.getElementById('appView').classList.add('hidden');
      document.getElementById('authView').classList.remove('hidden');
      showAuthTab('login');
      toast('Account deleted. We\'re sorry to see you go.');
    });
  }
  function signOutOthers() {
    var u = me();
    var others = db.sessions.filter(function (s) { return s.userId === u.id && !s.current; }).length;
    db.sessions = db.sessions.filter(function (s) { return !(s.userId === u.id && !s.current); });
    D.logActivity(db, 'sessions_revoked', 'Signed out ' + others + ' other session(s)');
    save(); renderView();
    toast(others ? others + ' other session(s) signed out.' : 'No other sessions to sign out.', 'ok');
  }

  /* ---------- Cloud providers (MEGA only since v1.5.1) ----------
   * storagePath format for cloud files: "mega:<nodeHandle>". Every file
   * records its provider, so downloads and deletes always resolve to
   * the right cloud. Google Drive was removed in v1.5.1 per user order
   * (js/drive.js kept on disk, dormant, never loaded). Legacy "drive:"
   * files are no longer downloaded or deleted — they were never
   * created: Drive was never connected on any device. R2
   * ("r2:<uid>/<itemId>") stays supported for files uploaded before
   * v1.4.0, but R2 is dormant: the Worker was never deployed and no new
   * R2 uploads are made. Any failure leaves the file on the device and
   * it is retried on the next sync — never faked. */
  function megaReady() {
    return MegaX && MegaX.connected && MegaX.connected();
  }
  function anyCloudReady() { return megaReady(); }
  function cloudChain() {
    var c = db.settings.cloudChain;
    if (!Array.isArray(c)) c = db.settings.cloudChain = [];
    return c;
  }
  /* A provider that just connected goes first — it becomes the save
   * target for new uploads. */
  function cloudChainTouch(provider) {
    var c = cloudChain();
    var i = c.indexOf(provider);
    if (i >= 0) c.splice(i, 1);
    c.unshift(provider);
    save();
  }
  function cloudChainRemove(provider) {
    var c = cloudChain();
    var i = c.indexOf(provider);
    if (i >= 0) { c.splice(i, 1); save(); }
  }
  /* Try one provider for an upload: skip it when its cached free space
   * (quota, ~60 s cache like MEGA's) is smaller than the file; try the
   * upload anyway when the quota cannot be read. Resolves {path} on
   * success, {full:true} when the provider is full, {full:false} on any
   * other failure. */
  function cloudTryProvider(provider, item, blob) {
    if (provider !== 'mega') return Promise.resolve({ full: false });
    var client = MegaX;
    if (!client) return Promise.resolve({ full: false });
    var free = null;
    return client.quota().then(function (q) {
      free = (q.total || 0) - (q.used || 0);
    }).catch(function () { free = null; }).then(function () {
      if (free !== null && free < blob.size) return { full: true };
      return client.upload(item.id, blob, item.fileName || item.id).then(function (res) {
        return (res && res.path) ? { path: res.path } : { full: false };
      }).catch(function (e) {
        var msg = ((e && e.message) || '').toLowerCase();
        if (msg.indexOf('quota') >= 0 || msg.indexOf('full') >= 0 || msg.indexOf('storage') >= 0) return { full: true };
        return { full: false };
      });
    });
  }
  /* Upload a file blob to MEGA (the only cloud storage since v1.5.1).
   * Resolves {path} on success, {error:'full'} when MEGA is full,
   * {error:'failed'} when the upload failed, or {error:'none'} when
   * MEGA is not connected. */
  function uploadBlobToCloud(item, blob) {
    var providers = [];
    if (megaReady()) providers.push('mega');
    if (!providers.length) return Promise.resolve({ error: 'none' });
    var anyFull = false;
    var chain = Promise.resolve(null);
    providers.forEach(function (p) {
      chain = chain.then(function (done) {
        if (done) return done;
        return cloudTryProvider(p, item, blob).then(function (res) {
          if (res && res.path) return { path: res.path };
          if (res && res.full) anyFull = true;
          return null;
        });
      });
    });
    return chain.then(function (done) {
      if (done) return done;
      return { error: anyFull ? 'full' : 'failed' };
    });
  }
  function deleteCloudFile(item) {
    if (!item || !item.storagePath) return;
    if (item.storagePath.indexOf('mega:') === 0) {
      if (MegaX && MegaX.remove) MegaX.remove(item.storagePath.slice(5)).catch(function () { /* already gone */ });
      return;
    }
    if (item.storagePath.indexOf('r2:') !== 0) return;
    var parts = item.storagePath.slice(3).split('/');
    if (parts.length !== 2 || !R2x || !R2x.remove) return;
    R2x.remove(parts[0], parts[1]).catch(function () { /* already gone */ });
  }
  var lastFullToastAt = 0;
  /* v1.5.2 — CLOUD FIRST. Try the connected clouds FIRST. On cloud
   * success the file lives only in the cloud (no device copy is kept).
   * Only when every connected cloud is full, fails, or none is connected
   * is the blob stored on the device. Resolves 'cloud' | 'device' |
   * 'failed'. Existing device files are never migrated by this. */
  function maybeUploadToCloud(item, blob) {
    var u = me();
    if (!u) return Promise.resolve('failed');
    return uploadBlobToCloud(item, blob).then(function (res) {
      if (res && res.path) { item.storagePath = res.path; save(); return 'cloud'; }
      if (res && res.error === 'full') {
        var now = Date.now();
        if (now - lastFullToastAt > 10000) {
          lastFullToastAt = now;
          toast('MEGA storage is full — free space or connect another storage.', 'err');
        }
      }
      // Device is the last resort only.
      return D.blobPut(item.id, blob).then(function () { return 'device'; }).catch(function () { return 'failed'; });
    });
  }
  function resolveFileBlob(item) {
    return D.blobGet(item.id).then(function (blob) {
      if (blob) return blob;
      if (item.storagePath && item.storagePath.indexOf('mega:') === 0) {
        if (MegaX && MegaX.download) return MegaX.download(item.storagePath.slice(5)).catch(function () { return null; });
        return null;
      }
      if (item.storagePath && item.storagePath.indexOf('r2:') === 0) {
        var parts = item.storagePath.slice(3).split('/');
        if (parts.length === 2 && R2x && R2x.download) {
          return R2x.download(parts[0], parts[1]).catch(function () { return null; });
        }
        return null;
      }
      if (item.storagePath && FBx && FBx.ready) return FBx.getFileBlob(item.storagePath).catch(function () { return null; });
      return null;
    });
  }
  /* v1.5.3 — Firestore permission/auth failure detector. The raw
   * firestore message must never reach the user: it means the Google
   * session expired or the stored uid belongs to another account. */
  function isPermError(e) {
    if (!e) return false;
    if (e.code === 'permission-denied' || e.code === 'unauthenticated') return true;
    var m = String((e && e.message) || '').toLowerCase();
    return m.indexOf('insufficient permissions') >= 0 || m.indexOf('permission-denied') >= 0 || m.indexOf('missing or insufficient') >= 0;
  }
  function syncNow(showToast) {
    var u = me();
    if (!u) { if (showToast) toast('Sign in first.', 'err'); return; }
    /* v1.5.3 — the stored firebaseUid is NOT proof of a live session.
     * The Firebase session can expire (or the user can switch Google
     * accounts) while the stored uid stays behind; every Firestore call
     * then goes out unauthenticated or with a mismatched uid, the rules
     * deny it, and the old code showed that raw error in a red toast.
     * Only a LIVE Firebase user counts — its uid is the one Firestore
     * actually sees. */
    var liveUser = (FBx && FBx.ready && FBx.currentUser) ? FBx.currentUser() : null;
    var liveUid = liveUser ? liveUser.uid : null;
    var hadStoredUid = !!u.firebaseUid;
    if (liveUid && u.firebaseUid !== liveUid) { u.firebaseUid = liveUid; save(); }
    var fbOk = !!liveUid;
    if (!fbOk && hadStoredUid && FBx && FBx.ready) state.googleAuthNeeded = true; // session expired — offer Reconnect Google
    if (!fbOk && !anyCloudReady()) {
      if (showToast) toast(state.googleAuthNeeded
        ? 'Google sync needs sign-in again — your files are safe in MEGA. Reconnect Google in Settings → Cloud Sync.'
        : 'Cloud sync is not connected — connect MEGA in Settings → Cloud Sync (20 GB free).', 'err');
      if (state.googleAuthNeeded) renderView();
      return;
    }
    if (syncInProgress) { if (showToast) toast('Sync already running…'); return; }
    syncInProgress = true;
    var uid = liveUid; // live uid only — never the stored one
    var allFolders = db.folders.filter(function (f) { return f.userId === u.id; });
    var allItems = db.items.filter(function (i) { return i.userId === u.id; });
    // 1) upload file blobs that are not in the cloud yet (MEGA only)
    var fullFails = 0;
    var upJobs = allItems.filter(function (i) { return i.kind === 'file' && !i.isDeleted && !i.storagePath; }).map(function (item) {
      return D.blobGet(item.id).then(function (blob) {
        if (!blob) return;
        return uploadBlobToCloud(item, blob).then(function (res) {
          if (res && res.path) item.storagePath = res.path;
          else if (res && res.error === 'full') fullFails++;
        });
      }).catch(function () { /* keep on this device */ });
    });
    /* Shared tail for the MEGA-only branch: files are in the cloud,
     * metadata stays here. Used both when there is no live Google user
     * and when Firestore refuses the metadata (auth/permission). */
    function finishCloudOnly(msg, kind) {
      db.settings.lastCloudSync = Date.now();
      D.logActivity(db, 'cloud_sync', 'Cloud file sync complete' + (fullFails ? ' (' + fullFails + ' file(s) could not upload — all linked storages are full)' : ''));
      save(); syncInProgress = false; renderView();
      if (showToast) toast(msg || (fullFails ? 'Cloud files synced ✓ — but ' + fullFails + ' file(s) could not upload: all linked storages are full. Connect another storage or free space.' : 'Cloud files synced ✓'), kind || (fullFails ? 'err' : 'ok'));
    }
    Promise.all(upJobs).then(function () {
      if (!fbOk) { finishCloudOnly(); return null; }
      // 2) merge local metadata up to the cloud
      return FBx.syncUp(uid, allFolders, allItems).then(function (upRes) {
        if (upRes && upRes.skipped) {
          /* Some docs belong to another account (or the rules denied
           * them) — the rest still synced. Never fail the whole sync
           * over them, and never show the raw Firestore error. */
          state.googleAuthNeeded = true;
          finishCloudOnly('Google sync needs sign-in again — your files are safe in MEGA. (' + upRes.skipped + ' item(s) couldn\'t sync to Google.)', 'err');
          return null; // stop here: no syncDown after a denied syncUp
        }
        // 3) cloud is now the source of truth
        return FBx.syncDown(uid);
      });
    }).then(function (cloud) {
      if (!fbOk || !cloud) return; // cloud-only branch already finished above
      state.googleAuthNeeded = false; // a full Firestore round-trip worked — auth is healthy
      db.folders = db.folders.filter(function (f) { return f.userId !== u.id; }).concat(cloud.folders.map(function (f) { f.userId = u.id; return f; }));
      db.items = db.items.filter(function (i) { return i.userId !== u.id; }).concat(cloud.items.map(function (i) { i.userId = u.id; return i; }));
      db.settings.lastCloudSync = Date.now();
      D.logActivity(db, 'cloud_sync', 'Cloud sync complete: ' + cloud.folders.length + ' folders, ' + cloud.items.length + ' items' + (fullFails ? ' (' + fullFails + ' file(s) could not upload — all linked storages are full)' : ''));
      save(); syncInProgress = false; renderView();
      if (showToast) toast('Cloud sync complete ✓ (' + cloud.items.length + ' items)' + (fullFails ? ' — ' + fullFails + ' file(s) could not upload: all linked storages are full.' : ''), fullFails ? 'err' : 'ok');
    }).catch(function (e) {
      syncInProgress = false;
      if (isPermError(e)) {
        /* Auth/permission problem — the files uploaded to MEGA in
         * step 1 are safe. Fall back to MEGA-only and offer a
         * reconnect; never show the raw Firestore error. */
        state.googleAuthNeeded = true;
        D.logActivity(db, 'cloud_sync', 'Google sync needs sign-in again — files are safe in MEGA');
        save(); renderView();
        if (showToast) toast('Google sync needs sign-in again — your files are safe in MEGA. Tap “Reconnect Google” in Settings → Cloud Sync.', 'err');
        return;
      }
      if (showToast) toast((e && (e.code === 'unavailable' || /offline|network|failed to fetch/i.test(e.message || ''))) ? 'No internet connection — check your network and try again.' : 'Sync failed — please try again.', 'err');
    });
  }

  /* Show the 6-digit code box only when the user picked "2FA is on".
   * When "No 2FA" is picked the code box stays hidden (and empty), so
   * no 2FA code is ever sent for accounts that don't have it. */
  function toggleMega2fa() {
    var on = document.querySelector('input[name="mega2faMode"]:checked');
    var wrap = document.getElementById('mega2faWrap');
    if (!wrap) return;
    var show = !!(on && on.value === 'on');
    wrap.classList.toggle('hidden', !show);
    if (!show) { var c = document.getElementById('mega2fa'); if (c) c.value = ''; }
  }
  /* ---------- MEGA login / logout (Settings → Cloud Sync) ---------- */
  function megaLogin() {
    if (!MegaX || !MegaX.login) { toast('MEGA library failed to load — reload the app and try again.', 'err'); return; }
    var emEl = document.getElementById('megaEmail'), pwEl = document.getElementById('megaPass');
    var codeEl = document.getElementById('mega2fa');
    var remEl = document.getElementById('megaRemember');
    var errEl = document.getElementById('megaLoginErr');
    var email = emEl ? emEl.value : '', pass = pwEl ? pwEl.value : '';
    var modeEl = document.querySelector('input[name="mega2faMode"]:checked');
    var want2fa = !!(modeEl && modeEl.value === 'on');
    var code = (want2fa && codeEl) ? codeEl.value.trim() : '';
    var remember = !!(remEl && remEl.checked);
    if (errEl) errEl.classList.add('hidden');
    if (!email || !pass) {
      if (errEl) { errEl.textContent = 'Enter your MEGA email and password.'; errEl.classList.remove('hidden'); }
      return;
    }
    if (want2fa && !code) {
      if (errEl) { errEl.textContent = 'Enter the 6-digit two-step code, or choose “No 2FA” if your MEGA account has no 2FA.'; errEl.classList.remove('hidden'); }
      return;
    }
    toast('Connecting to MEGA…');
    MegaX.login(email, pass, remember, code).then(function (info) {
      if (pwEl) pwEl.value = '';
      if (codeEl) codeEl.value = '';
      cloudChainTouch('mega'); // newest-connected storage takes new uploads
      D.logActivity(db, 'mega_connected', 'MEGA connected as ' + info.email + ' (folder: SaveBox)');
      save(); renderView();
      toast('MEGA connected ✓ — files will upload to your SaveBox folder.', 'ok');
    }).catch(function (e) {
      var msg = (e && e.message) || 'Could not connect to MEGA.';
      var low = msg.toLowerCase();
      var need2fa = low.indexOf('two-factor') >= 0 || low.indexOf('2fa') >= 0 || low.indexOf('second factor') >= 0;
      if (need2fa) {
        /* MEGA asked for a code after all: switch to the "2FA is on"
         * option, reveal the code box and focus it. The password stays
         * filled so the retry works — it never leaves this page. */
        var onRadio = document.querySelector('input[name="mega2faMode"][value="on"]');
        if (onRadio) onRadio.checked = true;
        toggleMega2fa();
        if (errEl) { errEl.textContent = 'MEGA asked for your two-step code — enter the 6-digit code and tap Connect MEGA again.'; errEl.classList.remove('hidden'); }
        var cEl = document.getElementById('mega2fa');
        if (cEl) cEl.focus();
        return;
      }
      if (pwEl) pwEl.value = '';
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
      else toast(msg, 'err');
    });
  }
  function megaLogout() {
    if (MegaX && MegaX.logout) MegaX.logout();
    cloudChainRemove('mega');
    D.logActivity(db, 'mega_disconnected', 'MEGA disconnected');
    save(); renderView();
    toast('MEGA disconnected — files already in MEGA stay there; new files stay on this device.');
  }

  /* ---------- backup / restore / export ---------- */
  function downloadJson(obj, filename) {
    triggerDownload(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), filename);
  }
  function backupNow() {
    var u = me();
    var stamp = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var fname = 'savebox-backup-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + '.json';
    var files = [];
    var skipped = [];
    var fileItems = myItems().filter(function (i) { return i.kind === 'file' && !i.isDeleted; });
    var jobs = fileItems.map(function (item) {
      if ((item.fileSize || 0) > 10 * 1024 * 1024) { skipped.push({ id: item.id, name: item.fileName, reason: 'skipped — too large for JSON backup, re-upload manually' }); return Promise.resolve(); }
      return D.blobGet(item.id).then(function (blob) {
        if (!blob) { skipped.push({ id: item.id, name: item.fileName, reason: 'skipped — file data not found on device' }); return; }
        return blob.arrayBuffer().then(function (buf) {
          var bytes = new Uint8Array(buf), bin = '';
          for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
          files.push({ id: item.id, base64: btoa(bin) });
        });
      });
    });
    Promise.all(jobs).then(function () {
      var backup = {
        version: 'savebox-backup-v1', exportedAt: new Date().toISOString(),
        user: { email: u.email, name: u.name },
        folders: myFolders(), items: myItems(), files: files, skipped: skipped
      };
      var size = new Blob([JSON.stringify(backup)]).size;
      downloadJson(backup, fname);
      db.backups.push({ ts: Date.now(), name: fname, size: size });
      D.logActivity(db, 'backup_created', 'Backup created: ' + fname + ' (' + files.length + ' files, ' + skipped.length + ' skipped)');
      save(); renderView();
      toast('Backup downloaded ✓ (' + files.length + ' files included, ' + skipped.length + ' skipped)', 'ok');
    });
  }
  function restoreBackupPicker() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = function () {
      var file = inp.files[0]; if (!file) return;
      file.text().then(function (text) {
        var data;
        try { data = JSON.parse(text); } catch (e) { toast('That file is not a valid SaveBox backup (bad JSON).', 'err'); return; }
        if (data.version !== 'savebox-backup-v1' || !Array.isArray(data.items) || !Array.isArray(data.folders)) {
          toast('That file is not a SaveBox backup.', 'err'); return;
        }
        var restoredFolders = 0, restoredItems = 0, restoredFiles = 0, skipped = 0;
        (data.folders || []).forEach(function (f) {
          if (!db.folders.some(function (x) { return x.id === f.id; })) { f.userId = me().id; db.folders.push(f); restoredFolders++; }
        });
        var blobJobs = [];
        (data.items || []).forEach(function (it) {
          if (db.items.some(function (x) { return x.id === it.id; })) { skipped++; return; }
          it.userId = me().id; db.items.push(it); restoredItems++;
        });
        (data.files || []).forEach(function (f) {
          try {
            var bin = atob(f.base64), bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            blobJobs.push(D.blobPut(f.id, new Blob([bytes])).then(function () { restoredFiles++; }));
          } catch (e) { skipped++; }
        });
        Promise.all(blobJobs).then(function () {
          D.logActivity(db, 'backup_restored', 'Restored backup: ' + restoredItems + ' items, ' + restoredFolders + ' folders, ' + restoredFiles + ' files');
          save(); renderView();
          toast('Restore done: ' + restoredItems + ' items, ' + restoredFolders + ' folders, ' + restoredFiles + ' files restored, ' + skipped + ' skipped.', 'ok');
        });
      });
    };
    inp.click();
  }
  function exportLinks(format) {
    var links = myItems().filter(function (i) { return i.kind === 'link' && !i.isDeleted; });
    if (!links.length) { toast('No links to export yet.', 'err'); return; }
    if (format === 'csv') {
      var csv = 'Title,URL,Platform,Folder,Tags,Description,Saved On\n' + links.map(function (i) {
        var q = function (s) { return '"' + String(s || '').replace(/"/g, '""') + '"'; };
        return [q(displayName(i)), q(i.originalUrl), q(i.platform), q((folderById(i.folderId) || {}).name || ''), q((i.tags || []).join('; ')), q(i.description), q(new Date(i.createdAt).toISOString())].join(',');
      }).join('\n');
      triggerDownload(new Blob([csv], { type: 'text/csv' }), 'savebox-links.csv');
    } else {
      downloadJson({ exportedAt: new Date().toISOString(), count: links.length, links: links }, 'savebox-links.json');
    }
    D.logActivity(db, 'export_links', 'Exported ' + links.length + ' links as ' + format.toUpperCase());
    save(); toast('Links exported (' + links.length + ') ✓', 'ok');
  }
  function exportAccount() {
    var u = me();
    downloadJson({
      exportedAt: new Date().toISOString(), version: 'savebox-account-v1',
      user: { email: u.email, name: u.name, createdAt: u.createdAt },
      folders: myFolders(), items: myItems(), shares: db.shares, activity: db.activity.slice(0, 100)
    }, 'savebox-account-data.json');
    D.logActivity(db, 'export_account', 'Exported account data (metadata only)');
    save(); toast('Account data exported (metadata only) ✓', 'ok');
  }

  /* ---------- share-link landing (#share=token) ---------- */
  function handleShareHash() {
    var m = location.hash.match(/#share=([A-Za-z0-9_]+)/);
    if (!m) return;
    var share = db.shares.find(function (s) { return s.token === m[1]; });
    var item = share ? itemById(share.itemId) : null;
    var show = function (ok) {
      openModal(modalHead(ok ? 'Shared item' : 'Share link unavailable', ok ? '' : 'This link may be expired, revoked, or wrong.') +
        (ok ? '<div class="card !shadow-none p-4 flex gap-3 items-start"><span class="text-4xl">' + D.typeIcon(item) + '</span><div class="min-w-0"><p class="font-bold">' + D.esc(displayName(item)) + '</p><p class="text-sm text-slate-500 line-clamp-2">' + D.esc(item.description || '') + '</p><p class="text-xs text-slate-400 mt-1">' + D.esc(item.platform || D.typeOf(item)) + ' • shared via SaveBox</p></div></div>' +
          (item.kind === 'link' && item.originalUrl ? '<a class="btn-primary w-full text-center block mt-4" href="' + D.esc(item.originalUrl) + '" target="_blank" rel="noopener">Open Original Link →</a>' : '') +
          (item.kind === 'file' ? '<button type="button" class="btn-primary w-full mt-4" id="shDl">⬇ Download File</button>' : '') +
          (item.kind === 'note' ? '<pre class="bg-slate-100 dark:bg-slate-800 rounded-lg p-3 text-sm whitespace-pre-wrap mt-4">' + D.esc(item.description || '') + '</pre>' : '')
          : '<p class="text-sm text-slate-500">Ask the person who shared it for a fresh link.</p>') +
        '<button type="button" class="btn-outline w-full mt-3" onclick="SaveBoxUI.closeModal();SaveBoxUI.clearShareHash()">Close</button>');
      var dl = document.getElementById('shDl');
      if (dl) dl.addEventListener('click', function () { downloadItem(item.id); });
    };
    if (!share || share.revoked || !item || item.isDeleted || (share.expiry && share.expiry < Date.now())) { show(false); return; }
    if (share.passwordHash) {
      openModal(modalHead('Password-protected link', 'Enter the share password to view this item.') +
        '<div class="space-y-4"><input id="shpPass" class="inp" type="password" placeholder="Share password"><p id="shpErr" class="err hidden">Wrong password.</p>' +
        '<button type="button" class="btn-primary w-full" id="shpGo">Unlock</button></div>');
      document.getElementById('shpGo').addEventListener('click', function () {
        D.sha256Hex(document.getElementById('shpPass').value).then(function (h) {
          if (h === share.passwordHash) show(true);
          else document.getElementById('shpErr').classList.remove('hidden');
        });
      });
    } else show(true);
  }

  /* ---------- global events & init ---------- */
  document.getElementById('sideSaveBtn').addEventListener('click', saveLinkModal);
  document.getElementById('sideUploadBtn').addEventListener('click', uploadModal);
  document.getElementById('sideLogout').addEventListener('click', logout);
  document.getElementById('headerAvatar').addEventListener('click', function () { state.settingsTab = 'profile'; go('settings'); });
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);
  document.getElementById('authThemeBtn').addEventListener('click', toggleTheme);
  var searchEl = document.getElementById('globalSearch');
  searchEl.addEventListener('input', function () {
    state.search = searchEl.value;
    if (me() && ['home', 'files', 'favourites', 'folders', 'private'].indexOf(state.view) >= 0) renderView();
  });
  ['click', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () { state.lastActivity = Date.now(); armAutoLock(); }, { passive: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && db.settings.appLockEnabled && db.settings.autoLock === 'background' && me()) showLockScreen();
  });

  applyTheme();
  handleShareHash();
  // MEGA: restore a remembered session ("Keep me signed in") if there is
  // one. Session-only by default — no stored session means the user logs
  // in again from Settings → Cloud Sync. Never throws; a failed restore
  // just leaves the honest "Not connected" state.
  if (MegaX && MegaX.restoreSession) {
    MegaX.restoreSession().then(function (ok) {
      if (ok) {
        D.logActivity(db, 'mega_connected', 'MEGA session restored');
        save();
        if (me()) renderView();
      }
    }).catch(function () { /* not connected — nothing to do */ });
  }
  // Firebase: initialise (no-op with the placeholder config) and listen for
  // a signed-in Firebase user (e.g. after a Google redirect sign-in).
  if (FBx) {
    FBx.init();
    FBx.onAuth(function (fbUser) {
      if (!fbUser) return;
      var cur = me();
      if (!cur) { linkFirebaseUser(fbUser); return; }
      if (cur.firebaseUid !== fbUser.uid) {
        /* v1.5.3 — the live session is the truth: a restored session or
         * a redirect sign-in (possibly a different Google account)
         * replaces the stored uid, so the stale uid never reaches
         * Firestore again. */
        cur.firebaseUid = fbUser.uid; state.googleAuthNeeded = false; save();
        setTimeout(function () { syncNow(false); }, 900);
      }
    });
  }
  document.getElementById('photoInput').addEventListener('change', onPhotoPicked);
  if (db.session.userId && db.users.some(function (u) { return u.id === db.session.userId; })) {
    enterApp();
  } else {
    document.getElementById('authView').classList.remove('hidden');
  }

  /* public API used by inline onclick handlers */
  window.SaveBoxUI = {
    closeModal: closeModal, downloadItem: downloadItem, openWith: openWith,
    clearShareHash: function () { history.replaceState(null, '', location.pathname + location.search); }
  };
})();
