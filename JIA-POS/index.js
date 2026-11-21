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
