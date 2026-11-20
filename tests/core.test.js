import test from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, STORAGE_KEY, BACKUP_KEY, loadAccount, saveAccount, mergeAccounts, mergeRecords, balanceOf,
  visibleRecords, wishProgress, emptyAccount, accountFromRemote, parseAmount, currentTaskState, taskCount, weekKey, makeRecord } from '../core.js';
import { planSync } from '../sync-engine.js';

const record = (id, amount = 10, extra = {}) => ({ id, type: '收入', name: '测试', amount,
  date: '2026/11/17 10:00:00', createdAt: '2026-11-17T02:00:00.000Z', updatedAt: '2026-11-17T02:00:00.000Z', deletedAt: null, ...extra });
function memory(initial = {}) { const data = new Map(Object.entries(initial)); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) }; }
test('legacy migration preserves IDs, dates, tombstones, counts and exact raw backup', () => {
  const legacy = [{ type: '收入', name: '旧账', amount: 80, date: '2026/11/17 08:00:00' }, record('spent', 12, { type: '支出' }), record('removed', 100, { deletedAt: '2026-11-17T03:00:00.000Z' })];
  const raw = JSON.stringify(legacy), counts = JSON.stringify({ 洗脸刷牙: 2, 洗澡: 1 });
  const storage = memory({ fafaHistory: raw, taskProgress: counts, resetState: JSON.stringify({ lastDailyReset: '2026-11-17', lastWeekReset: '2026-47' }), stateUpdatedAt: '2026-11-17T03:00:00.000Z' });
  const account = loadAccount(storage), backup = storage.getItem(BACKUP_KEY);
  assert.equal(balanceOf(account.records), 68); assert.equal(account.records.length, 3); assert.equal(account.records[2].deletedAt, legacy[2].deletedAt);
  assert.equal(account.taskState.taskProgress['洗脸刷牙'], 2);
  assert.equal(JSON.parse(backup).raw.fafaHistory, raw);
  saveAccount(storage, account); const reloaded = loadAccount(storage);
  assert.deepEqual(reloaded, account); assert.equal(storage.getItem(BACKUP_KEY), backup);
  assert.equal(storage.getItem('fafaHistory'), raw); assert.equal(storage.getItem('taskProgress'), counts);
});
test('corrupt local history is preserved and fails closed, never replaced with an empty array', () => {
  const storage = memory({ fafaHistory: '{broken' }); assert.throws(() => loadAccount(storage));
  assert.equal(storage.getItem('fafaHistory'), '{broken'); assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(JSON.parse(storage.getItem(BACKUP_KEY)).raw.fafaHistory, '{broken');
});
test('backup storage failure blocks migration and leaves legacy content untouched', () => {
  const storage = memory({ fafaHistory: '[]' }); storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => loadAccount(storage)); assert.equal(storage.getItem('fafaHistory'), '[]');
});
test('failed v3 save keeps the previous committed account intact', () => {
  const storage = memory(), original = emptyAccount(); saveAccount(storage, original);
  storage.setItem = () => { throw new Error('quota'); };
  const next = emptyAccount(); next.records.push(record('new'));
  assert.throws(() => saveAccount(storage, next)); assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), original);
});
test('delayed sync response cannot drop a locally added record', () => {
  const local = emptyAccount(); local.records = [record('A'), record('new-during-sync', 4)];
  const response = emptyAccount(); response.records = [record('A'), record('remote', 2)];
  const merged = mergeAccounts(local, response);
  assert.equal(merged.records.length, 3); assert.equal(balanceOf(merged.records), 16);
  assert.deepEqual(mergeAccounts(merged, response), merged);
});
test('record retries deduplicate by stable id and preserve newer soft deletion', () => {
  const old = record('A'), removed = record('A', 10, { updatedAt: '2026-11-17T03:00:00.000Z', deletedAt: '2026-11-17T03:00:00.000Z' });
  const records = mergeRecords([old], [removed], [old]); assert.equal(records.length, 1); assert.equal(balanceOf(records), 0);
  assert.equal(records[0].deletedAt, removed.deletedAt);
});
test('opening an already synced account has no write plan, even with legacy history', () => {
  const history = [{ type: '收入', name: '旧记录', amount: 30, date: '2026/11/01 08:00:00' }];
  const remote = { history, recordEvents: [record('A')], syncState: { taskProgress: { 洗澡: 1 }, resetState: {}, updatedAt: '2026-11-17T02:00:00.000Z' } };
  const original = structuredClone(remote), local = accountFromRemote(remote);
  const plan = planSync(remote, local); assert.deepEqual(plan.pending, []); assert.deepEqual(plan.fields, {}); assert.deepEqual(remote, original);
});
test('sync uploads only new events and independent wish field, never history or balance', () => {
  const remote = { history: [record('old')], recordEvents: [record('A')], unknownField: 'keep' };
  const local = accountFromRemote(remote); local.records.push(record('B'));
  local.wishState = { item: { name: '测试愿望', price: 100, photo: 'test' }, updatedAt: '2026-11-17T03:00:00.000Z' };
  const plan = planSync(remote, local); assert.deepEqual(plan.pending.map(r => r.id), ['B']);
  assert.deepEqual(Object.keys(plan.fields), ['wishState']); assert.equal(remote.unknownField, 'keep'); assert.equal(remote.history.length, 1);
});
test('older wish cannot restore a removed goal or overwrite a concurrent newer goal', () => {
  const remote = { wishState: { item: null, updatedAt: '2026-11-17T05:00:00.000Z' } };
  const local = emptyAccount(); local.wishState = { item: { price: 100 }, updatedAt: '2026-11-17T04:00:00.000Z' };
  const plan = planSync(remote, local); assert.equal(plan.merged.wishState.item, null); assert.deepEqual(plan.fields, {});
});
test('wish changes do not change accounting; reach flag responds to spending, editing and removal', () => {
  const account = emptyAccount(); account.records = [record('income', 108)];
  account.wishState = { item: { name: '玩偶', price: 100 }, updatedAt: 'now' };
  assert.equal(wishProgress(account).reached, true); assert.equal(wishProgress(account).percent, 100); assert.equal(balanceOf(account.records), 108);
  account.records.push(record('expense', 40, { type: '支出' }));
  assert.equal(wishProgress(account).reached, false); assert.equal(wishProgress(account).remaining, 32);
  account.wishState.item.price = 60; assert.equal(wishProgress(account).reached, true);
  account.wishState.item = null; assert.equal(wishProgress(account), null); assert.equal(balanceOf(account.records), 68);
});
test('weekly limits are 10 and 5; existing progress survives the switch and midnight', () => {
  const today = new Date(2026, 10, 17, 12);
  const state = currentTaskState({ taskProgress: { 洗脸刷牙: 2, 洗澡: 1 }, resetState: { lastDailyReset: '2026-11-17', lastWeekReset: weekKey(today) } }, today);
  assert.equal(TASKS[1].max, 10); assert.equal(TASKS[2].max, 5);
  assert.equal(TASKS[1].period, 'weekly'); assert.equal(TASKS[2].period, 'weekly');
  assert.equal(taskCount(state, TASKS[1], today), 2); assert.equal(taskCount(state, TASKS[2], today), 1);
  for (const task of [TASKS[1], TASKS[2]]) {
    assert.equal(taskCount(state, task, new Date(2026, 10, 18, 0)), state.taskProgress[task.name]);
    assert.equal(taskCount(state, task, new Date(2026, 10, 22, 23, 59)), state.taskProgress[task.name]);
    assert.equal(taskCount(state, task, new Date(2026, 10, 23, 0)), 0);
  }
});
test('all weekly counts roll over together, including ISO weeks across New Year', () => {
  const date = new Date(2026, 11, 31, 12);
  const state = currentTaskState(emptyAccount().taskState, date);
  state.taskProgress = Object.fromEntries(TASKS.map(t => [t.name, t.max]));
  for (const task of TASKS) {
    assert.equal(taskCount(state, task, new Date(2027, 0, 3, 23, 59)), task.max);
    assert.equal(taskCount(state, task, new Date(2027, 0, 4, 0)), 0);
  }
  assert.deepEqual(currentTaskState(state, new Date(2027, 0, 4, 0)).taskProgress, Object.fromEntries(TASKS.map(t => [t.name, 0])));
});
test('amount validation supports cents, rejects truncation, negative values and exponent notation', () => {
  assert.equal(parseAmount('12.50'), 12.5); assert.equal(parseAmount('0.01'), .01);
  for (const input of ['0', '-1', '1.234', '12abc', '1e3', 'Infinity', '']) assert.equal(parseAmount(input), null);
  assert.equal(balanceOf([record('a', .1), record('b', .2)]), .3);
});
test('swimming starts independently; climbing price changes never reprice existing records', () => {
  const today = new Date(2026, 10, 20, 12);
  const climbing = TASKS.find(t => t.name === '攀岩课'), swimming = TASKS.find(t => t.name === '游泳');
  assert.equal(climbing.amount, 6); assert.equal(climbing.max, 1);
  assert.equal(swimming.amount, 6); assert.equal(swimming.max, 2); assert.equal(swimming.period, 'weekly');
  const previous = { taskProgress: { 攀岩课: 1, 洗澡: 3 }, resetState: { lastWeekReset: weekKey(today) }, updatedAt: today.toISOString() };
  const next = currentTaskState(previous, today);
  assert.equal(taskCount(next, swimming, today), 0);
  assert.equal(taskCount(next, climbing, today), 1); assert.equal(next.taskProgress['洗澡'], 3);
  assert.equal(previous.taskProgress['游泳'], undefined);
  next.taskProgress['游泳'] = 2;
  assert.equal(taskCount(next, swimming, new Date(2026, 10, 22)), 2);
  assert.equal(taskCount(next, swimming, new Date(2026, 10, 23)), 0);
  const remote = { history: [record('old-climb', 10, { name: '攀岩课' })], syncState: previous };
  const account = accountFromRemote(remote);
  assert.equal(balanceOf(account.records), 10);
  assert.deepEqual(planSync(remote, account).pending, []);
  account.records.push(makeRecord('收入', climbing.name, climbing.amount));
  account.records.push(makeRecord('收入', swimming.name, swimming.amount));
  assert.equal(balanceOf(account.records), 22);
  assert.equal(account.records.find(r => r.id === 'old-climb').amount, 10);
});
test('history sorts by date rather than merge order and hides tombstones only in the view', () => {
  const records = [record('old'), record('new', 1, { createdAt: '2026-11-18T00:00:00Z' }), record('deleted', 3, { deletedAt: 'yes' })];
  assert.deepEqual(visibleRecords(records).map(r => r.id), ['new', 'old']); assert.equal(records.length, 3);
});
