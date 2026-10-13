// User accounts on Firebase: sign-up and sign-in with email and password, each
// user's marks in the document users/<uid>, and company-search requests in the
// "requests" collection, which the collector reads.

import { FIREBASE } from './config.js';

export const enabled = Boolean(FIREBASE?.apiKey);

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/firebase';
let A; // auth module
let F; // firestore module
let auth;
let db;

// Calls onUser({ uid, email }) or onUser(null) now and on every sign-in/out.
export async function start(onUser) {
  const [{ initializeApp }, authModule, firestoreModule] = await Promise.all([
    import(`${SDK}-app.js`), import(`${SDK}-auth.js`), import(`${SDK}-firestore-lite.js`),
  ]);
  A = authModule;
  F = firestoreModule;
  const app = initializeApp(FIREBASE);
  auth = A.getAuth(app);
  db = F.getFirestore(app);
  A.onAuthStateChanged(auth, (u) => onUser(u ? { uid: u.uid, email: u.email } : null));
}

export const signUp = (email, password) => A.createUserWithEmailAndPassword(auth, email, password);
export const signIn = (email, password) => A.signInWithEmailAndPassword(auth, email, password);
export const resetPassword = (email) => A.sendPasswordResetEmail(auth, email);
export const signOut = () => A.signOut(auth);

const userDoc = () => F.doc(db, 'users', auth.currentUser.uid);

export async function loadState() {
  return (await F.getDoc(userDoc())).data() || {};
}

// ops: [{ kind: 'applied' | 'seen', id, value }]; a null value removes the mark.
// Each mark is merged on its own, so two devices never overwrite each other.
export async function saveOps(ops) {
  const data = {};
  for (const op of ops) {
    // Firestore rejects undefined, which JSON drops.
    (data[op.kind] ||= {})[op.id] = op.value == null ? F.deleteField() : JSON.parse(JSON.stringify(op.value));
  }
  await F.setDoc(userDoc(), data, { merge: true });
}

// company: { name, url?, ats?, slug? }
export async function requestCompany(company) {
  const data = { by: auth.currentUser.uid };
  for (const key of ['name', 'url', 'ats', 'slug']) if (company[key]) data[key] = String(company[key]).slice(0, 200);
  await F.addDoc(F.collection(db, 'requests'), data);
}

export function errorText(err) {
  const messages = {
    'auth/email-already-in-use': 'כבר יש חשבון עם האימייל הזה. נסה להיכנס במקום להירשם.',
    'auth/invalid-email': 'כתובת האימייל לא תקינה.',
    'auth/weak-password': 'הסיסמה צריכה להיות באורך 6 תווים לפחות.',
    'auth/missing-password': 'צריך להזין סיסמה.',
    'auth/invalid-credential': 'האימייל או הסיסמה שגויים.',
    'auth/wrong-password': 'האימייל או הסיסמה שגויים.',
    'auth/user-not-found': 'האימייל או הסיסמה שגויים.',
    'auth/too-many-requests': 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.',
    'auth/network-request-failed': 'אין חיבור לרשת. נסה שוב.',
    'auth/operation-not-allowed': 'הרשמה עם אימייל וסיסמה לא הופעלה בפרויקט ה-Firebase.',
  };
  return messages[err?.code] || 'משהו השתבש. נסה שוב.';
}
