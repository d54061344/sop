'use strict';
// Offline-first: every change becomes an op in `outbox`, applied locally at once and synced to Apps Script when online.
// Displayed state = last server snapshot + pending ops replayed on top.

const DAY_START_HOUR = 5; // keep in sync with apps-script/Code.gs
const WD = '日一二三四五六';  // index = Date.getDay()
const WEEK = '一二三四五六日'; // display order
const GROUPS = [
  ['交易 · 絕對禁止（違反即停止當日交易，隔個交易日部位減半）', r => r.category === '交易' && r.level === '禁止', 'ban'],
  ['交易 · 應遵守', r => r.category === '交易' && r.level !== '禁止', 'warn'],
  ['生活', r => r.category !== '交易', 'life'],
];

// ===== Storage =====
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const EMPTY = { rules: [], triggers: [], logs: [], checkins: [], checkinDates: [], lastBanDate: '', firstDate: '' };
let cfg = store.get('cfg', null);       // { url, key }
let server = store.get('server', EMPTY);
let outbox = store.get('outbox', []);
let lastSync = store.get('lastSync', '');
let syncing = false, syncError = '';
let S; // derived state

// ===== Helpers =====
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date(Date.now() - DAY_START_HOUR * 3600e3));
const stamp = () => { const d = new Date(); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
const diffDays = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
const appliesOn = (r, d) => !r.days || r.days.includes(WD[weekday(d)]);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const groupCls = r => GROUPS.find(g => g[1](r))[2];
const daysLabel = d => (d ? '週' + d : '每天');
const openSheet = id => $(id).classList.add('open');
const closeSheet = id => $(id).classList.remove('open');

// ===== State & sync =====
function applyOp(s, op) {
  if (op.op === 'log') { if (!s.logs.some(l => l.id === op.log.id)) s.logs.push(op.log); }
  else if (op.op === 'undo') s.logs = s.logs.filter(l => l.id !== op.id);
  else if (op.op === 'checkin') { // empty items = cancel that day's check-in
    s.checkins = s.checkins.filter(c => c.date !== op.date).concat(op.items.map(x => ({ ...x, date: op.date })));
    s.checkinDates = s.checkinDates.filter(d => d !== op.date).concat(op.items.length ? [op.date] : []);
  } else if (op.op === 'rule') {
    const i = s.rules.findIndex(r => r.id === op.rule.id);
    if (i < 0) s.rules.push(op.rule); else s.rules[i] = op.rule;
  } else if (op.op === 'triggers') s.triggers = op.list;
}

function rebuild() {
  S = JSON.parse(JSON.stringify(server));
  outbox.forEach(op => applyOp(S, op));
  render();
}

function commit(op) {
  outbox.push(op);
  store.set('outbox', outbox);
  rebuild();
  sync();
}

async function sync() {
  if (!cfg || syncing) return;
  syncing = true;
  renderSyncStatus();
  const ops = outbox.slice();
  try {
    const res = await fetch(cfg.url, { method: 'POST', body: JSON.stringify({ key: cfg.key, ops }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error === 'unauthorized' ? '連線碼錯誤' : j.error || '同步失敗');
    server = j.data;
    outbox = outbox.slice(ops.length); // ops added during the request stay queued
    lastSync = stamp();
    syncError = '';
    store.set('server', server); store.set('outbox', outbox); store.set('lastSync', lastSync);
    rebuild();
  } catch (e) {
    syncError = navigator.onLine ? e.message : '離線中';
  }
  syncing = false;
  renderSyncStatus();
  if (!syncError && outbox.length) sync();
}

// ===== Derived numbers =====
function checkinStreak(t) {
  const done = new Set(S.checkinDates);
  let d = done.has(t) ? t : addDays(t, -1), n = 0;
  while (done.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

function lastBanDate() {
  return [S.lastBanDate, ...S.logs.filter(l => l.level === '禁止').map(l => l.date)].filter(Boolean).sort().pop() || '';
}

function nextTradingDay(d) {
  const trade = S.rules.filter(r => r.active && r.category === '交易');
  for (let i = 1; i <= 7; i++) {
    const nd = addDays(d, i);
    if (!trade.length || trade.some(r => appliesOn(r, nd))) return nd;
  }
  return addDays(d, 1);
}

// ===== Render: home =====
function render() {
  const t = today(), weekStart = addDays(t, -((weekday(t) + 6) % 7)); // weeks start Monday
  const active = S.rules.filter(r => r.active);
  const todayLogs = S.logs.filter(l => l.date === t);
  const week = S.logs.filter(l => l.date >= weekStart);
  $('today').textContent = `${t}（${WD[weekday(t)]}）`;

  const banned = todayLogs.filter(l => l.level === '禁止');
  const lastBan = lastBanDate();
  let banner = '';
  if (banned.length) banner += `<div class="banner stop">⛔ 今日已違反絕對禁止規則，停止交易<br><small>${esc(banned.map(l => l.ruleText).join('、'))}</small></div>`;
  else if (lastBan && lastBan < t && nextTradingDay(lastBan) === t) banner += `<div class="banner half">⚠️ 今日部位減半（${lastBan.slice(5)} 違反絕對禁止規則）</div>`;
  $('banner').innerHTML = banner;

  const streak = checkinStreak(t);
  const zeroBan = lastBan ? diffDays(t, lastBan) : diffDays(t, S.firstDate || t);
  const ck7 = S.checkins.filter(c => c.date > addDays(t, -7));
  const rate = ck7.length ? Math.round(100 * ck7.filter(c => c.ok).length / ck7.length) + '%' : '—';
  const fine = S.logs.filter(l => l.date.startsWith(t.slice(0, 7))).reduce((s, l) => s + (Number(l.penalty) || 0), 0);
  $('stats').innerHTML = [
    ['連續結算', `${streak} 天`], ['禁止零違規', `${zeroBan} 天`], ['7 日遵守率', rate],
    ['今日違規', todayLogs.length], ['本週違規', week.length], ['本月罰金', `$${fine}`],
  ].map(([k, v]) => `<div class="stat"><span class="muted">${k}</span><b>${v}</b></div>`).join('');

  $('rules').innerHTML = GROUPS.map(([title, fn, cls]) => {
    const rs = active.filter(fn);
    if (!rs.length) return '';
    return `<h2>${title}</h2>` + rs.map(r => {
      const n = week.filter(l => l.ruleId === r.id).length;
      return `<button class="rule ${cls}" onclick="openLog('${r.id}', '即時')">`
        + `<span class="txt">${esc(r.text)}</span>${n ? `<span class="badge">${n}</span>` : ''}</button>`;
    }).join('');
  }).join('') || '<p class="muted">還沒有規則，到 ⚙️ 設定新增。</p>';

  renderCalendar(t, weekStart);
  renderRecent();
  $('fab').textContent = S.checkinDates.includes(t) ? '✓ 今日已結算（點此修改）' : '每日結算';
  renderSyncStatus();
  updateBadge(streak);
}

// Day colour: red = absolute-ban violation, yellow (darker = more) = other violations,
// green = checked in with none, grey = nothing recorded. Dot: ● same-day check-in, ○ backfilled.
function renderCalendar(t, weekStart) {
  const start = addDays(weekStart, -28);
  const done = new Set(S.checkinDates);
  let html = [...WEEK].map(w => `<div class="wd">${w}</div>`).join('');
  for (let i = 0; i < 35; i++) {
    const d = addDays(start, i);
    if (d > t) { html += '<div></div>'; continue; }
    const logs = S.logs.filter(l => l.date === d);
    const cls = logs.some(l => l.level === '禁止') ? 'banday'
      : logs.length ? 'v' + Math.min(logs.length, 3)
      : done.has(d) ? 'clean' : '';
    const dot = !done.has(d) ? '' : S.checkins.some(c => c.date === d && c.late) ? 'late' : 'ck';
    html += `<button class="d ${cls} ${dot}${d === t ? ' today' : ''}" onclick="openCheckin('${d}')">${Number(d.slice(8))}</button>`;
  }
  $('calendar').innerHTML = `<div class="cal">${html}</div><div class="legend">`
    + '<span><i class="sw" style="background:var(--ok-bg);border:1px solid var(--ok)"></i>無違規</span>'
    + '<span><i class="sw" style="background:var(--warn)"></i>有違規（越深越多）</span>'
    + '<span><i class="sw" style="background:var(--ban)"></i>絕對禁止</span>'
    + '<span>● 當天結算　○ 補結算</span></div>';
}

function renderRecent() {
  const pending = new Set(outbox.filter(o => o.op === 'log').map(o => o.log.id));
  const recent = S.logs.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 8);
  $('recent').innerHTML = recent.length ? recent.map(l =>
    `<button class="log" onclick="deleteLog('${l.id}')"><span>${esc(l.ruleText)}<br><span class="muted">${esc(l.trigger)}${l.note ? '・' + esc(l.note) : ''}</span></span>`
    + `<span class="muted">${pending.has(l.id) ? '⏳ ' : ''}${esc(String(l.timestamp).slice(5, 16))}`
    + `${l.source === '結算' ? '<br>結算補記' : l.source === '補結算' ? `<br>補 ${esc(l.date.slice(5))}` : ''}</span></button>`
  ).join('') : '<span class="muted">尚無紀錄</span>';
}

function renderSyncStatus() {
  $('syncBanner').innerHTML = !cfg ? '<div class="banner stop" onclick="openSetup()">尚未設定連線碼，點此設定</div>'
    : syncError && syncError !== '離線中' ? `<div class="banner stop" onclick="openSetup()">⚠️ 同步失敗：${esc(syncError)}<br><small>點此重設連線碼</small></div>`
    : '';
  $('dot').className = 'dot' + (syncError && syncError !== '離線中' ? ' error' : outbox.length || syncing ? ' pending' : '');
  $('syncInfo').innerHTML = [
    syncing ? '同步中…' : syncError ? `⚠️ ${esc(syncError)}` : '✓ 已同步',
    `待同步：${outbox.length} 筆`,
    `上次同步：${lastSync || '—'}`,
  ].join('<br>');
}

// ===== Log a violation: tap rule → tap trigger (auto-submits) =====
let logCtx = null;
function openLog(ruleId, source, onDone, date) {
  const triggers = S.triggers.length ? S.triggers : ['未分類']; // never leave the sheet without a submit button
  logCtx = { rule: S.rules.find(r => r.id === ruleId), source, onDone, triggers, date: date || today() };
  $('logRule').textContent = logCtx.rule.text;
  $('logDetail').textContent = logCtx.rule.detail || '';
  $('note').value = '';
  $('chips').innerHTML = triggers.map((t, j) => `<button class="chip" onclick="pick(${j})">${esc(t)}</button>`).join('');
  openSheet('logSheet');
}

function pick(j) {
  const { rule, source, onDone, triggers, date } = logCtx;
  const log = {
    id: uid(), timestamp: stamp(), date, ruleId: rule.id, ruleText: rule.text, level: rule.level,
    trigger: triggers[j], note: $('note').value.trim(), source, penalty: rule.penalty || 0,
  };
  closeSheet('logSheet');
  commit({ op: 'log', log });
  if (onDone) onDone();
  toast(`已記錄：${log.trigger}${log.penalty ? `（罰 $${log.penalty}）` : ''}`, '撤銷', () => commit({ op: 'undo', id: log.id }));
}

function deleteLog(id) {
  const l = S.logs.find(x => x.id === id);
  if (l && confirm(`刪除這筆紀錄？\n${l.ruleText}・${l.trigger}`)) commit({ op: 'undo', id });
}

let toastTimer;
function toast(msg, btn, fn) {
  $('toastMsg').textContent = msg;
  const b = $('toastBtn');
  b.textContent = btn || '';
  b.style.display = btn ? '' : 'none';
  b.onclick = () => { $('toast').classList.remove('show'); fn(); };
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5000);
}

// ===== Daily check-in (today, or backfill a past day from the calendar) =====
let ckState = {}, ckDate = '';
function openCheckin(date) {
  ckDate = date || today();
  const prev = S.checkins.filter(c => c.date === ckDate);
  ckState = {};
  S.rules.filter(r => r.active && appliesOn(r, ckDate)).forEach(r => {
    const p = prev.find(c => c.ruleId === r.id);
    ckState[r.id] = p ? p.ok : !S.logs.some(l => l.ruleId === r.id && l.date === ckDate);
  });
  const label = `${ckDate.slice(5).replace('-', '/')}（${WD[weekday(ckDate)]}）`;
  $('ckTitle').textContent = ckDate === today() ? `每日結算 ${label}` : `補結算 ${label}`;
  $('ckCancel').style.display = S.checkinDates.includes(ckDate) ? '' : 'none';
  renderCk();
  openSheet('ckSheet');
}

function renderCk() {
  $('ckList').innerHTML = S.rules.filter(r => r.id in ckState).map(r => {
    const ok = ckState[r.id];
    return `<div class="ck"><span class="txt">${esc(r.text)}</span>`
      + `<button class="tg y ${ok ? 'on' : ''}" onclick="setCk('${r.id}', true)">✓</button>`
      + `<button class="tg n ${ok ? '' : 'on'}" onclick="setCk('${r.id}', false)">✗</button></div>`;
  }).join('') || '<p class="muted">今天沒有適用的規則。</p>';
}

function setCk(id, ok) {
  // A miss not logged during the day → ask for its trigger too (logged as 結算補記).
  if (!ok && !S.logs.some(l => l.ruleId === id && l.date === ckDate)) {
    return openLog(id, ckDate === today() ? '結算' : '補結算', () => { ckState[id] = false; renderCk(); }, ckDate);
  }
  ckState[id] = ok;
  renderCk();
}

function saveCheckin() {
  const late = ckDate !== today();
  const items = S.rules.filter(r => r.id in ckState).map(r => ({ ruleId: r.id, ruleText: r.text, ok: ckState[r.id], late }));
  if (!items.length) return toast('這天沒有適用的規則');
  closeSheet('ckSheet');
  commit({ op: 'checkin', date: ckDate, items });
  toast(late ? '補結算完成' : '結算完成');
}

// Removes only the ✓/✗ rows; violations logged during check-in are kept (delete them from 最近紀錄 if needed).
function cancelCheckin() {
  if (!confirm(`取消 ${ckDate} 的結算？\n（當時記下的違規會保留）`)) return;
  closeSheet('ckSheet');
  commit({ op: 'checkin', date: ckDate, items: [] });
  toast('已取消結算');
}

// ===== Settings =====
let trigDraft = [];
function openSettings() {
  renderRuleList();
  trigDraft = S.triggers.slice();
  renderTrigList();
  renderBadgeBtn();
  renderSyncStatus();
  openSheet('settings');
}

function renderRuleList() {
  $('ruleList').innerHTML = GROUPS.map(([title, fn, cls]) => {
    const rs = S.rules.filter(fn);
    if (!rs.length) return '';
    return `<div class="muted" style="margin:10px 4px 6px">${title.split('（')[0]}</div>` + rs.map(r =>
      `<button class="rule ${cls}${r.active ? '' : ' off'}" onclick="editRule('${r.id}')"><span class="txt">${esc(r.text)}`
      + `<span class="meta">${daysLabel(r.days)}${r.penalty ? `・罰 $${r.penalty}` : ''}${r.active ? '' : '・已停用'}</span></span>›</button>`
    ).join('');
  }).join('');
}

function renderTrigList() {
  $('trigList').innerHTML = trigDraft.map((t, i) =>
    `<div class="trig"><input class="field" value="${esc(t)}" oninput="trigDraft[${i}] = this.value"><button onclick="trigDraft.splice(${i}, 1); renderTrigList()">✕</button></div>`
  ).join('') || '<span class="muted">沒有觸發原因</span>';
}

function addTrigger() { trigDraft.push(''); renderTrigList(); }

function saveTriggers() {
  const list = [...new Set(trigDraft.map(t => t.trim()).filter(Boolean))];
  if (!list.length) return toast('至少要有一個觸發原因');
  commit({ op: 'triggers', list });
  toast('觸發原因已儲存');
}

// ----- Rule editor -----
let editing = null;
function editRule(id) {
  const r = id ? S.rules.find(x => x.id === id)
    : { id: 'R' + uid(), category: '交易', level: '遵守', text: '', detail: '', days: '', penalty: 0, active: true };
  editing = { ...r };
  $('ruleSheetTitle').textContent = id ? '編輯規則' : '新增規則';
  renderRuleForm();
  openSheet('ruleSheet');
}

function readRuleForm() {
  if (!$('rfText')) return;
  editing.text = $('rfText').value;
  editing.detail = $('rfDetail').value;
  editing.penalty = Math.max(0, Number($('rfPenalty').value) || 0);
}

function setRf(field, value) {
  readRuleForm();
  if (field === 'day') {
    const set = new Set(editing.days);
    set.has(value) ? set.delete(value) : set.add(value);
    editing.days = [...WEEK].filter(w => set.has(w)).join('');
  } else editing[field] = value;
  if (editing.category === '生活') editing.level = '一般';
  else if (editing.level === '一般') editing.level = '遵守';
  renderRuleForm();
}

function renderRuleForm() {
  const r = editing;
  const seg = (field, opts, cur) => `<div class="seg">${opts.map(([v, label]) =>
    `<button class="${cur === v ? 'on' : ''}" onclick="setRf('${field}', '${v}')">${label}</button>`).join('')}</div>`;
  $('ruleForm').innerHTML =
    `<span class="lbl">規則內容（要能明確判斷有沒有做到）</span><input class="field" id="rfText" value="${esc(r.text)}">`
    + `<span class="lbl">附註（選填，記錄違規時才顯示）</span><textarea class="field" id="rfDetail" rows="3">${esc(r.detail || '')}</textarea>`
    + `<span class="lbl">類別</span>${seg('category', [['交易', '交易'], ['生活', '生活']], r.category)}`
    + (r.category === '交易' ? `<span class="lbl">等級</span>${seg('level', [['禁止', '🔴 絕對禁止'], ['遵守', '🟡 應遵守']], r.level)}` : '')
    + `<span class="lbl">結算時列出的日子（都不選＝每天）</span><div class="seg">${[...WEEK].map(w =>
      `<button class="${r.days.includes(w) ? 'on' : ''}" onclick="setRf('day', '${w}')">${w}</button>`).join('')}</div>`
    + `<span class="lbl">每次違規罰金（NT$，0＝不罰）</span><input class="field" id="rfPenalty" type="number" inputmode="numeric" min="0" value="${r.penalty || 0}">`
    + `<span class="lbl">狀態</span>${seg('active', [['true', '啟用'], ['false', '停用']], String(r.active))}`;
}

function saveRule() {
  readRuleForm();
  const rule = { ...editing, text: editing.text.trim(), detail: (editing.detail || '').trim(), active: editing.active === true || editing.active === 'true' };
  if (!rule.text) return toast('請輸入規則內容');
  if (rule.days.length === 7) rule.days = '';
  closeSheet('ruleSheet');
  commit({ op: 'rule', rule });
  renderRuleList();
  toast('規則已儲存');
}

// ----- App icon badge = check-in streak (iOS 16.4+, home-screen app, notification permission) -----
function updateBadge(n) {
  if (!('setAppBadge' in navigator)) return;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

function renderBadgeBtn() {
  const b = $('badgeBtn');
  if (!('Notification' in window) || !('setAppBadge' in navigator)) {
    b.textContent = '此環境不支援（需從主畫面圖示開啟）'; b.disabled = true;
  } else if (Notification.permission === 'granted') {
    b.textContent = '✓ 已啟用'; b.disabled = true;
  } else {
    b.textContent = '啟用圖示數字（會詢問通知權限）'; b.disabled = false;
  }
}

async function enableBadge() {
  await Notification.requestPermission();
  renderBadgeBtn();
  render();
}

// ----- Connection -----
function openSetup() {
  $('setupCode').value = '';
  $('setupCancel').style.display = cfg ? '' : 'none';
  openSheet('setup');
}

function saveSetup() {
  const [url, key] = $('setupCode').value.trim().split('|').map(s => s.trim());
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url || '') || !key) return toast('連線碼格式不對');
  cfg = { url, key };
  store.set('cfg', cfg);
  closeSheet('setup');
  syncError = '';
  sync();
}

// ===== Boot =====
document.addEventListener('gesturestart', e => e.preventDefault()); // iOS ignores user-scalable=no; block pinch zoom
rebuild();
if (!cfg) openSetup(); else sync();
window.addEventListener('online', sync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { rebuild(); sync(); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
