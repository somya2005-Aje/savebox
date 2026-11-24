# SaveBox — Firebase Setup Guide (Cloud Sync + Google Sign-In)

Follow these steps exactly. Nothing here costs money — everything below is
inside Firebase's **free Spark plan** quotas. You do **not** need to add a
card. Do **not** share any private key or service-account file with anyone.

> Until you finish this, SaveBox works 100% on device-local storage only.
> The app detects a filled config automatically — nothing else changes.

## Step 1 — Create the Firebase project

1. Go to https://console.firebase.google.com/ and sign in with your Google account.
2. Click **Add project** (or **Create a project**).
3. Project name: `savebox` (any name works; this one keeps things tidy).
4. Google Analytics: you can leave it **off** — SaveBox does not need it.
5. Click **Create project**, wait, then click **Continue**.

## Step 2 — Register the web app and copy the config

1. In the project, click the **</> (Web)** icon to add a web app.
2. App nickname: `SaveBox Web`. Do **not** tick "Firebase Hosting" (we deploy
   on Cloudflare Pages).
3. Click **Register app**. Firebase shows you a `firebaseConfig` object like:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "savebox-xxxxx.firebaseapp.com",
     projectId: "savebox-xxxxx",
     storageBucket: "savebox-xxxxx.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef...",
     measurementId: "G-XXXXXXX"
   };
   ```
4. Open `final-deploy/js/firebase-config.js` in the SaveBox folder and paste
   each value into the matching empty string in `FIREBASE_CONFIG`. Save the file.
5. Re-deploy SaveBox (`python3 deploy_pages.py`).

> These are **web client keys** — they are meant to be shipped in the app and
> are protected by the security rules below, not by secrecy. Never paste a
> **service-account private key** anywhere in this app — SaveBox never asks
> for one.

## Step 3 — Enable Email + Google sign-in

1. In Firebase console, go to **Build → Authentication → Sign-in method**
   (or **Authentication → Sign-in method**).
2. Click **Email/Password** → toggle **Enable** → **Save**.
3. Click **Google** → toggle **Enable**, pick your support email → **Save**.
4. In **Authentication → Settings → Authorized domains**, make sure your
   deployed domain is listed (add `savebox.pages.dev` if it is missing;
   `localhost` is already allowed for testing).

## Step 4 — Create Firestore (database)

1. Go to **Build → Firestore Database** → **Create database**.
2. Location: pick the nearest region (for India: `asia-south1` (Mumbai)).
3. Start in **production mode** (we paste strict rules next).
4. After it is created, go to the **Rules** tab and paste the rules below,
   then click **Publish**.

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // A signed-in user can only read/write their OWN documents.
    // Every document must carry an `ownerId` field equal to the user's uid.
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /folders/{folderId} {
      allow read, write: if request.auth != null
        && resource.data.ownerId == request.auth.uid;
      allow create: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid;
    }
    match /items/{itemId} {
      allow read, write: if request.auth != null
        && resource.data.ownerId == request.auth.uid;
      allow create: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid;
    }
    match /shares/{shareId} {
      // Owners manage their shares; public reads of a single share link
      // are handled by the app's share page, not by open rules.
      allow read, write: if request.auth != null
        && resource.data.ownerId == request.auth.uid;
      allow create: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid;
    }
    match /{document=**} {
      allow read, write: if false; // deny everything else by default
    }
  }
}
```

Schema used by SaveBox (same shape as the device-local database):
- `users/{uid}` — `{ email, name, createdAt }`
- `folders/{id}` — `{ ownerId, name, icon, color, parentId, createdAt, isPrivate }`
- `items/{id}` — `{ ownerId, kind: 'file'|'link'|'note', folderId, title, customName,
  description, tags[], platform, originalUrl, thumbnail, fileName, fileType,
  fileSize, mime, createdAt, updatedAt, isFavourite, isDeleted, deletedAt, openedAt }`
- `shares/{id}` — `{ ownerId, itemId, token, expiry, passwordHash, createdAt, revoked }`

## Step 5 — Create Storage (file uploads) and its rules

1. Go to **Build → Storage** → **Get started** → same region as Firestore →
   **Done**.
2. Go to the **Rules** tab and paste the rules below, then click **Publish**.

```js
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Users can only touch files under their own folder: files/{uid}/...
    match /files/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

3. Optional but recommended: in **Storage → Settings**, set a per-file size
   cap note for yourself — SaveBox already limits uploads to 50 MB in the app.

## Step 6 — Verify (v1.2.0 — the sync code is already in the app)

1. Open the deployed SaveBox, go to **Settings → Cloud Sync** — it should now
   show **Connected**.
2. The **Continue with Google** button on the sign-in screen should now work
   (popup; on mobile/blocked popups it falls back to redirect). Pick a Google
   account — you land straight in the app, and your local folders are merged
   up to Firestore on first sync.
3. Try signing in with email/password too — the account is created in Firebase
   Authentication, not only on the device. Password reset goes by email
   (Forgot password / Change password in Settings).
4. Save a link on one device, press **Sync Now**, open SaveBox on another
   device with the same account — the link should appear there.

## Free-tier quotas (honest numbers, Spark plan)

These are Firebase's published free quotas — they are generous for a personal
locker, and Firebase will not charge you unless you upgrade to Blaze yourself.

| Service | Free quota (Spark) |
|---|---|
| Authentication | 50,000 monthly active users (email + Google sign-in) |
| Firestore | 1 GiB stored, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day |
| Storage | 5 GB stored, 1 GB downloaded/day, 20,000 uploads/day, 50,000 downloads/day |

What this means in practice: one person's locker will stay free. If you ever
hit a limit, Firebase stops serving that service for the day instead of
charging you — nothing is billed on the Spark plan.

## Troubleshooting

- **"auth/unauthorized-domain"** — add your domain under
  Authentication → Settings → Authorized domains.
- **"permission-denied" on Firestore/Storage** — re-check the rules above;
  every document/file must carry the signed-in user's `uid` as `ownerId` /
  path folder.
- **"Google sync needs sign-in again" toast / a "Reconnect Google" button in
  Cloud Sync** — your Google session expired (or you signed in with a
  different Google account than the one that created this locker). Tap
  **Reconnect Google** and pick the same Google account — sync resumes.
  Your files were never at risk: while Google sync is down they keep
  syncing to MEGA (or stay on the device), and the app never shows the raw
  Firestore error. One denied document (owned by another account) no
  longer fails the whole sync — it is skipped and counted.
- **Config pasted but app still says "Not connected"** — make sure every
  field in `firebase-config.js` is filled (especially `apiKey` and
  `projectId`), save, and re-deploy.
- **Google Sign-In popup blocked** — allow popups for your SaveBox domain.
