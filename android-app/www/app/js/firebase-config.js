/* SaveBox — Firebase configuration (v1.2.0)
 *
 * HOW TO CONNECT CLOUD SYNC:
 * 1. Follow FIREBASE_SETUP.md in the SaveBox project root (exact steps).
 * 2. In the Firebase console, open Project settings → Your apps → Web app,
 *    and copy the firebaseConfig object.
 * 3. Paste the values into SAVEBOX_FIREBASE_CONFIG below (replace the empty
 *    strings). v1.2.0 reads this object on startup: Google Sign-In and
 *    Firestore/Storage sync switch on automatically once it is filled.
 * 4. Re-deploy. The app detects a filled config automatically and enables
 *    Google Sign-In + cross-device sync (Phase 2 feature — see README.md).
 *
 * UNTIL THEN the app works 100% WITHOUT Firebase: all data is stored on this
 * device only (localStorage + IndexedDB). If every key below is empty, the
 * app runs in device-local mode and shows "Not connected — local device
 * storage" in Settings → Cloud Sync. Nothing breaks and no error is shown
 * to the user beyond that honest status card.
 *
 * NEVER commit real keys to a public repo. These are web (client-side) keys
 * and are safe to ship in the app, but keep them out of public git history
 * anyway. No service-account private key is ever needed here.
 */
window.SAVEBOX_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAq-l9YhSEpkzYIFJ7QcEnsjRE_l5yZwRo",
  authDomain: "savebox-f0b65.firebaseapp.com",
  projectId: "savebox-f0b65",
  storageBucket: "savebox-f0b65.firebasestorage.app",
  messagingSenderId: "877557763090",
  appId: "1:877557763090:web:134755eb8e283330bc9ccb",
  measurementId: ""
};
/* Single injection point: paste your Firebase web-app config above.
 * FIREBASE_CONFIG is kept as an alias so older code keeps working. */
window.FIREBASE_CONFIG = window.SAVEBOX_FIREBASE_CONFIG;

/* True when a real Firebase project has been pasted in. */
window.FIREBASE_ENABLED = Boolean(
  window.FIREBASE_CONFIG &&
  window.FIREBASE_CONFIG.apiKey &&
  window.FIREBASE_CONFIG.projectId
);
