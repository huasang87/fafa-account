import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
    getFirestore, doc, getDoc, setDoc, collection, getDocs,
    writeBatch, query, where
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey: 'AIzaSyAs9N_KZX-XKhzIau_SGOXTmCIfNHfxf6E',
    authDomain: 'fafa-account.firebaseapp.com',
    projectId: 'fafa-account',
    storageBucket: 'fafa-account.firebasestorage.app',
    messagingSenderId: '1047424115167',
    appId: '1:1047424115167:web:999194a9cd85ebf29de46a'
};

const accountId = 'fafa_main_account';
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const legacyRef = doc(db, 'users', accountId);
const stateRef = doc(db, 'ledger_state', accountId);
const recordsRef = collection(db, 'ledger_records');
let connected = false;
let running = null;

function emit(state, message) {
    window.dispatchEvent(new CustomEvent('fafa-sync-status', { detail: { state, message } }));
}

function timeout(promise, milliseconds, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })
    ]).finally(() => clearTimeout(timer));
}

function legacyId(record, index) {
    const input = `${record.type}|${record.name}|${record.amount}|${record.date}|${index}`;
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `legacy-${(hash >>> 0).toString(16)}`;
}

function normalize(record, index = 0) {
    return {
        ...record,
        id: record.id || legacyId(record, index),
        accountId,
        createdAt: record.createdAt || record.date || new Date(0).toISOString(),
        updatedAt: record.updatedAt || record.createdAt || record.date || new Date(0).toISOString(),
        deletedAt: record.deletedAt || null
    };
}

async function readRemote() {
    const [recordSnapshot, stateSnapshot, legacySnapshot] = await Promise.all([
        getDocs(query(recordsRef, where('accountId', '==', accountId))),
        getDoc(stateRef),
        getDoc(legacyRef)
    ]);
    const records = recordSnapshot.docs.map(item => normalize(item.data()));
    let state = stateSnapshot.exists() ? stateSnapshot.data() : null;

    // 兼容原数据库：仅在逐条记录集合为空时读取旧文档，绝不反向清空旧数据。
    if (!records.length && legacySnapshot.exists()) {
        const legacy = legacySnapshot.data();
        (legacy.history || []).forEach((record, index) => records.push(normalize(record, index)));
        if (!state) {
            state = {
                taskProgress: legacy.taskProgress || {},
                resetState: legacy.resetState || {},
                updatedAt: legacy.lastUpdate || ''
            };
        }
    }
    return { records, state };
}

async function uploadRecords(records, remoteById) {
    const pending = records.filter(record => {
        const remote = remoteById.get(record.id);
        return !remote || (record.updatedAt || '') > (remote.updatedAt || '');
    });
    for (let offset = 0; offset < pending.length; offset += 400) {
        const batch = writeBatch(db);
        pending.slice(offset, offset + 400).forEach(record => {
            batch.set(doc(recordsRef, record.id), { ...record, accountId }, { merge: true });
        });
        await batch.commit();
    }
    return pending.length;
}

async function doSync(localRecords, localState) {
    emit('connecting', '正在检查 Firebase…');
    try {
        const remote = await timeout(readRemote(), 10000, 'Firebase 连接超时');
        connected = true;
        emit('syncing', '正在安全合并记录…');

        const remoteById = new Map(remote.records.map(record => [record.id, record]));
        const merged = new Map(remoteById);
        localRecords.map(normalize).forEach(record => {
            const previous = merged.get(record.id);
            if (!previous || (record.updatedAt || '') >= (previous.updatedAt || '')) merged.set(record.id, record);
        });
        const records = [...merged.values()];
        const uploaded = await uploadRecords(records, remoteById);

        const remoteTime = remote.state ? (remote.state.updatedAt || '') : '';
        const localTime = localState.updatedAt || '';
        const state = remoteTime > localTime ? remote.state : localState;
        if (!remote.state || localTime >= remoteTime) {
            await setDoc(stateRef, { ...localState, accountId }, { merge: true });
        }
        emit('online', uploaded ? `已同步 ${uploaded} 条记录` : '云端已同步');
        return { online: true, records, state };
    } catch (error) {
        connected = false;
        console.warn('Firebase 暂时不可用：', error);
        emit('offline', '当前离线，记录已安全保存在本机');
        return { online: false, records: localRecords, state: localState };
    }
}

function sync(localRecords, localState) {
    if (running) return running.then(() => sync(localRecords, localState));
    running = doSync(localRecords, localState).finally(() => { running = null; });
    return running;
}

window.FafaSync = { sync, isConnected: () => connected };
window.dispatchEvent(new CustomEvent('fafa-sync-ready'));
window.addEventListener('online', () => window.dispatchEvent(new CustomEvent('fafa-network-restored')));
window.addEventListener('offline', () => emit('offline', '网络已断开，记录已安全保存在本机'));
