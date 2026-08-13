import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc, arrayUnion } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey: 'AIzaSyAs9N_KZX-XKhzIau_SGOXTmCIfNHfxf6E',
    authDomain: 'fafa-account.firebaseapp.com',
    projectId: 'fafa-account',
    storageBucket: 'fafa-account.firebasestorage.app',
    messagingSenderId: '1047424115167',
    appId: '1:1047424115167:web:999194a9cd85ebf29de46a'
};

const accountId = 'fafa_main_account';
const db = getFirestore(initializeApp(firebaseConfig));
const accountRef = doc(db, 'users', accountId);
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
        createdAt: record.createdAt || record.date || new Date(0).toISOString(),
        updatedAt: record.updatedAt || record.createdAt || record.date || new Date(0).toISOString(),
        deletedAt: record.deletedAt || null
    };
}

function mergeRecords(...groups) {
    const merged = new Map();
    groups.flat().forEach((raw, index) => {
        if (!raw) return;
        const record = normalize(raw, index);
        const previous = merged.get(record.id);
        if (!previous || (record.updatedAt || '') >= (previous.updatedAt || '')) {
            merged.set(record.id, record);
        }
    });
    return [...merged.values()];
}

async function readRemote() {
    const snapshot = await getDoc(accountRef);
    const data = snapshot.exists() ? snapshot.data() : {};
    return {
        data,
        records: mergeRecords(data.history || [], data.recordEvents || []),
        state: data.syncState || {
            taskProgress: data.taskProgress || {},
            resetState: data.resetState || {},
            updatedAt: data.lastUpdate || ''
        }
    };
}

async function appendEvents(records, remoteRecords) {
    const remoteById = new Map(remoteRecords.map(record => [record.id, record]));
    const pending = records.filter(record => {
        const remote = remoteById.get(record.id);
        return !remote || (record.updatedAt || '') > (remote.updatedAt || '');
    });

    // 每笔变化只追加事件，不写回 history，因此短列表永远不会覆盖完整历史。
    for (let offset = 0; offset < pending.length; offset += 100) {
        const chunk = pending.slice(offset, offset + 100);
        await setDoc(accountRef, {
            recordEvents: arrayUnion(...chunk),
            lastSafeSync: new Date().toISOString()
        }, { merge: true });
    }
    return pending.length;
}

function friendlyError(error) {
    const code = error && error.code ? String(error.code) : '';
    if (code.includes('permission-denied')) return 'Firebase 权限被拒绝';
    if (code.includes('unavailable')) return 'Firebase 暂时无法连接';
    if (/超时/.test(String(error && error.message))) return 'Firebase 连接超时';
    return 'Firebase 同步失败';
}

async function doSync(localRecords, localState) {
    emit('connecting', '正在检查 Firebase…');
    try {
        const remote = await timeout(readRemote(), 10000, 'Firebase 连接超时');
        connected = true;
        emit('syncing', '正在安全合并记录…');
        const records = mergeRecords(remote.records, localRecords);
        const uploaded = await appendEvents(records, remote.records);

        const remoteTime = remote.state.updatedAt || '';
        const localTime = localState.updatedAt || '';
        const state = remoteTime > localTime ? remote.state : localState;
        if (localTime >= remoteTime) {
            await setDoc(accountRef, {
                syncState: localState,
                lastSafeSync: new Date().toISOString()
            }, { merge: true });
        }
        emit('online', uploaded ? `已同步 ${uploaded} 条记录` : '云端已同步');
        return { online: true, records, state };
    } catch (error) {
        connected = false;
        console.warn('Firebase 暂时不可用：', error);
        emit('offline', `${friendlyError(error)}，记录已保存在本机`);
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
window.addEventListener('offline', () => emit('offline', '网络已断开，记录已保存在本机'));
