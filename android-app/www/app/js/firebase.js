/* SaveBox v1.5.7 — Firebase cloud layer (compat SDK, loaded via CDN)
 *
 * This file is ONLY active when window.FIREBASE_ENABLED is true, i.e. when
 * a real config has been pasted into js/firebase-config.js. With the
 * placeholder config it initialises to nothing and every function below
 * safely no-ops / rejects — the app keeps working 100% in device-local
 * mode. The app never claims cloud sync works without a config.
 *
 * What it does when configured:
 *  - Auth: Google Sign-In (popup, redirect fallback), email/password
 *    register / sign-in / password-reset, sign-out, auth-state listener.
 *  - Firestore: folders + items metadata for the signed-in user only
 *    (ownerId == uid; rules in FIREBASE_SETUP.md enforce this).
 *    First sync merges local data UP to the cloud, then the cloud is the
 *    source of truth for metadata.
 *  - Storage: file blobs under files/{uid}/{itemId}; download URLs are
 *    used as a fallback when a file is not on this device.
 *
 * v1.5.7 — NATIVE Google Sign-In inside the Android APK. The web
 * signInWithRedirect flow navigates away from the Capacitor WebView:
 * Capacitor hands the Google auth page to the system browser (Chrome),
 * and the return URL is the app's own origin https://localhost/…, which
 * only exists inside the WebView — so Chrome shows ERR_CONNECTION_REFUSED.
 * On native, signInWithGoogle() now uses @capacitor-firebase/authentication
 * (FirebaseAuthentication.signInWithGoogle — the in-app Google account
 * chooser, no browser at all) and exchanges the returned ID token with
 * the compat SDK (signInWithCredential), so the rest of the app —
 * linkFirebaseUser, onAuth, sync — works unchanged. On the website the
 * flow is untouched (popup → redirect fallback).
 */
(function () {
  'use strict';

  var FB = {
    ready: false,
    auth: null,
    fs: null,
    storage: null,
    projectId: '',
    lastSyncAt: 0
  };

  function clean(obj) {
    // Firestore rejects `undefined` values — round-trip through JSON.
    return JSON.parse(JSON.stringify(obj));
  }

  function init() {
    try {
      if (!window.FIREBASE_ENABLED || typeof firebase === 'undefined' || !firebase.apps) return false;
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      FB.auth = firebase.auth();
      FB.fs = firebase.firestore();
      FB.storage = firebase.storage();
      FB.projectId = (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId) || '';
      FB.ready = true;
    } catch (e) {
      FB.ready = false;
    }
    return FB.ready;
  }

  function needReady() {
    if (!FB.ready) return Promise.reject(new Error('Firebase is not connected'));
    return Promise.resolve();
  }

  /* ---------- auth ---------- */

  /* v1.5.7 — true only inside the installed APK (Capacitor WebView).
   * The vendored js/capacitor.js defines window.Capacitor on every
   * surface; isNativePlatform() is false on the website, true in the APK. */
  function isNativePlatform() {
    try {
      return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform && Capacitor.isNativePlatform();
    } catch (e) { return false; }
  }

  /* The @capacitor-firebase/authentication plugin object (vendored UMD
   * bundle js/firebase-auth-plugin.js registers it as
   * window.capacitorFirebaseAuthentication.FirebaseAuthentication). */
  function nativeAuthPlugin() {
    try {
      var g = window.capacitorFirebaseAuthentication;
      return (g && g.FirebaseAuthentication) || null;
    } catch (e) { return null; }
  }

  function signInWithGoogle() {
    return needReady().then(function () {
      if (isNativePlatform()) {
        /* In-app Google sign-in: the plugin shows the native Google
         * account chooser inside the app — no browser navigation, so the
         * localhost redirect that broke v1.5.6 can never happen. The ID
         * token is then exchanged with the compat SDK, exactly like a
         * web sign-in, so linkFirebaseUser / onAuth / sync are unchanged.
         * Requires google-services.json + the Android app registered in
         * the Firebase console with this build's SHA-1 (see
         * FIREBASE_SETUP.md); without it the plugin rejects and the
         * caller shows a plain error — never a Chrome redirect. */
        var plugin = nativeAuthPlugin();
        if (!plugin || !plugin.signInWithGoogle) {
          return Promise.reject(new Error('Google Sign-In is not available in this app build yet.'));
        }
        return plugin.signInWithGoogle().then(function (res) {
          var idToken = res && res.credential && res.credential.idToken;
          if (!idToken) throw new Error('Google Sign-In did not return an ID token.');
          var credential = firebase.auth.GoogleAuthProvider.credential(idToken);
          return FB.auth.signInWithCredential(credential).then(function (cred) { return cred.user; });
        });
      }
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return FB.auth.signInWithPopup(provider).then(function (cred) { return cred.user; }).catch(function (err) {
        // Popup blocked / closed or mobile webview — fall back to redirect.
        if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user' ||
                    err.code === 'auth/cancelled-popup-request' || err.code === 'auth/operation-not-supported-in-this-environment')) {
          return FB.auth.signInWithRedirect(provider).then(function () { return null; });
        }
        throw err;
      });
    });
  }

  function signInWithEmail(email, pass) {
    return needReady().then(function () {
      return FB.auth.signInWithEmailAndPassword(email, pass).then(function (cred) { return cred.user; });
    });
  }

  function registerWithEmail(email, pass, name) {
    return needReady().then(function () {
      return FB.auth.createUserWithEmailAndPassword(email, pass).then(function (cred) {
        var user = cred.user;
        if (name) return user.updateProfile({ displayName: name }).then(function () { return user; });
        return user;
      });
    });
  }

  function resetPassword(email) {
    return needReady().then(function () {
      return FB.auth.sendPasswordResetEmail(email);
    });
  }

  function signOut() {
    if (!FB.ready) return Promise.resolve();
    return FB.auth.signOut().catch(function () { /* local sign-out still proceeds */ });
  }

  function currentUser() {
    return FB.ready ? FB.auth.currentUser : null;
  }

  function onAuth(cb) {
    if (!FB.ready) return function () {};
    // Finish a redirect-based Google sign-in if one is in flight.
    FB.auth.getRedirectResult().then(function (res) {
      if (res && res.user) cb(res.user);
    }).catch(function () { /* no redirect pending — normal */ });
    return FB.auth.onAuthStateChanged(function (user) { if (user) cb(user); });
  }

  /* v1.5.3 — Firestore permission/auth failure detector. A denied
   * call means the Google session expired or a document belongs to
   * another uid. The app must never show the raw firestore message
   * to the user — it falls back to MEGA and offers a Google
   * reconnect instead. */
  function isPermError(err) {
    if (!err) return false;
    if (err.code === 'permission-denied' || err.code === 'unauthenticated') return true;
    var m = String((err && err.message) || '').toLowerCase();
    return m.indexOf('insufficient permissions') >= 0 || m.indexOf('permission-denied') >= 0 || m.indexOf('missing or insufficient') >= 0;
  }

  /* ---------- firestore sync ---------- */
  function userDoc(uid, profile) {
    return FB.fs.collection('users').doc(uid).set(clean({
      email: profile.email || '', name: profile.name || '',
      updatedAt: Date.now()
    }), { merge: true });
  }

  function syncUp(uid, folders, items) {
    return needReady().then(function () {
      /* v1.5.3 — one denied document must not fail the whole sync.
       * A doc can be denied when it already exists in Firestore owned
       * by a different uid (user switched Google accounts) while the
       * others sync fine. Denied docs are skipped and counted; the
       * caller reports the count honestly. Network errors still reject. */
      var skipped = 0;
      function put(coll, id, data) {
        return FB.fs.collection(coll).doc(id).set(data, { merge: true }).catch(function (err) {
          if (isPermError(err)) { skipped++; return null; }
          throw err;
        });
      }
      var jobs = [];
      folders.forEach(function (f) {
        var data = clean(Object.assign({}, f, { ownerId: uid }));
        delete data.userId;
        jobs.push(put('folders', f.id, data));
      });
      items.forEach(function (it) {
        var data = clean(Object.assign({}, it, { ownerId: uid }));
        delete data.userId;
        jobs.push(put('items', it.id, data));
      });
      return Promise.all(jobs).then(function () { return { folders: folders.length, items: items.length, skipped: skipped }; });
    });
  }

  function syncDown(uid) {
    return needReady().then(function () {
      return Promise.all([
        FB.fs.collection('folders').where('ownerId', '==', uid).get(),
        FB.fs.collection('items').where('ownerId', '==', uid).get()
      ]).then(function (snaps) {
        var folders = [], items = [];
        snaps[0].forEach(function (d) { var v = d.data(); v.id = d.id; delete v.ownerId; folders.push(v); });
        snaps[1].forEach(function (d) { var v = d.data(); v.id = d.id; delete v.ownerId; items.push(v); });
        return { folders: folders, items: items };
      });
    });
  }

  /* ---------- storage ---------- */
  function uploadFile(uid, item, blob) {
    return needReady().then(function () {
      var path = 'files/' + uid + '/' + item.id;
      var ref = FB.storage.ref(path);
      return ref.put(blob, { contentType: blob.type || 'application/octet-stream' }).then(function () { return path; });
    });
  }

  function getFileBlob(storagePath) {
    return needReady().then(function () {
      return FB.storage.ref(storagePath).getDownloadURL();
    }).then(function (url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('download failed: ' + r.status);
        return r.blob();
      });
    });
  }

  function deleteFile(storagePath) {
    if (!FB.ready || !storagePath) return Promise.resolve();
    return FB.storage.ref(storagePath).delete().catch(function () { /* already gone */ });
  }

  function deleteUserDocs(uid) {
    if (!FB.ready) return Promise.resolve();
    return Promise.all([
      FB.fs.collection('folders').where('ownerId', '==', uid).get(),
      FB.fs.collection('items').where('ownerId', '==', uid).get()
    ]).then(function (snaps) {
      var batch = FB.fs.batch();
      var n = 0;
      snaps.forEach(function (snap) { snap.forEach(function (d) { batch.delete(d.ref); n++; }); });
      if (!n) return 0;
      return batch.commit().then(function () { return n; });
    }).catch(function () { return 0; });
  }

  function friendlyError(err) {
    if (!err || !err.code) return (err && err.message) || 'Something went wrong.';
    var map = {
      'auth/invalid-email': 'That email address doesn’t look right.',
      'auth/user-disabled': 'This account has been disabled.',
      'auth/user-not-found': 'No account found with this email.',
      'auth/wrong-password': 'Wrong password. Try again or use “Forgot password?”.',
      'auth/invalid-credential': 'Wrong email or password. Try again.',
      'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/too-many-requests': 'Too many attempts — please wait a few minutes and try again.',
      'auth/network-request-failed': 'No internet connection. Check your network and try again.',
      'auth/unauthorized-domain': 'This domain is not authorised in Firebase → Authentication → Settings → Authorized domains.',
      'auth/popup-closed-by-user': 'Google sign-in was closed before finishing. Try again.',
      'auth/account-exists-with-different-credential': 'This email is already linked to a different sign-in method. Try the other method.'
    };
    return map[err.code] || err.message || 'Something went wrong.';
  }

  window.SaveBoxFirebase = {
    FB: FB,
    get ready() { return FB.ready; },
    get projectId() { return FB.projectId; },
    init: init,
    isNativePlatform: isNativePlatform,
    signInWithGoogle: signInWithGoogle,
    signInWithEmail: signInWithEmail,
    registerWithEmail: registerWithEmail,
    resetPassword: resetPassword,
    signOut: signOut,
    currentUser: currentUser,
    onAuth: onAuth,
    userDoc: userDoc,
    syncUp: syncUp,
    syncDown: syncDown,
    uploadFile: uploadFile,
    getFileBlob: getFileBlob,
    deleteFile: deleteFile,
    deleteUserDocs: deleteUserDocs,
    isPermError: isPermError,
    friendlyError: friendlyError
  };
})();
