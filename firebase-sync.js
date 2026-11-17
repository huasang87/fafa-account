import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, doc, runTransaction, arrayUnion } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import config from './firebase-config.js?v=3.0.0';
import { planSync } from './sync-engine.js?v=3.0.0';

const db = getFirestore(initializeApp(config));
const accountRef = doc(db, 'users', 'fafa_main_account');

export async function syncAccount(local) {
  // Transactions retry against the latest document. Older devices cannot overwrite a
  // newer wish/state through a delayed read. Legacy history is NEVER a write target.
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(accountRef);
    const data = snapshot.exists() ? snapshot.data() : {};
    const plan = planSync(data, local);
    if (plan.pending.length || Object.keys(plan.fields).length) {
      const approximateBytes = new TextEncoder().encode(JSON.stringify({ ...data, ...plan.fields,
        recordEvents: [...(data.recordEvents || []), ...plan.pending] })).length;
      if (approximateBytes > 850000) throw new Error('云端空间将满，新增内容已保留在本机，请导出备份后联系家长。');
      const fields = { ...plan.fields, lastSafeSync: new Date().toISOString() };
      if (plan.pending.length) fields.recordEvents = arrayUnion(...plan.pending);
      transaction.set(accountRef, fields, { merge: true });
    }
    return plan.merged;
  });
}
