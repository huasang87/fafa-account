import { VERSION, TASKS, BACKUP_KEY, STORAGE_KEY, money, parseAmount, loadAccount, saveAccount,
  emptyAccount, mergeAccounts, balanceOf, visibleRecords, wishProgress, taskCount, currentTaskState,
  nextTimestamp, makeRecord, snapshotLocal } from './core.js?v=3.0.2';

const $ = id => document.getElementById(id);
const preview = new URLSearchParams(location.search).get('preview') === '1';
// Preview never imports Firebase and uses a separate storage namespace.
const storage = preview ? { getItem: k => sessionStorage.getItem(`fafaPreview:${k}`), setItem: (k, v) => sessionStorage.setItem(`fafaPreview:${k}`, v) } : localStorage;
let account = emptyAccount(), activeTab = 'earn', blocked = false, syncModule, syncing = false, revision = 0;
let lastFocus, toastTimer, busyPhoto = false;
const dialog = $('dialog');

function setStatus(state, text) { $('syncStatus').dataset.state = state; $('syncStatus').querySelector('span').textContent = text; }
function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
function showStorageError(error) {
  $('storageError').hidden = false;
  $('storageError').textContent = `${error.message || '本机保存失败'} 原账目未清除。可在「记录」中导出备份。`;
}
function commit(next) {
  if (blocked) { toast('请先导出备份并处理本机存储问题'); return false; }
  try { saveAccount(storage, next); } catch (error) { showStorageError(error); return false; }
  account = next; revision++; render(); void syncNow(); return true;
}
function cloneAccount() { return structuredClone(account); }

async function syncNow() {
  if (preview) { setStatus('online', '预览 · 本机示例'); return; }
  if (blocked || syncing) return;
  syncing = true;
  const startingRevision = revision;
  let warning;
  try {
    setStatus('connecting', '正在同步…');
    warning = setTimeout(() => setStatus('offline', '连接较慢 · 本机已保存'), 12000);
    syncModule ||= await import('./firebase-sync.js?v=3.0.2');
    const remote = await syncModule.syncAccount(cloneAccount());
    // Account may have changed while the network request was in flight.
    const merged = mergeAccounts(account, remote);
    saveAccount(storage, merged);
    account = merged;
    render();
    setStatus('online', '云端已同步');
  } catch (error) {
    console.warn('账本同步暂不可用', error.code || error.message);
    setStatus('offline', error.code === 'permission-denied' ? '同步受限 · 本机已保存' : '未同步 · 本机已保存');
  } finally {
    clearTimeout(warning); syncing = false;
    if (revision !== startingRevision) setTimeout(() => void syncNow(), 0);
  }
}

function render() {
  $('balance').textContent = money(balanceOf(account.records));
  renderTasks(); renderHistory(); renderWish(); updateExpensePreview();
}
function renderTasks() {
  $('taskList').replaceChildren(...TASKS.map(task => {
    const count = taskCount(account.taskState, task);
    const button = document.createElement('button');
    button.className = `task-card${count >= task.max ? ' completed' : ''}`;
    button.setAttribute('aria-label', `${task.name}，奖励${task.amount}元，已完成${count}次，上限${task.max}次`);
    button.innerHTML = `<span class="task-icon" aria-hidden="true">${task.icon}</span><span class="task-name">${task.name}</span><span class="task-reward">+${task.amount} 元</span><span class="task-count">${count}/${task.max}</span>`;
    if (task.iconImage) {
      const image = document.createElement('img'); image.src = task.iconImage; image.alt = '';
      image.className = 'task-image'; button.querySelector('.task-icon').replaceChildren(image);
    }
    button.addEventListener('click', () => earn(task, button));
    return button;
  }));
}
function earn(task, button) {
  if (taskCount(account.taskState, task) >= task.max) {
    message('⏰', '这个任务完成啦', `${task.name}已经完成 ${task.max} 次啦！\n${task.period === 'daily' ? '明天' : '下周一'}再来继续赚钱吧。`); return;
  }
  const origin = button.getBoundingClientRect();
  const next = cloneAccount();
  next.taskState = currentTaskState(next.taskState);
  next.taskState.taskProgress[task.name]++;
  next.taskState.updatedAt = nextTimestamp(next.taskState.updatedAt);
  next.records.unshift(makeRecord('收入', task.name, task.amount));
  if (commit(next)) { coinAnimation(origin); toast(`完成${task.name}，存入 ${task.amount} 元`); }
}
function coinAnimation(origin) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = $('bank').getBoundingClientRect();
  for (let i = 0; i < 4; i++) setTimeout(() => {
    const coin = document.createElement('span'); coin.textContent = '🪙'; coin.className = 'coin-fly';
    coin.style.left = `${origin.left + origin.width / 2}px`; coin.style.top = `${origin.top + 20}px`;
    coin.style.setProperty('--dx', `${target.left + target.width * .3 - origin.left - origin.width / 2}px`);
    coin.style.setProperty('--dy', `${target.top + target.height * .5 - origin.top - 20}px`);
    document.body.append(coin); setTimeout(() => coin.remove(), 800);
  }, i * 60);
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    const ctx = new Audio(), oscillator = ctx.createOscillator(), gain = ctx.createGain();
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(880, ctx.currentTime); oscillator.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + .09);
    gain.gain.setValueAtTime(.05, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .2);
    oscillator.connect(gain); gain.connect(ctx.destination); oscillator.start(); oscillator.stop(ctx.currentTime + .2);
    oscillator.onended = () => void ctx.close();
  } catch { /* Audio is optional and never blocks recording. */ }
}
function renderHistory() {
  const records = visibleRecords(account.records);
  $('historyList').replaceChildren();
  $('clearData').disabled = !records.length;
  if (!records.length) {
    const empty = document.createElement('div'); empty.className = 'empty-history'; empty.textContent = '📖 还没有记录\n完成一个任务，就能存下第一笔钱啦';
    empty.style.whiteSpace = 'pre-line'; $('historyList').append(empty); $('historyNote').textContent = ''; return;
  }
  records.slice(0, 20).forEach(record => {
    const row = document.createElement('div'); row.className = 'history-row';
    const icon = document.createElement('span'); icon.className = 'history-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = TASKS.find(t => t.name === record.name)?.icon || (record.type === '收入' ? '🪙' : '🛍️');
    const taskImage = TASKS.find(t => t.name === record.name)?.iconImage;
    if (taskImage) {
      const image = document.createElement('img'); image.src = taskImage; image.alt = '';
      image.className = 'task-image'; icon.replaceChildren(image);
    }
    const copy = document.createElement('div'); copy.className = 'history-copy';
    const name = document.createElement('div'); name.className = 'history-name'; name.textContent = record.name;
    const date = document.createElement('div'); date.className = 'history-date'; date.textContent = record.date;
    const amount = document.createElement('span'); amount.className = `history-amount ${record.type === '收入' ? 'income' : 'expense'}`;
    amount.textContent = `${record.type === '收入' ? '+' : '−'}${money(record.amount)} 元`;
    copy.append(name, date); row.append(icon, copy, amount); $('historyList').append(row);
  });
  $('historyNote').textContent = records.length > 20 ? `显示最近 20 条 · 共 ${records.length} 条，完整记录可导出备份` : `共 ${records.length} 条记录`;
}
function safePhoto(url) { return typeof url === 'string' && /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(url) ? url : 'assets/rabbit-bank.png'; }
function renderWish() {
  const progress = wishProgress(account);
  $('wishEmpty').hidden = !!progress; $('wishDetail').hidden = !progress;
  $('wishStrip').hidden = !progress; $('wishBadge').hidden = !progress?.reached;
  if (!progress) return;
  const { item, balance, reached, remaining, percent } = progress;
  const thumb = document.createElement('img'); thumb.src = safePhoto(item.photo); thumb.alt = ''; $('wishThumb').replaceChildren(thumb);
  $('wishStripName').textContent = item.name;
  $('wishStripStatus').textContent = reached ? '✓ 已攒够' : `还差 ${money(remaining)} 元`;
  $('wishStripStatus').className = reached ? 'is-ready' : '';
  $('wishPhoto').src = safePhoto(item.photo); $('wishPhoto').alt = item.name;
  $('wishName').textContent = item.name; $('wishPrice').textContent = `¥${money(item.price)}`;
  $('wishSaved').textContent = `¥${money(balance)}`;
  $('wishProgressBar').setAttribute('aria-valuenow', String(Math.round(percent))); $('wishProgressBar').querySelector('i').style.width = `${percent}%`;
  $('wishRemaining').textContent = reached ? '✓ 已攒够，可以带它回家啦！' : `还差 ${money(remaining)} 元，就能带它回家啦`;
  $('wishRemaining').className = reached ? 'is-ready' : '';
}
function switchTab(tab) {
  activeTab = tab;
  for (const name of ['earn', 'spend', 'history', 'wish']) $(`${name}Section`).hidden = tab !== name;
  $('bank').hidden = tab === 'wish';
  $('pageTitle').textContent = tab === 'wish' ? '♡ 想买的' : '✦ Fafa的账本 ✦';
  document.querySelectorAll('[data-tab]').forEach(button => {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function updateExpensePreview() {
  const amount = parseAmount($('expenseAmount').value);
  const balance = balanceOf(account.records);
  $('expensePreview').textContent = !amount ? '记下每一笔小小的花费' : amount > balance ? `现在有 ${money(balance)} 元，还差 ${money(amount - balance)} 元` : `记账后还剩 ${money(balance - amount)} 元`;
}
function closeDialog() { dialog.close(); lastFocus?.focus?.(); }
function openDialog(title, body, { sheet = false, centered = false } = {}) {
  if (dialog.open) dialog.close();
  lastFocus = document.activeElement; dialog.className = sheet ? 'sheet' : '';
  $('dialogContent').innerHTML = `<div class="dialog-body${centered ? ' dialog-centered' : ''}"><button class="dialog-close" aria-label="关闭">×</button><h2 id="dialogTitle" class="dialog-title"></h2><div class="dialog-inner"></div></div>`;
  $('dialogTitle').textContent = title;
  dialog.querySelector('.dialog-inner').append(body);
  dialog.querySelector('.dialog-close').onclick = closeDialog;
  dialog.showModal();
}
function message(icon, title, text, actions = [{ label: '知道啦', action: closeDialog, kind: 'primary' }]) {
  const body = document.createElement('div');
  const art = document.createElement('div'); art.className = 'dialog-icon'; art.textContent = icon;
  const copy = document.createElement('p'); copy.className = 'dialog-message'; copy.textContent = text;
  const buttons = document.createElement('div'); buttons.className = 'dialog-actions';
  for (const item of actions) { const button = document.createElement('button'); button.className = `button ${item.kind || 'secondary'}`; button.textContent = item.label; button.onclick = item.action; buttons.append(button); }
  body.append(art, copy, buttons); openDialog(title, body, { centered: true });
}
function addExpense(type, name, amount, onSuccess) {
  if (!name || !amount) return false;
  const current = balanceOf(account.records);
  if (type === '支出' && amount > current) {
    message('🐰', '小金库还差一点', `这次要花 ${money(amount)} 元\n现在有 ${money(current)} 元，还差 ${money(amount - current)} 元`, [
      { label: '改一下金额', kind: 'primary', action: () => { closeDialog(); if (activeTab === 'spend') $('expenseAmount').focus(); else showRecordForm({ type, name, amount }); } },
      { label: '先不买了', action: closeDialog }
    ]); return false;
  }
  const next = cloneAccount(); next.records.unshift(makeRecord(type, name, amount));
  if (!commit(next)) return false;
  onSuccess?.();
  message('✓', '记好啦！', `${name}  ${type === '收入' ? '+' : '−'}${money(amount)} 元\n小金库还剩 ${money(balanceOf(next.records))} 元`);
  return true;
}
function showRecordForm(initial = {}) {
  let type = initial.type || '收入';
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<div class="segmented"><button type="button" data-type="收入">收入</button><button type="button" data-type="支出">支出</button></div><label for="recordName">记账名称</label><input id="recordName" maxlength="60" placeholder="比如：生日红包" required autocomplete="off"><label for="recordAmount">金额</label><div class="money-input"><span>¥</span><input id="recordAmount" inputmode="decimal" placeholder="请输入金额" required autocomplete="off"></div><p class="field-error" id="recordError" role="alert"></p><button class="button primary" type="submit">保存记录</button>`;
  const updateType = () => form.querySelectorAll('[data-type]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
  form.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { type = b.dataset.type; updateType(); }); updateType();
  form.querySelector('#recordName').value = initial.name || ''; form.querySelector('#recordAmount').value = initial.amount || '';
  form.onsubmit = event => {
    event.preventDefault(); const name = $('recordName').value.trim(), amount = parseAmount($('recordAmount').value);
    if (!name || !amount) { $('recordError').textContent = '请填写名称和大于 0 的金额，最多两位小数。'; return; }
    addExpense(type, name, amount);
  };
  openDialog('记一笔', form, { sheet: true });
}

async function compressPhoto(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('请选择一张照片。');
  if (file.size > 20 * 1024 * 1024) throw new Error('照片有点大，请选择 20 MB 以内的图片。');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch { throw new Error('这张照片暂时无法打开，请换一张 JPG、PNG 或 WebP 图片。'); }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [.82, .7, .58, .45, .32, .22]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      // Limit the complete stored data URL, including base64 expansion, to 80 KiB.
      if (data.length <= 80 * 1024) return data;
    }
    throw new Error('照片细节太多，请裁剪后再试，原照片和愿望不会被修改。');
  } finally { URL.revokeObjectURL(url); }
}
function showWishForm() {
  const existing = account.wishState.item;
  const editing = !!existing, startingWishTime = account.wishState.updatedAt;
  let photo = existing?.photo || '', photoRequest = 0;
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<label class="upload-area" for="wishFile"><span class="upload-copy"><span class="upload-icon">▧</span><strong>上传照片</strong>拍照或从相册选择</span><input class="upload-file" id="wishFile" type="file" accept="image/*" aria-label="上传或更换愿望照片"></label><label for="wishInputName">想买什么</label><input id="wishInputName" maxlength="40" placeholder="例如：小兔子玩偶" required autocomplete="off"><label for="wishInputPrice">目标价格</label><div class="money-input"><span>¥</span><input id="wishInputPrice" inputmode="decimal" placeholder="请输入价格" required autocomplete="off"></div><p id="wishFormError" class="field-error" role="alert"></p><button id="saveWish" class="button primary" type="submit">${editing ? '保存修改' : '保存愿望'}</button><button id="cancelWishEdit" type="button" class="text-button">取消</button>`;
  const area = form.querySelector('.upload-area');
  const displayPhoto = () => {
    area.querySelector('img')?.remove(); area.querySelector('.upload-copy').hidden = !!photo;
    if (photo) { const img = document.createElement('img'); img.src = safePhoto(photo); img.alt = '愿望照片预览'; area.prepend(img); }
  };
  const valid = () => { form.querySelector('#saveWish').disabled = busyPhoto || !photo || !form.querySelector('#wishInputName').value.trim() || !parseAmount(form.querySelector('#wishInputPrice').value); };
  form.querySelector('#wishInputName').value = existing?.name || ''; form.querySelector('#wishInputPrice').value = existing?.price || '';
  busyPhoto = false; displayPhoto(); valid();
  form.oninput = valid;
  form.querySelector('#wishFile').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    const request = ++photoRequest; busyPhoto = true; valid(); form.querySelector('#wishFormError').textContent = '正在整理照片…';
    try { const converted = await compressPhoto(file); if (request === photoRequest) { photo = converted; displayPhoto(); form.querySelector('#wishFormError').textContent = ''; } }
    catch (error) { if (request === photoRequest) form.querySelector('#wishFormError').textContent = error.message; }
    finally { if (request === photoRequest) { busyPhoto = false; valid(); } }
  };
  form.querySelector('#cancelWishEdit').onclick = closeDialog;
  form.onsubmit = event => {
    event.preventDefault();
    const name = form.querySelector('#wishInputName').value.trim(), price = parseAmount(form.querySelector('#wishInputPrice').value);
    if (busyPhoto || !photo || !name || !price) return;
    if (account.wishState.updatedAt !== startingWishTime) {
      form.querySelector('#wishFormError').textContent = '另一台设备刚更新了愿望，请取消后重新打开，避免覆盖新内容。'; return;
    }
    const next = cloneAccount(); next.wishState = { item: { id: existing?.id || crypto.randomUUID(), name, price, photo }, updatedAt: nextTimestamp(account.wishState.updatedAt) };
    if (commit(next)) { closeDialog(); switchTab('wish'); toast(editing ? '愿望修改好了' : '一起慢慢攒起来吧'); }
  };
  openDialog(editing ? '编辑愿望' : '添加愿望', form, { sheet: true });
}
function exportBackup(reason = '手动备份') {
  try {
    const backup = { format: 'fafa-backup', version: VERSION, capturedAt: new Date().toISOString(), reason,
      account: blocked ? null : account, rawLocalStorage: snapshotLocal(storage), beforeUpgrade: storage.getItem(BACKUP_KEY) };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'), url = URL.createObjectURL(blob);
    link.href = url; link.download = `Fafa账本备份-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch (error) { showStorageError(error); return false; }
}
function confirmClear() {
  message('🧹', '要清空账本吗？', '记录、余额和任务进度将被清空。\n下一步需要验证家长密码。', [
    { label: '先保留', kind: 'primary', action: closeDialog }, { label: '继续', kind: 'danger', action: verifyParent }
  ]);
}
function verifyParent() {
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<p class="dialog-message">输入原有的家长密码后，才能清空账本。<br>会先保存一份清空前的备份。</p><label for="parentPin">家长密码</label><input id="parentPin" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required><p class="field-error" id="pinError" role="alert"></p><div class="dialog-actions"><button type="button" class="button secondary" id="cancelClear">取消</button><button type="submit" class="button danger" id="confirmClear" disabled>确认清空</button></div>`;
  form.querySelector('#cancelClear').onclick = closeDialog;
  form.oninput = () => { form.querySelector('#confirmClear').disabled = !/^\d{4}$/.test(form.querySelector('#parentPin').value); };
  form.onsubmit = event => {
    event.preventDefault();
    if (form.querySelector('#parentPin').value !== '0916') { form.querySelector('#pinError').textContent = '密码不对，请家长再试一次。'; return; }
    try { storage.setItem('fafaBackupBeforeClear', JSON.stringify({ capturedAt: new Date().toISOString(), account })); }
    catch (error) { showStorageError(error); return; }
    if (!exportBackup('清空前自动备份')) return;
    const next = cloneAccount(); const stamp = nextTimestamp(...next.records.map(r => r.updatedAt), next.taskState.updatedAt);
    // Preserve every record as a tombstone; never call deleteDoc or remove a database field.
    next.records = next.records.map(r => r.deletedAt ? r : { ...r, deletedAt: stamp, updatedAt: stamp });
    next.taskState = currentTaskState(next.taskState); next.taskState.taskProgress = Object.fromEntries(TASKS.map(t => [t.name, 0])); next.taskState.updatedAt = stamp;
    if (commit(next)) message('✓', '账本已清空', '已保留清空前备份，愿望仍然在这里。');
  };
  openDialog('请家长确认', form);
}

document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
$('wishStrip').onclick = () => switchTab('wish');
$('addRecord').onclick = () => showRecordForm();
$('addWish').onclick = $('editWish').onclick = $('changeWishPhoto').onclick = showWishForm;
$('removeWish').onclick = () => message('♡', '移除这个愿望吗？', '只会移除愿望，账目和小金库余额都保留。', [
  { label: '先保留', kind: 'primary', action: closeDialog },
  { label: '移除愿望', action: () => { const next = cloneAccount(); next.wishState = { item: null, updatedAt: nextTimestamp(next.wishState.updatedAt) }; if (commit(next)) closeDialog(); } }
]);
$('expenseAmount').oninput = updateExpensePreview;
$('expenseForm').onsubmit = event => {
  event.preventDefault(); const name = $('expenseName').value.trim(), amount = parseAmount($('expenseAmount').value);
  if (!name || !amount) { toast('请填写买了什么和大于 0 的金额，最多两位小数'); return; }
  addExpense('支出', name, amount, () => { $('expenseForm').reset(); updateExpensePreview(); });
};
$('exportData').onclick = () => { if (exportBackup()) toast('已生成完整账本备份'); };
$('clearData').onclick = confirmClear;
$('resetTasks').onclick = () => message('↻', '刷新任务次数？', '所有周任务次数都会归零。\n已有的收入和账目会保留。', [
  { label: '取消', kind: 'primary', action: closeDialog }, { label: '确认刷新', action: () => {
    const next = cloneAccount(); next.taskState = currentTaskState(next.taskState); next.taskState.taskProgress = Object.fromEntries(TASKS.map(t => [t.name, 0])); next.taskState.updatedAt = nextTimestamp(next.taskState.updatedAt);
    if (commit(next)) { closeDialog(); toast('任务次数已刷新'); }
  } }
]);
$('syncStatus').onclick = () => { if (syncing) toast('正在连接云端，账目已保存在本机'); else { toast(preview ? '预览使用示例数据，不连接真实账本' : '正在尝试同步；未完成同步前请保留浏览器数据'); void syncNow(); } };
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
window.addEventListener('online', () => void syncNow());
window.addEventListener('offline', () => { if (!preview) setStatus('offline', '离线 · 本机已保存'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void syncNow(); } });
window.addEventListener('storage', event => {
  if (preview || blocked || event.key !== STORAGE_KEY || !event.newValue) return;
  try { const other = JSON.parse(event.newValue); const merged = mergeAccounts(account, other); saveAccount(storage, merged); account = merged; revision++; render(); void syncNow(); }
  catch (error) { showStorageError(error); }
});
setInterval(() => { if (!document.hidden) { renderTasks(); void syncNow(); } }, 60000);

try {
  account = loadAccount(storage);
  if (preview && !storage.getItem(STORAGE_KEY)) {
    account.records = [makeRecord('收入', '示例零花钱', 80), makeRecord('支出', '彩色铅笔', 12)];
    account.taskState = currentTaskState(account.taskState); account.taskState.taskProgress['洗脸刷牙'] = 3; account.taskState.taskProgress['洗澡'] = 1;
  }
  saveAccount(storage, account);
} catch (error) { blocked = true; showStorageError(error); setStatus('offline', '已保护原数据'); }
$('previewBanner').hidden = !preview;
render();
void syncNow();
