import { accountFromRemote, mergeAccounts } from './core.js?v=3.0.1';

// Pure transaction plan. No history replacement, deletion, or whole-document overwrite.
export function planSync(data, local) {
  const remote = accountFromRemote(data);
  const merged = mergeAccounts(local, remote);
  const known = new Map(remote.records.map(r => [r.id, r]));
  const pending = local.records.filter(r => !known.has(r.id) || r.updatedAt > known.get(r.id).updatedAt ||
    (r.updatedAt === known.get(r.id).updatedAt && r.deletedAt && !known.get(r.id).deletedAt));
  const fields = {};
  if ((local.taskState.updatedAt || '') > (remote.taskState.updatedAt || '')) fields.syncState = local.taskState;
  if ((local.wishState.updatedAt || '') > (remote.wishState.updatedAt || '')) fields.wishState = local.wishState;
  return { merged, pending, fields };
}
