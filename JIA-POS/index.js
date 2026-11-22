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
    const rec = await db.doc('recovery/' + email).get();
    if (rec.exists) { if (rec.get('username')) await db.doc('usernames/' + rec.get('username')).delete(); await rec.ref.delete(); }
  } catch (e) { console.error('recovery cleanup', e.message); }
  try { await db.doc('supportMeta/' + email).delete(); } catch (e) { console.error('supportMeta cleanup', e.message); }
  try {
    const u = await admin.auth().getUserByEmail(email);
    await admin.auth().deleteUser(u.uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw new functions.https.HttpsError('internal', e.message);
  }
  return { ok: true };
});

// Chat retention, hourly: Owners Central 30 days; Support chats are NEVER auto-deleted (the super admin deletes them);
// team chat 15 days for Premium owners and 1 day for free owners. Uploaded GitHub files are removed with their message.
// Token for attachment cleanup: put GITHUB_TOKEN=... in functions/.env (or the old: firebase functions:config:set github.token="...").
function ghToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return (functions.config().github || {}).token || ''; } catch (e) { return ''; }
}
exports.purgeChatMessages = functions.pubsub.schedule('every 60 minutes').timeZone('Asia/Manila').onRun(async () => {
  const db = admin.firestore(), token = ghToken(), now = Date.now();
  const repo = 'itoayusername/abande.site', branch = 'main';
  const premCache = {};
  const isPrem = async (e) => {
    if (!(e in premCache)) { const a = await db.doc('admins/' + e).get(); premCache[e] = a.exists && (a.get('premiumUntil') || 0) > now; }
    return premCache[e];
  };
  let last = null;
  for (;;) {
    let q = db.collection('messages').where('timestamp', '<', now - DAY).orderBy('timestamp').limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    last = snap.docs[snap.docs.length - 1];
    const batch = db.batch(); let n = 0;
    for (const d of snap.docs) {
      const m = d.data(), age = now - (m.timestamp || 0);
      let keep;
      if (m.room === 'central') keep = 30 * DAY;
      else if (m.recipient === 'super-admin' || m.sender === 'super') keep = Infinity;
      else keep = (await isPrem(m.adminEmail)) ? 15 * DAY : DAY;
      if (age <= keep) continue;
      const att = m.att;
      if (token && att && att.path) {
        try {
          const u = 'https://api.github.com/repos/' + repo + '/contents/' + att.path.split('/').map(encodeURIComponent).join('/');
          const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
          const g = await fetch(u + '?ref=' + branch, { headers: H });
          if (g.ok) { const j = await g.json(); await fetch(u, { method: 'DELETE', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Remove expired chat file', sha: j.sha, branch }) }); }
        } catch (e) { console.error('GitHub delete failed', att.path, e.message); }
      }
      batch.delete(d.ref); n++;
    }
    if (n) await batch.commit();
    if (snap.size < 400) break;
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
  const token = ghToken();
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


// =====================================================================================================
// Premium, coupons, account recovery, Support auto-reply
// =====================================================================================================
const DAY = 86400000;
const HttpsError = functions.https.HttpsError;
const lc = (v) => String(v || '').trim().toLowerCase();
const normAns = (v) => lc(v).replace(/\s+/g, ' ');
const hashAns = (salt, a) => crypto.createHash('sha256').update(salt + '|' + normAns(a)).digest('hex');
const userOk = (u) => /^[a-z0-9._-]{3,24}$/.test(u);
const manilaYmd = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const keyOf = (email) => lc(email).replace(/\./g, ',');

async function requireApprovedOwner(context) {
  const email = lc(context.auth && context.auth.token && context.auth.token.email);
  if (!email) throw new HttpsError('unauthenticated', 'Sign in first.');
  const a = await admin.firestore().doc('admins/' + email).get();
  if (!a.exists || a.get('approved') !== true) throw new HttpsError('permission-denied', 'Owners only.');
  return email;
}

// ---- Sign-up: is this username free? (public, no sign-in needed) ----
exports.checkUsername = functions.https.onCall(async (data) => {
  const u = lc(data && data.username);
  if (!userOk(u)) throw new HttpsError('invalid-argument', 'Use 3-24 letters, numbers, dot, dash or underscore.');
  return { available: !(await admin.firestore().doc('usernames/' + u).get()).exists };
});

// ---- Right after sign-up: store the username + 3 hashed security answers (server-only collection) ----
exports.setupRecovery = functions.https.onCall(async (data, context) => {
  const email = lc(context.auth && context.auth.token && context.auth.token.email);
  if (!email) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = admin.firestore();
  const own = await db.doc('admins/' + email).get();
  if (!own.exists) throw new HttpsError('failed-precondition', 'No owner record.');
  const qs = (data && data.questions) || [], as = (data && data.answers) || [];
  if (qs.length !== 3 || as.length !== 3 || new Set(qs.map(String)).size !== 3) throw new HttpsError('invalid-argument', 'Choose 3 different security questions.');
  if (as.some((a) => normAns(a).length < 2)) throw new HttpsError('invalid-argument', 'Answer all 3 security questions.');
  if (await db.doc('recovery/' + email).get().then((d) => d.exists)) throw new HttpsError('already-exists', 'Recovery is already set up.');
  const username = lc(data.username);
  if (username) {
    if (!userOk(username)) throw new HttpsError('invalid-argument', 'Username must be 3-24 letters, numbers, dot, dash or underscore.');
    const ref = db.doc('usernames/' + username);
    if ((await ref.get()).exists) throw new HttpsError('already-exists', 'That username is taken.');
    await ref.set({ email });
  }
  const salt = crypto.randomBytes(8).toString('hex');
  await db.doc('recovery/' + email).set({ questions: qs.map(String).slice(0, 3), salt, hashes: as.map((a) => hashAns(salt, a)), username: username || '', fails: 0, createdAt: Date.now() });
  if (username) await db.doc('admins/' + email).update({ username });
  return { ok: true };
});

// ---- Sign in with a username: returns the email to sign in with (public) ----
exports.resolveLogin = functions.https.onCall(async (data) => {
  const id = lc(data && data.identifier);
  if (!id) throw new HttpsError('invalid-argument', 'Enter your email or username.');
  if (id.includes('@')) return { email: id };
  const d = await admin.firestore().doc('usernames/' + id).get();
  if (!d.exists) throw new HttpsError('not-found', 'Incorrect email or password.');
  return { email: d.get('email') };
});

async function recoveryFor(identifier) {
  const id = lc(identifier), db = admin.firestore();
  let email = id;
  if (!id.includes('@')) { const u = await db.doc('usernames/' + id).get(); email = u.exists ? u.get('email') : ''; }
  const r = email ? await db.doc('recovery/' + email).get() : null;
  return { email, rec: r && r.exists ? r : null };
}
// ---- Forgot password step 1: the owner's 3 questions ----
exports.getRecoveryQuestions = functions.https.onCall(async (data) => {
  const { rec } = await recoveryFor(data && data.identifier);
  if (!rec) throw new HttpsError('not-found', 'No security questions are set for that account.');
  return { questions: rec.get('questions') };
});
// ---- Forgot password step 2: all 3 answers must be right, then the new password is set ----
exports.resetPasswordWithAnswers = functions.https.onCall(async (data) => {
  const { email, rec } = await recoveryFor(data && data.identifier);
  if (!rec) throw new HttpsError('not-found', 'No security questions are set for that account.');
  const pw = String((data && data.newPassword) || '');
  if (pw.length < 6) throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
  const until = rec.get('lockedUntil') || 0;
  if (until > Date.now()) throw new HttpsError('resource-exhausted', 'Too many wrong answers. Try again in a few minutes.');
  const as = (data && data.answers) || [], salt = rec.get('salt'), hs = rec.get('hashes');
  const ok = as.length === 3 && hs.every((h, i) => hashAns(salt, as[i]) === h);
  if (!ok) {
    const f = (rec.get('fails') || 0) + 1;
    await rec.ref.update(f >= 5 ? { fails: 0, lockedUntil: Date.now() + 15 * 60000 } : { fails: f });
    throw new HttpsError('permission-denied', 'One or more answers are incorrect.');
  }
  try { const u = await admin.auth().getUserByEmail(email); await admin.auth().updateUser(u.uid, { password: pw }); }
  catch (e) { throw new HttpsError('internal', 'Could not change the password.'); }
  await rec.ref.update({ fails: 0, lockedUntil: 0 });
  return { ok: true };
});

// ---- Owners redeem a premium coupon (stacks on top of any remaining premium time) ----
exports.redeemCoupon = functions.https.onCall(async (data, context) => {
  const email = await requireApprovedOwner(context);
  const code = String((data && data.code) || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code) throw new HttpsError('invalid-argument', 'Enter a coupon code.');
  const db = admin.firestore(), cref = db.doc('coupons/' + code), aref = db.doc('admins/' + email);
  return db.runTransaction(async (tx) => {
    const [c, a] = await Promise.all([tx.get(cref), tx.get(aref)]);
    if (!c.exists || c.get('active') === false) throw new HttpsError('not-found', 'That coupon code is not valid.');
    const now = Date.now(), d = c.data();
    if (d.codeExpiresAt && d.codeExpiresAt < now) throw new HttpsError('failed-precondition', 'That coupon has expired.');
    if ((d.redeemedCount || 0) >= (d.maxRedeems || 1)) throw new HttpsError('failed-precondition', 'That coupon has been fully redeemed.');
    const mine = (d.redeemedBy || {})[keyOf(email)] || 0;
    if (d.perAccount !== false && mine >= 1) throw new HttpsError('failed-precondition', 'You already redeemed this coupon.');
    const days = Number(d.days) || 0;
    const base = Math.max(now, a.get('premiumUntil') || 0), until = base + days * DAY;
    tx.update(cref, { redeemedCount: (d.redeemedCount || 0) + 1, ['redeemedBy.' + keyOf(email)]: mine + 1, history: admin.firestore.FieldValue.arrayUnion({ email, time: now, days }) });
    tx.update(aref, { premiumUntil: until, plan: 'Premium', premiumSource: 'coupon:' + code, premiumNoticeFor: 0 });
    return { ok: true, days, premiumUntil: until };
  });
});

// ---- Hourly: "1 day left" messages (Premium and Online Store) + automatic store switch-off ----
const fmtManila = (ms) => new Date(ms).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
async function noticeOnce(db, adminId, field, untilField, textFn) {
  const aref = db.doc('admins/' + adminId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(aref);
    if (!s.exists) return;
    const until = s.get(untilField) || 0;
    if (!(until > Date.now()) || s.get(field) === until) return;   // already told about this end date
    tx.update(aref, { [field]: until });
    tx.set(db.collection('messages').doc(), { adminEmail: adminId, sender: 'super', senderName: 'Support', recipient: 'super-admin', auto: true, timestamp: Date.now(), text: textFn(until) });
  });
}
exports.premiumExpiryNotice = functions.pubsub.schedule('every 60 minutes').timeZone('Asia/Manila').onRun(async () => {
  const db = admin.firestore(), now = Date.now();
  const prem = await db.collection('admins').where('premiumUntil', '>', now).get();
  for (const d of prem.docs) {
    const u = d.get('premiumUntil');
    if (u - now > DAY || d.get('premiumNoticeFor') === u) continue;
    try {
      await noticeOnce(db, d.id, 'premiumNoticeFor', 'premiumUntil', (x) => 'Reminder: your Premium plan ends in less than 1 day (' + fmtManila(x) + '). Renew with a coupon code in Settings, or message us here, to keep your Premium features (15-day chat history, profile picture, polls and image sharing).');
    } catch (e) { console.error('premium notice', d.id, e.message); }
  }
  const stores = await db.collection('admins').where('storeEnabled', '==', true).get();
  for (const d of stores.docs) {
    const su = d.get('storeUntil') || 0;
    if (!(su > 0) || d.get('storeAutoDisable') === false) continue;
    try {
      if (su <= now) {
        const key = d.get('storeKey');
        if (key) await db.doc('stores/' + key).set({ enabled: false, status: 'Expired' }, { merge: true });
        await d.ref.update({ storeEnabled: false, status: 'Expired' });
      } else if (su - now <= DAY && d.get('storeNoticeFor') !== su) {
        await noticeOnce(db, d.id, 'storeNoticeFor', 'storeUntil', (x) => 'Reminder: your Online Store subscription ends in less than 1 day (' + fmtManila(x) + '). The store switches off automatically after that. Message us here to renew and keep your store online.');
      }
    } catch (e) { console.error('store sweep', d.id, e.message); }
  }
  return null;
});

// ---- Support auto-reply (shown as "System"), at most once every 4 hours per owner ----
exports.supportAutoReply = functions.firestore.document('messages/{id}').onCreate(async (snap) => {
  const m = snap.data() || {};
  const toSupport = m.recipient === 'super-admin' || m.business === '__support';
  if (!toSupport || m.sender === 'super' || m.auto || !m.adminEmail) return null;
  const db = admin.firestore(), ref = db.doc('supportMeta/' + m.adminEmail), now = Date.now();
  // transaction so two quick messages cannot both trigger a reply
  const go = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (now - (s.get('lastAuto') || 0) < 4 * 3600000) return false;
    tx.set(ref, { lastAuto: now }, { merge: true });
    return true;
  });
  if (!go) return null;
  await db.collection('messages').add({
    adminEmail: m.adminEmail, sender: 'super', senderName: 'System', auto: true, timestamp: Date.now() + 1,
    text: 'Thank you for your message. We have received it and will reply as soon as we can. You can also visit www.abande.site. If it is urgent, please call or message 09662060108. For bug reports, feedback and suggestions, we appreciate it if you attach an image (screenshot).'
  });
  return null;
});
