export const VERSION = '3.0.2';
export const STORAGE_KEY = 'fafaAccountV3';
export const BACKUP_KEY = 'fafaBackupBeforeV3';
export const LEGACY_KEYS = ['fafaBalance', 'fafaHistory', 'taskProgress', 'resetState', 'stateUpdatedAt', 'lastDailyReset', 'lastWeekReset', 'lastWeek', 'weeklyTasks'];
export const TASKS = [
  { name: '每周领零花钱', icon: '🪙', amount: 10, max: 1, period: 'weekly' },
  { name: '洗脸刷牙', icon: '🪥', amount: 2, max: 10, period: 'weekly' },
  { name: '洗澡', icon: '🛁', amount: 4, max: 5, period: 'weekly' },
  { name: '攀岩课', icon: '🧗', amount: 6, max: 1, period: 'weekly' },
  { name: '游泳', icon: '🏊', iconImage: 'assets/swimming.png', amount: 6, max: 2, period: 'weekly' }
];
export const money = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export function parseAmount(value) {
  const text = String(value).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const amount = Math.round(Number(text) * 100) / 100;
  return amount > 0 ? amount : null;
}
export function legacyId(record, index) {
  const text = `${record.type}|${record.name}|${record.amount}|${record.date}|${index}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `legacy-${(hash >>> 0).toString(16)}`;
}
export function normalizeRecords(records) {
  if (!Array.isArray(records)) throw new Error('账目格式异常，原数据已保留，请先导出备份。');
  return records.map((record, index) => {
    if (!record || !['收入', '支出'].includes(record.type) || !Number.isFinite(Number(record.amount)) || Number(record.amount) < 0) {
      throw new Error('发现无法识别的账目，已停止写入，请先导出备份。');
    }
    return { ...record, id: record.id || legacyId(record, index),
      createdAt: record.createdAt || record.date || new Date(0).toISOString(),
      updatedAt: record.updatedAt || record.createdAt || record.date || new Date(0).toISOString(),
      deletedAt: record.deletedAt || null };
  });
}
export function mergeRecords(...groups) {
  const map = new Map();
  for (const group of groups) for (const record of normalizeRecords(group || [])) {
    const previous = map.get(record.id);
    if (!previous || record.updatedAt > previous.updatedAt ||
      (record.updatedAt === previous.updatedAt && record.deletedAt && !previous.deletedAt)) map.set(record.id, record);
  }
  return [...map.values()];
}
export function balanceOf(records) {
  return records.reduce((cents, record) => cents + (record.deletedAt ? 0 : Math.round(Number(record.amount) * 100) * (record.type === '收入' ? 1 : -1)), 0) / 100;
}
export function visibleRecords(records) {
  const epoch = r => Date.parse(String(r.createdAt || r.date).replace(/^(\d{4})\/(\d+)\/(\d+)/, '$1-$2-$3')) || 0;
  return records.filter(r => !r.deletedAt).sort((a, b) => epoch(b) - epoch(a) || b.id.localeCompare(a.id));
}
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function weekKey(date = new Date()) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const week = Math.ceil((((utc - new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}
export const emptyTaskState = () => ({ taskProgress: {}, resetState: {}, updatedAt: '' });
export const emptyWishState = () => ({ item: null, updatedAt: '' });
export function taskCount(state, task, date = new Date()) {
  const field = task.period === 'daily' ? 'lastDailyReset' : 'lastWeekReset';
  const key = task.period === 'daily' ? dateKey(date) : weekKey(date);
  return state.resetState?.[field] === key ? Number(state.taskProgress?.[task.name] || 0) : 0;
}
export function currentTaskState(state, date = new Date()) {
  return { ...state, taskProgress: Object.fromEntries(TASKS.map(t => [t.name, taskCount(state, t, date)])),
    resetState: { lastDailyReset: dateKey(date), lastWeekReset: weekKey(date) } };
}
export function newerState(a, b) { return (b?.updatedAt || '') > (a?.updatedAt || '') ? b : a; }
export function nextTimestamp(...timestamps) {
  return new Date(Math.max(Date.now(), ...timestamps.map(t => (Date.parse(t) || 0) + 1))).toISOString();
}
export function emptyAccount() { return { schemaVersion: 3, records: [], taskState: emptyTaskState(), wishState: emptyWishState() }; }
export function accountFromRemote(data) {
  return { schemaVersion: 3, records: mergeRecords(data.history || [], data.recordEvents || []),
    taskState: data.syncState || { taskProgress: data.taskProgress || {}, resetState: data.resetState || {}, updatedAt: data.lastUpdate || '' },
    wishState: data.wishState || emptyWishState() };
}
export function mergeAccounts(local, remote) {
  return { schemaVersion: 3, records: mergeRecords(remote.records, local.records),
    taskState: newerState(local.taskState, remote.taskState), wishState: newerState(local.wishState, remote.wishState) };
}
export function wishProgress(account) {
  const item = account.wishState.item;
  if (!item || !(item.price > 0)) return null;
  const balance = balanceOf(account.records);
  return { item, balance, reached: balance >= item.price, remaining: Math.max(0, Math.round((item.price - balance) * 100) / 100),
    percent: Math.min(100, Math.max(0, balance / item.price * 100)) };
}
export function makeRecord(type, name, amount, now = new Date()) {
  return { id: globalThis.crypto.randomUUID(), type, name, amount, date: now.toLocaleString('zh-CN'),
    createdAt: now.toISOString(), updatedAt: now.toISOString(), deletedAt: null };
}
export function snapshotLocal(storage) {
  return Object.fromEntries([...LEGACY_KEYS, STORAGE_KEY].map(k => [k, storage.getItem(k)]).filter(([, v]) => v !== null));
}
export function loadAccount(storage) {
  // Back up exact strings BEFORE parsing or writing anything, including malformed old data.
  const raw = snapshotLocal(storage);
  if (!storage.getItem(BACKUP_KEY)) {
    const snapshot = JSON.stringify({ capturedAt: new Date().toISOString(), version: VERSION, raw });
    storage.setItem(BACKUP_KEY, snapshot);
    if (storage.getItem(BACKUP_KEY) !== snapshot) throw new Error('本机备份校验未通过，已停止升级。');
  }
  if (raw[STORAGE_KEY]) {
    const account = JSON.parse(raw[STORAGE_KEY]);
    if (account.schemaVersion !== 3 || !account.taskState || !account.wishState) throw new Error('本机账本格式异常，已保留原数据。');
    account.records = normalizeRecords(account.records);
    return account;
  }
  const parse = (key, fallback) => raw[key] ? JSON.parse(raw[key]) : fallback;
  return { schemaVersion: 3, records: normalizeRecords(parse('fafaHistory', [])),
    taskState: { taskProgress: parse('taskProgress', {}), resetState: parse('resetState', {
      lastDailyReset: raw.lastDailyReset || '', lastWeekReset: raw.lastWeekReset || '' }), updatedAt: raw.stateUpdatedAt || '' },
    wishState: emptyWishState() };
}
export function saveAccount(storage, account) {
  // Single atomic localStorage write: a failed/quota-full save cannot partially alter the account.
  storage.setItem(STORAGE_KEY, JSON.stringify(account));
  // v2 keys and the pre-upgrade snapshot stay untouched as a second recovery source.
}
