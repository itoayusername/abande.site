// Cloud Function that removes a sign-in login (Firebase Authentication user).
// Only a super admin (a document in `superadmins/{email}`) may call it.
// Deploy:  firebase init functions  (JavaScript, Node 18+)  ->  paste this file  ->  firebase deploy --only functions
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.deleteUserAccount = functions.https.onCall(async (data, context) => {
  const caller = context.auth && context.auth.token && context.auth.token.email;
  if (!caller) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.');
  const db = admin.firestore();
  const isSuper = context.auth.token.superadmin === true || (await db.doc('superadmins/' + caller).get()).exists;
  if (!isSuper) throw new functions.https.HttpsError('permission-denied', 'Super admins only.');

  const email = String((data && data.email) || '').trim().toLowerCase();
  if (!email) throw new functions.https.HttpsError('invalid-argument', 'Email is required.');
  if (email === String(caller).toLowerCase()) throw new functions.https.HttpsError('failed-precondition', 'You cannot delete your own account.');
  if ((await db.doc('superadmins/' + email).get()).exists) throw new functions.https.HttpsError('failed-precondition', 'That account is a super admin.');

  try {
    const u = await admin.auth().getUserByEmail(email);
    await admin.auth().deleteUser(u.uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw new functions.https.HttpsError('internal', e.message);
  }
  return { ok: true };
});

// Nightly cleanup: deletes every chat message (and its uploaded GitHub file) at 23:59 Philippine time.
// Needs the Blaze plan. For attachment cleanup set a token:  firebase functions:config:set github.token="YOUR_TOKEN"
exports.purgeChatMessages = functions.pubsub.schedule('59 23 * * *').timeZone('Asia/Manila').onRun(async () => {
  const db = admin.firestore();
  const token = (functions.config().github || {}).token;
  const repo = 'itoayusername/abande.site', branch = 'main';
  for (;;) {
    const snap = await db.collection('messages').limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const d of snap.docs) {
      const att = d.get('att');
      if (token && att && att.path) {
        try {
          const u = 'https://api.github.com/repos/' + repo + '/contents/' + att.path.split('/').map(encodeURIComponent).join('/');
          const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
          const g = await fetch(u + '?ref=' + branch, { headers: H });
          if (g.ok) { const j = await g.json(); await fetch(u, { method: 'DELETE', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Remove expired chat file', sha: j.sha, branch }) }); }
        } catch (e) { console.error('GitHub delete failed', att.path, e.message); }
      }
      batch.delete(d.ref);
    }
    await batch.commit();
  }
  return null;
});

// Round-robin ("call center") assignment: every new online order, reservation and auto-assign task goes to the
// next active employee of the same business, then the next, and back to the first after the last.
exports.autoAssign = functions.firestore.document('tasks/{id}').onCreate(async (snap) => {
  const t = snap.data() || {};
  const kind = t.kind || 'order';
  const owner = t.adminEmail;
  if (!owner) return null;
  const wants = kind === 'task' ? t.autoAssign === true : (!t.assignee || t.autoAssign === true || t.assignee === owner);
  if (!wants) return null;
  const db = admin.firestore();
  let biz = ((t.items || []).find((i) => i && i.business) || {}).business || '';
  if (!biz && t.createdByEmail) {
    const c = await db.doc('staff/' + t.createdByEmail).get();
    if (c.exists) biz = c.get('business') || '';
  }
  const all = (await db.collection('staff').where('adminEmail', '==', owner).get()).docs
    .map((d) => ({ email: d.get('email') || d.id, name: d.get('name') || d.id, business: d.get('business') || '', status: String(d.get('status') || 'Active').toLowerCase() }))
    .filter((s) => s.status !== 'inactive');
  let team = biz ? all.filter((s) => s.business === biz) : all;
  if (!team.length) team = all;
  if (!team.length) team = [{ email: owner, name: 'Owner' }];
  team.sort((a, b) => a.email.localeCompare(b.email));
  const key = 'rr/' + (owner + '_' + (biz || 'all')).replace(/[\/\s]/g, '_');
  await db.runTransaction(async (tx) => {
    const cref = db.doc(key);
    const n = ((await tx.get(cref)).get('next') || 0);
    const pick = team[n % team.length];
    tx.set(cref, { next: n + 1, updatedAt: Date.now() }, { merge: true });
    tx.update(snap.ref, {
      assignee: pick.email, assigneeName: pick.name, autoAssigned: true,
      history: admin.firestore.FieldValue.arrayUnion({ action: 'Auto-assigned to ' + pick.name, by: 'System', time: Date.now() })
    });
  });
  return null;
});

// ---- Secure file uploads to GitHub (the token never leaves the server) ----
// One-time setup:  firebase functions:config:set github.token="YOUR_NEW_TOKEN"   then   firebase deploy --only functions
const crypto = require('crypto');
const GH_REPO = 'itoayusername/abande.site', GH_BRANCH = 'main';
const GH_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'zip'];
function ghHeaders() {
  const token = (functions.config().github || {}).token;
  if (!token) throw new functions.https.HttpsError('failed-precondition', 'Upload is not configured on the server.');
  return { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
}
async function teamRole(context) {
  const email = context.auth && context.auth.token && context.auth.token.email;
  if (!email) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.');
  const db = admin.firestore();
  const a = await db.doc('admins/' + email).get();
  if (a.exists && a.get('approved') === true) return { email, owner: true };
  const s = await db.doc('staff/' + email).get();
  if (s.exists && String(s.get('status') || 'Active').toLowerCase() !== 'inactive') return { email, owner: false };
  throw new functions.https.HttpsError('permission-denied', 'Not allowed.');
}
exports.uploadFile = functions.runWith({ memory: '512MB', timeoutSeconds: 120 }).https.onCall(async (data, context) => {
  await teamRole(context);
  const kind = data && data.kind, b64 = data && data.b64;
  if (!['image', 'chat'].includes(kind) || typeof b64 !== 'string' || !b64) throw new functions.https.HttpsError('invalid-argument', 'Bad upload.');
  if (b64.length > 9 * 1024 * 1024) throw new functions.https.HttpsError('invalid-argument', 'File is too large.');
  let ext = 'jpg';
  if (kind === 'chat') {
    ext = String(data.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!GH_EXT.includes(ext)) throw new functions.https.HttpsError('invalid-argument', 'That file type is not allowed.');
  } else {
    const head = Buffer.from(b64.slice(0, 8), 'base64');
    if (!(head[0] === 0xff && head[1] === 0xd8)) throw new functions.https.HttpsError('invalid-argument', 'Photos must be JPEG.');
  }
  const path = 'JIA-POS/Store/' + (kind === 'image' ? 'images' : 'chat') + '/' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + '.' + ext;
  const r = await fetch('https://api.github.com/repos/' + GH_REPO + '/contents/' + path.split('/').map(encodeURIComponent).join('/'), {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: kind === 'image' ? 'Add product photo' : 'Chat attachment', content: b64, branch: GH_BRANCH })
  });
  if (!r.ok) { console.error('GitHub upload failed', r.status, await r.text()); throw new functions.https.HttpsError('internal', 'Upload failed (' + r.status + ').'); }
  return { url: 'https://raw.githubusercontent.com/' + GH_REPO + '/' + GH_BRANCH + '/' + path, path };
});
exports.deleteUpload = functions.https.onCall(async (data, context) => {
  const who = await teamRole(context);
  const path = String((data && data.path) || '');
  if (!who.owner || !path.startsWith('JIA-POS/Store/chat/') || path.includes('..')) throw new functions.https.HttpsError('permission-denied', 'Not allowed.');
  const H = ghHeaders(), u = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  const g = await fetch(u + '?ref=' + GH_BRANCH, { headers: H });
  if (!g.ok) return { ok: true };
  const j = await g.json();
  await fetch(u, { method: 'DELETE', headers: H, body: JSON.stringify({ message: 'Remove expired chat file', sha: j.sha, branch: GH_BRANCH }) });
  return { ok: true };
});
