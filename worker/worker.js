/**
 * SaveBox R2 Worker — private cloud file store for SaveBox.
 *
 * Bucket binding: SAVEBOX_R2 -> `savebox-files` (PRIVATE, never public).
 * Auth: every file route requires a Firebase ID token (Authorization: Bearer
 * <token>). The token is verified server-side via Google IdentityToolkit
 * accounts:lookup; the verified uid must match the uid in the path.
 * Files are stored at `<uid>/<itemId>` — a user can only ever touch their
 * own folder. No upload/download/delete works without a verified token.
 *
 * Free tier: 10 GB storage, 1M writes/mo, 10M reads/mo, free egress.
 * No card, no billing — the bucket lives on the free Spark plan.
 */

// Public Firebase web key (same value shipped in the app's
// final-deploy/js/firebase-config.js). It identifies the Firebase project;
// it is NOT a secret and cannot by itself read or write user data.
const FIREBASE_API_KEY = 'AIzaSyAq-l9YhSEpkzYIFJ7QcEnsjRE_l5yZwRo';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB per file (matches the app)
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UID_RE = /^[A-Za-z0-9]{1,128}$/;
const ALLOWED_ORIGINS = new Set([
  'https://savebox.pages.dev',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
]);

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}

async function verifyToken(request, expectUid) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return { error: 'missing token', status: 401 };
  const idToken = m[1];
  let res;
  try {
    res = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
  } catch (e) {
    return { error: 'token check failed', status: 502 };
  }
  if (!res.ok) return { error: 'invalid token', status: 401 };
  const data = await res.json().catch(() => ({}));
  const user = (data.users && data.users[0]) || null;
  if (!user || !user.localId) return { error: 'invalid token', status: 401 };
  if (expectUid && user.localId !== expectUid) {
    return { error: 'uid mismatch', status: 403 };
  }
  return { uid: user.localId };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'savebox-r2' }, 200, cors);
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return json({ error: 'bad multipart body' }, 400, cors);
      }
      const uidField = String(form.get('uid') || '');
      const itemId = String(form.get('itemId') || '');
      const file = form.get('file');
      const v = await verifyToken(request, uidField || undefined);
      if (v.error) return json({ error: v.error }, v.status, cors);
      const uid = v.uid;
      if (!uidField || uidField !== uid) {
        return json({ error: 'uid mismatch' }, 403, cors);
      }
      if (!ITEM_ID_RE.test(itemId)) {
        return json({ error: 'bad itemId' }, 400, cors);
      }
      if (!file || typeof file.arrayBuffer !== 'function') {
        return json({ error: 'missing file' }, 400, cors);
      }
      if (file.size > MAX_BYTES) {
        return json({ error: 'file too large (max 50 MB)' }, 413, cors);
      }
      const key = uid + '/' + itemId;
      await env.SAVEBOX_R2.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { filename: file.name || itemId },
      });
      return json({ path: 'r2:' + key, size: file.size }, 200, cors);
    }

    const fileMatch = url.pathname.match(/^\/file\/([^/]+)\/([^/]+)$/);
    if (fileMatch) {
      const uid = decodeURIComponent(fileMatch[1]);
      const itemId = decodeURIComponent(fileMatch[2]);
      if (!UID_RE.test(uid) || !ITEM_ID_RE.test(itemId)) {
        return json({ error: 'bad path' }, 400, cors);
      }
      const v = await verifyToken(request, uid);
      if (v.error) return json({ error: v.error }, v.status, cors);
      const key = uid + '/' + itemId;
      if (request.method === 'GET') {
        const obj = await env.SAVEBOX_R2.get(key);
        if (!obj) return json({ error: 'not found' }, 404, cors);
        const headers = {
          'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'content-length': String(obj.size),
          'content-disposition':
            'inline; filename="' + (obj.customMetadata?.filename || itemId).replace(/"/g, '') + '"',
          ...cors,
        };
        return new Response(obj.body, { status: 200, headers });
      }
      if (request.method === 'DELETE') {
        await env.SAVEBOX_R2.delete(key);
        return json({ ok: true, path: 'r2:' + key }, 200, cors);
      }
      return json({ error: 'method not allowed' }, 405, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
