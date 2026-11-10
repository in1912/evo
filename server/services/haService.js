// Home Assistant 接入（v1.0.11，衍像「HomeAssistant」页；自工作台 v1.14.0 移植）。
//
// 认证：HA 个人资料页创建的**长期访问令牌（LLAT）**，AES-256-GCM 加密存主库 settings
// （GET 只回 has_token 布尔、留空=保持、绝不回显/入 URL/入 git）。
// 加密密钥本库自持（settings.ha_crypt_key，首次使用时随机生成），不依赖工作台的
// businessSkillService。密文格式 gcm1:<iv12+tag16+ct 的 base64>；无前缀的旧明文直接透传
// （下次保存时自动升级为密文）。
// 地址：内网/外网双 URL——REST 逐个试（记住最近成功的那个优先）。401 先记下、继续换地址：
// 401 未必是令牌坏，也可能是地址根本不是 HA。全部地址都不成才定性「令牌被拒」，
// 且报错必须带出是哪个地址拒的——用户才能一眼看出「地址填错了」而不是冤枉令牌。
// 依赖纪律：零新依赖，WS 用 Node 22.4+ 内置全局 WebSocket 手写客户端
// （指数退避、所有监听先判 ws===sock、timer.unref）。
// 未随迁：语音设备表（voiceItemsFrom/listVoiceDevices/statusEntity）与 device_source 分流。

const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const domains = require('./haDomains');

const CFG_KEY = 'ha_config';          // {url, url_external, cache_ttl_min}
const TOKEN_KEY = 'ha_token';         // AES-GCM 密文（或旧明文，保存时升级）
const HOOK_KEY_KEY = 'ha_hook_key';   // webhook 反调 key（32 hex）
const REG_KEY = 'ha_registry_cache';  // 区域/设备/实体注册表缓存（含 at 时间戳，落库跨重启）
const CAT_KEY = 'ha_categories';      // 仪表盘设备分类 [{id,name,icon}]
const DASH_KEY = 'ha_dashboard';      // 仪表盘条目 { 'dev:x'|'ent:y': {visible,cat,sort} }
const CRYPT_KEY_KEY = 'ha_crypt_key'; // 令牌加密密钥（64 hex = 32 字节，首次使用时生成）
const EVT_KEEP = 2000;                // ha_event_log 行数上限（写入时裁最老）
const STATES_TTL = 10 * 1000;         // /api/states 内存缓存（WS 事件实时打补丁）
// 结构性硬上限：WS 补丁只能证明「已知实体的值是新的」，证明不了「实体集合是全的」。
// 超过本间隔必须无视补丁强制全量重拉一次。（HA_STATES_HARD_TTL_MS 可覆盖。）
const STATES_HARD_TTL = Number(process.env.HA_STATES_HARD_TTL_MS) || 60 * 1000;

// ---------- 令牌加密（AES-256-GCM，本库自持密钥） ----------
function cryptKey() {
  let k = getSetting(db, CRYPT_KEY_KEY, '');
  if (!k || !/^[0-9a-f]{64}$/.test(k)) {
    k = crypto.randomBytes(32).toString('hex');
    setSetting(db, CRYPT_KEY_KEY, k);
  }
  return Buffer.from(k, 'hex');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cryptKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'gcm1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(v) {
  const s = String(v || '');
  if (!s.startsWith('gcm1:')) return s; // 旧明文：透传（保存时升级为密文）
  const buf = Buffer.from(s.slice(5), 'base64');
  if (buf.length < 29) throw new Error('密文格式不对');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', cryptKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---------- 配置 ----------
const DEFAULT_CFG = { url: '', url_external: '', cache_ttl_min: 5, pc_switch: '' };
function getConfig() {
  const c = getSetting(db, CFG_KEY, {}) || {};
  return { ...DEFAULT_CFG, ...(c && typeof c === 'object' ? c : {}) };
}
function normalizeUrl(s) {
  const t = String(s == null ? '' : s).trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/i.test(t) ? t : '';
}
function saveConfig(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const cur = getConfig();
  const url = p.url !== undefined ? normalizeUrl(p.url) : cur.url;
  const urlExternal = p.url_external !== undefined ? normalizeUrl(p.url_external) : cur.url_external;
  const ttl = Number(p.cache_ttl_min);
  const pcSwitch = p.pc_switch !== undefined ? String(p.pc_switch || '').trim() : cur.pc_switch;
  const next = {
    url,
    url_external: urlExternal,
    cache_ttl_min: Number.isFinite(ttl) && ttl >= 1 && ttl <= 1440 ? Math.round(ttl) : cur.cache_ttl_min,
    pc_switch: pcSwitch,
  };
  setSetting(db, CFG_KEY, next);
  if (url !== cur.url || urlExternal !== cur.url_external) {
    // 换了 HA 实例：注册表缓存是旧家的区域结构，不能带过去
    try { db.prepare('DELETE FROM settings WHERE key=?').run(REG_KEY); } catch {}
  }
  wsSync();
  return next;
}

// ---------- 令牌（AES-GCM；不回显） ----------
function getToken() {
  const v = getSetting(db, TOKEN_KEY, '');
  if (!v) return '';
  try { return decrypt(v); } catch { return ''; }
}
function setToken(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return;
  setSetting(db, TOKEN_KEY, encrypt(t));
  wsSync();
}
function clearToken() {
  try { db.prepare('DELETE FROM settings WHERE key=?').run(TOKEN_KEY); } catch {}
  wsSync();
}
function hasToken() { return !!getToken(); }

// ---------- 事件流水（ha_event_log） + 订阅分发 ----------
const subscribers = new Set(); // (payload) => void；SSE 路由用它拿实时推送
function onEvent(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
function notify(payload) {
  for (const cb of subscribers) { try { cb(payload); } catch { /* 一个订阅者出错不拖垮别人 */ } }
}
function appendEvent(source, title, message, payload) {
  const ts = Date.now();
  try {
    db.prepare('INSERT INTO ha_event_log(ts,source,title,message,payload) VALUES(?,?,?,?,?)')
      .run(ts, String(source || 'hook'), String(title || '').slice(0, 200),
        String(message || '').slice(0, 2000), String(payload || '').slice(0, 4000));
    db.prepare('DELETE FROM ha_event_log WHERE id NOT IN (SELECT id FROM ha_event_log ORDER BY id DESC LIMIT ?)')
      .run(EVT_KEEP);
  } catch (e) { console.warn('[ha] 事件落库失败:', e.message); }
  notify({ type: source === 'hook' ? 'hook' : 'log', ts, title: String(title || ''), message: String(message || '') });
}
function listEvents(limit = 50, before = 0) {
  const n = Math.min(500, Math.max(1, Number(limit) || 50));
  const rows = before
    ? db.prepare('SELECT id,ts,source,title,message FROM ha_event_log WHERE id<? ORDER BY id DESC LIMIT ?').all(Number(before) || 0, n)
    : db.prepare('SELECT id,ts,source,title,message FROM ha_event_log ORDER BY id DESC LIMIT ?').all(n);
  return rows;
}

// ---------- webhook 反调 key（HA 自动化 RESTful 动作 → POST /api/ha/hook/<key>，EXEMPT 免登录） ----------
function ensureHookKey() {
  let k = getSetting(db, HOOK_KEY_KEY, '');
  if (!k || !/^[0-9a-f]{32}$/.test(k)) {
    k = crypto.randomBytes(16).toString('hex');
    setSetting(db, HOOK_KEY_KEY, k);
  }
  return k;
}
function rotateHookKey() {
  const k = crypto.randomBytes(16).toString('hex');
  setSetting(db, HOOK_KEY_KEY, k);
  return k;
}
function hookKeyOk(got) {
  const k = getSetting(db, HOOK_KEY_KEY, '');
  const g = String(got || '');
  if (!k || !g || k.length !== g.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(g)); } catch { return false; }
}

// ---------- REST（双地址故障转移） ----------
let lastGoodBase = '';
let haInfo = { version: '', location: '', at: 0 }; // /api/config 或 WS auth_ok 顺手刷新
function orderedBases() {
  const c = getConfig();
  const list = [normalizeUrl(c.url), normalizeUrl(c.url_external)].filter(Boolean);
  if (lastGoodBase && list.includes(lastGoodBase)) {
    return [lastGoodBase, ...list.filter((b) => b !== lastGoodBase)];
  }
  return list;
}
function err(code, message) { return Object.assign(new Error(message), { code }); }

async function rest(path, opts = {}) {
  const { method = 'GET', body, timeoutMs = 8000, raw = false } = opts;
  const token = getToken();
  if (!token) throw err('no_token', '尚未配置 Home Assistant 长期访问令牌');
  const list = orderedBases();
  if (!list.length) throw err('no_url', '尚未配置 Home Assistant 地址');
  const errs = [];
  let authRejected = ''; // 第一个回 401 的地址：可能令牌坏，也可能这个地址根本不是 HA
  for (const b of list) {
    try {
      const r = await fetch(b + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 401) {
        // 401 不急着定性：先换下一个地址。全都不成才按令牌被拒上报，且必须带上地址。
        authRejected = authRejected || b;
        errs.push(`${b}：HTTP 401（令牌被拒）`);
        continue;
      }
      if (!r.ok) { errs.push(`${b}：HTTP ${r.status}`); continue; }
      lastGoodBase = b;
      return raw ? Buffer.from(await r.arrayBuffer()) : await r.json();
    } catch (e) {
      errs.push(`${b}：${e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时' : e.message}`);
    }
  }
  if (authRejected) {
    throw err('ha_auth', `Home Assistant 拒绝了令牌（HTTP 401，地址 ${authRejected}）——若这个地址不是 HA 本身，请先改地址；确是 HA 则到 左下角头像 → 安全 → 长期访问令牌 重新生成`);
  }
  throw err('unreachable', `Home Assistant 连接失败（${errs.join('；')}）`);
}

// 测连接（保存前试 / 免存试探：over 里可带未落库的 url/url_external/token）
async function testConnection(over = {}) {
  const token = over.token != null ? String(over.token || '').trim() : getToken();
  if (!token) return { ok: false, code: 'no_token', error: '尚未填写长期访问令牌' };
  const list = [over.url != null ? normalizeUrl(over.url) : normalizeUrl(getConfig().url),
    over.url_external != null ? normalizeUrl(over.url_external) : normalizeUrl(getConfig().url_external)].filter(Boolean);
  if (!list.length) return { ok: false, code: 'no_url', error: '尚未填写 Home Assistant 地址' };
  const errs = [];
  let authRejected = '';
  for (const b of list) {
    const t0 = Date.now();
    try {
      const r = await fetch(b + '/api/', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
      if (r.status === 401) { authRejected = authRejected || b; errs.push(`${b}：HTTP 401（令牌被拒）`); continue; }
      if (!r.ok) { errs.push(`${b}：HTTP ${r.status}`); continue; }
      const cr = await fetch(b + '/api/config', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
      const cfg = cr.ok ? await cr.json().catch(() => ({})) : {};
      lastGoodBase = b;
      haInfo = { version: String(cfg.version || ''), location: String(cfg.location_name || ''), at: Date.now() };
      return { ok: true, base: b, latency_ms: Date.now() - t0, version: haInfo.version, location_name: haInfo.location };
    } catch (e) {
      errs.push(`${b}：${e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时' : e.message}`);
    }
  }
  if (authRejected) {
    return { ok: false, code: 'ha_auth', base: authRejected, error: `令牌被拒（HTTP 401）：${authRejected}——若这个地址不是 Home Assistant，请改地址；确是 HA 则检查令牌是否复制完整或已在 HA 侧吊销` };
  }
  return { ok: false, code: 'unreachable', error: `连接失败：${errs.join('；')}` };
}

// ---------- states 快照（REST 拉全量 + WS state_changed 实时打补丁） ----------
let statesCache = { at: 0, syncedAt: 0, list: [] }; // at=值新鲜（补丁可保鲜） syncedAt=实体集合上次全量同步
async function getStates(force) {
  if (!force && Date.now() - statesCache.at < STATES_TTL && Date.now() - statesCache.syncedAt < STATES_HARD_TTL) return statesCache.list;
  try {
    const list = await rest('/api/states', { timeoutMs: 12000 });
    statesCache = { at: Date.now(), syncedAt: Date.now(), list };
    return list;
  } catch (e) {
    if (statesCache.list.length) {
      // HA 暂时拉不动：旧快照先顶住（页面不整页报错），at 刷新后 10s 内不重试、
      // syncedAt 不动（硬上限仍过期，10s 后继续尝试全量恢复）
      statesCache.at = Date.now();
      return statesCache.list;
    }
    throw e;
  }
}
async function getEntityState(entityId) {
  return rest(`/api/states/${encodeURIComponent(entityId)}`);
}
function applyStateEvent(data) {
  const st = data && data.new_state;
  if (!st || !st.entity_id) return;
  const i = statesCache.list.findIndex((x) => x.entity_id === st.entity_id);
  if (i >= 0) statesCache.list[i] = st; else statesCache.list.push(st);
  statesCache.at = Date.now(); // 只保鲜「值」；不推 syncedAt——实体集合的全量同步按硬上限走
  const attrs = { ...(st.attributes || {}) };
  delete attrs.entity_picture; // 长 URL 只浪费 SSE 带宽，面板真要看图走 camera_proxy
  notify({ type: 'state', entity_id: st.entity_id, state: st.state, last_changed: st.last_changed, attributes: attrs });
}

// ---------- 注册表（区域/设备/实体，WS 拉取 + 落库缓存 + TTL） ----------
async function getRegistry(force) {
  const ttl = Math.max(1, Number(getConfig().cache_ttl_min) || 5) * 60 * 1000;
  // 降级条目只顶 15 秒：断线瞬间生成的空注册表不该把「未分区」骗满整个 TTL——
  // WS 恢复后很快重拉真注册表（真数据仍吃满 TTL）
  const cacheLive = (c) => c && Array.isArray(c.entities) && Date.now() - (c.at || 0) < (c.degraded ? 15000 : ttl);
  let cached = null;
  try { cached = getSetting(db, REG_KEY, null); } catch {}
  if (!force && cacheLive(cached)) return cached;
  let reg = { areas: [], devices: [], entities: [], at: Date.now(), degraded: true };
  try {
    await ensureConnected(10000);
    const [areas, devices, entities] = await Promise.all([
      wsCommand('config/area_registry/list').then((r) => r.result),
      wsCommand('config/device_registry/list').then((r) => r.result),
      wsCommand('config/entity_registry/list').then((r) => r.result),
    ]);
    reg = { areas: areas || [], devices: devices || [], entities: entities || [], at: Date.now(), degraded: false };
  } catch (e) {
    // WS 拿不到（老版本 HA/网络分区）：旧缓存哪怕过期也先顶住；一张缓存都没有就空表（区域归「未分区」）
    if (cached && Array.isArray(cached.entities)) return { ...cached, degraded_error: e.message };
    reg = { ...reg, degraded_error: e.message }; // 首次就失败：降级原因随缓存落库，排查不用瞎猜
  }
  try { setSetting(db, REG_KEY, reg); } catch {}
  return reg;
}

// ---------- WebSocket 长连接（手写客户端） ----------
// 握手：服务端 auth_required → 发 {type:'auth', access_token} → auth_ok / auth_invalid。
// auth_invalid = 令牌坏：停重连等配置更新（wsSync 会清 wsAuthBad 重新起）。
const wsState = { connected: false, since: 0, last_error: '', url: '' };
let ws = null, wsWanted = false, wsTimer = null, wsPing = null;
let wsBackoff = 3000, wsAttempt = 0, wsNextId = 1, wsSubId = 0, wsAuthBad = false;
const wsPending = new Map();   // id → {resolve, reject, timer}
const wsWaiters = new Set();   // 等「连上」的一次性 promise（注册表拉取用）

function scheduleWsReconnect() {
  if (!wsWanted || wsAuthBad || wsTimer) return;
  const delay = wsBackoff;
  wsBackoff = Math.min(wsBackoff * 2, 60000);
  wsTimer = setTimeout(() => { wsTimer = null; wsConnect(); }, delay);
  wsTimer.unref && wsTimer.unref();
}
function startWsPing() {
  stopWsPing();
  wsPing = setInterval(() => {
    if (!wsState.connected) return;
    wsCommand('ping').catch(() => { /* 死连接会由 onclose 接管重连 */ });
  }, 30000);
  wsPing.unref && wsPing.unref();
}
function stopWsPing() { if (wsPing) { clearInterval(wsPing); wsPing = null; } }
function resolveWaiters() {
  for (const w of wsWaiters) {
    wsWaiters.delete(w);
    if (w.timer) clearTimeout(w.timer);
    w.resolve();
  }
}
function wsConnect() {
  if (wsState.connected || wsTimer) return;
  const bases = orderedBases();
  const token = getToken();
  if (!bases.length || !token) { wsWanted = false; return; }
  // 多地址轮换尝试（每次重连换下一个；连上后 lastGoodBase 会把它排到队首）
  const base = bases[wsAttempt++ % bases.length];
  const url = base.replace(/^http/i, 'ws') + '/api/websocket';
  wsState.url = base;
  let sock;
  try { sock = new WebSocket(url); } catch (e) {
    wsState.last_error = e.message;
    scheduleWsReconnect();
    return;
  }
  sock.onmessage = (ev) => {
    if (ws !== sock) return; // 旧 socket 迟到的消息
    let m;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    handleWsMessage(sock, m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    wsState.connected = false;
    stopWsPing();
    for (const [id, p] of wsPending) {
      clearTimeout(p.timer);
      p.reject(err('ws_closed', 'WebSocket 已断开'));
      wsPending.delete(id);
    }
    if (!wsWanted || wsAuthBad) return;
    scheduleWsReconnect();
  };
  sock.onerror = () => { if (ws === sock) wsState.last_error = '连接出错'; };
  ws = sock;
}
function handleWsMessage(sock, m) {
  if (m.type === 'auth_required') {
    sock.send(JSON.stringify({ type: 'auth', access_token: getToken() }));
    return;
  }
  if (m.type === 'auth_ok') {
    wsState.connected = true;
    wsState.since = Date.now();
    wsState.last_error = '';
    wsBackoff = 3000; // 连上即复位退避
    if (m.ha_version) haInfo = { version: String(m.ha_version), location: haInfo.location, at: Date.now() };
    startWsPing();
    wsCommand('subscribe_events', { event_type: 'state_changed' })
      .then((r) => { wsSubId = r.id; })
      .catch(() => { /* 订阅失败只损失实时性，轮询兜底 */ });
    resolveWaiters();
    return;
  }
  if (m.type === 'auth_invalid') {
    wsState.last_error = '令牌无效（WebSocket auth_invalid）';
    wsAuthBad = true; // 停止重连：换地址也没用，等改令牌触发 wsSync
    try { sock.close(); } catch {}
    return;
  }
  if (m.type === 'result') {
    const p = wsPending.get(m.id);
    if (!p) return;
    wsPending.delete(m.id);
    clearTimeout(p.timer);
    if (m.success) p.resolve({ id: m.id, result: m.result });
    else p.reject(err('ws_cmd', String((m.error && m.error.message) || `命令 #${m.id} 失败`)));
    return;
  }
  if (m.type === 'event' && m.id === wsSubId && m.event && m.event.event_type === 'state_changed') {
    applyStateEvent(m.event.data);
  }
}
function wsCommand(type, data = {}, timeoutMs = 10000) {
  if (!wsState.connected || !ws) return Promise.reject(err('ws_closed', 'WebSocket 未连接'));
  const id = wsNextId++;
  return new Promise((resolve, reject) => {
    const p = { resolve, reject, timer: null };
    p.timer = setTimeout(() => {
      wsPending.delete(id);
      reject(err('ws_timeout', `WebSocket 命令超时（${type}）`));
    }, timeoutMs);
    p.timer.unref && p.timer.unref();
    wsPending.set(id, p);
    try { ws.send(JSON.stringify({ id, type, ...data })); }
    catch (e) { wsPending.delete(id); clearTimeout(p.timer); reject(e); }
  });
}
function ensureConnected(timeoutMs = 10000) {
  if (wsState.connected) return Promise.resolve();
  if (wsAuthBad) return Promise.reject(err('ha_auth', `Home Assistant 令牌无效——${wsState.last_error}`));
  if (!orderedBases().length || !getToken()) return Promise.reject(err('no_config', '尚未配置 Home Assistant 连接'));
  wsWanted = true;
  wsConnect();
  return new Promise((resolve, reject) => {
    const w = { resolve, timer: null };
    w.timer = setTimeout(() => {
      if (wsWaiters.delete(w)) reject(err('ws_timeout', 'WebSocket 连接超时'));
    }, timeoutMs);
    w.timer.unref && w.timer.unref();
    wsWaiters.add(w);
  });
}
// 配置变化后重建连接（令牌/地址换了，旧连接的握手凭证已失效）
function wsSync() {
  statesCache = { at: 0, syncedAt: 0, list: [] };
  wsAuthBad = false;
  const ready = orderedBases().length && getToken();
  if (!ready) {
    wsWanted = false;
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
    if (ws) { try { ws.close(); } catch {} }
    wsState.connected = false;
    return;
  }
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  if (ws) { try { ws.close(); } catch {} }
  wsState.connected = false;
  wsWanted = true;
  setImmediate(wsConnect); // 别在 saveConfig 的调用栈里同步建连
}
// 启动即连（配好的实例保持长连：state_changed 实时进缓存/SSE）
setImmediate(() => {
  if (getToken() && orderedBases().length) {
    wsWanted = true;
    wsConnect();
  }
});

// ---------- 仪表盘：设备分类 + 条目可见性/排序 ----------
// 语义：整表替换（前端每次发全量）；分类删除后，仪表盘里指向它的 cat 一并清空（条目保留、回到「全部」）。
// 非法输入抛 haBad 错误 → 路由回 400（区别于 HA 调用失败的 503）。
function badReq(msg) { const e = new Error(msg); e.haBad = true; return e; }
function getCategories() {
  const v = getSetting(db, CAT_KEY, []);
  return Array.isArray(v)
    ? v.filter((c) => c && typeof c === 'object' && domains.isCategoryIcon(c.icon)
      && typeof c.id === 'string' && typeof c.name === 'string')
    : [];
}
function saveCategories(list) {
  if (!Array.isArray(list)) throw badReq('categories 必须是数组');
  if (list.length > 30) throw badReq('分类最多 30 个');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const name = String(c.name == null ? '' : c.name).trim();
    if (!name || name.length > 16) throw badReq('分类名称需为 1~16 个字');
    if (!domains.isCategoryIcon(c.icon)) throw badReq(`分类「${name}」的图标不在可选清单里`);
    let id = String(c.id || '');
    if (!/^c[0-9a-f]{6,16}$/.test(id)) id = 'c' + crypto.randomBytes(5).toString('hex'); // 新增分类现场发 id
    if (seen.has(id)) throw badReq('分类 id 重复');
    seen.add(id);
    out.push({ id, name, icon: String(c.icon) });
  }
  setSetting(db, CAT_KEY, out);
  // 清扫孤儿：分类没了，条目里的 cat 引用跟着清空（visible/sort 不动）
  const dash = getDashboard();
  let touched = false;
  for (const k of Object.keys(dash)) {
    if (dash[k].cat && !seen.has(dash[k].cat)) { dash[k].cat = ''; touched = true; }
  }
  if (touched) setSetting(db, DASH_KEY, dash);
  return out;
}
function getDashboard() {
  const v = getSetting(db, DASH_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function saveDashboard(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw badReq('dashboard 必须是对象');
  const keys = Object.keys(obj);
  if (keys.length > 500) throw badReq('仪表盘条目最多 500 个');
  const catIds = new Set(getCategories().map((c) => c.id));
  const out = {};
  for (const k of keys) {
    if (!domains.isDashKey(k)) throw badReq(`条目键 ${String(k).slice(0, 40)} 格式不对（应为 dev:<设备id> 或 ent:<实体id>）`);
    const v = obj[k] && typeof obj[k] === 'object' ? obj[k] : {};
    const sort = Number(v.sort);
    out[k] = {
      visible: v.visible === true,
      cat: catIds.has(v.cat) ? String(v.cat) : '',
      sort: Number.isFinite(sort) && sort >= 0 && sort <= 99999 ? Math.round(sort) : 0,
    };
  }
  setSetting(db, DASH_KEY, out);
  return out;
}

// ---------- 面板数据 ----------
async function listEntities(fresh) {
  const [states, reg] = await Promise.all([getStates(fresh), getRegistry(fresh)]);
  const areas = new Map((reg.areas || []).map((a) => [a.area_id, a.name || a.area_id]));
  const devices = new Map((reg.devices || []).map((d) => [d.id, d]));
  const ents = new Map((reg.entities || []).map((e) => [e.entity_id, e]));
  const entities = (states || []).map((st) => {
    const entityId = String(st && st.entity_id || '');
    const domain = entityId.split('.')[0];
    const attrs = (st && st.attributes) || {};
    const ent = ents.get(entityId) || {};
    const dev = ent.device_id ? devices.get(ent.device_id) : null;
    const areaId = ent.area_id || (dev && dev.area_id) || '';
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      entity_id: entityId,
      name: String(attrs.friendly_name || entityId),
      domain,
      label: domains.labelOf(domain),
      state: st.state,
      state_text: domains.stateText(domain, st.state, attrs),
      unit: attrs.unit_of_measurement ? String(attrs.unit_of_measurement) : '',
      area: areaId ? (areas.get(areaId) || areaId) : '未分区',
      area_id: areaId,
      device_id: ent.device_id || '',
      device_name: dev ? String(dev.name_by_user || dev.name || '') : '',
      controllable: domains.isControllable(domain),
      on: domains.isOn(domain, st.state, attrs),
      online: st.state !== 'unavailable' && st.state !== 'unknown',
      t: num(attrs.current_temperature),
      h: num(attrs.current_humidity),
      hidden: !!(ent.hidden_by || ent.disabled_by),
      last_changed: st.last_changed || '',
      attributes: attrs,
    };
  });
  const counts = new Map();
  for (const e of entities) if (!e.hidden) counts.set(e.area, (counts.get(e.area) || 0) + 1);
  const areaList = [...new Map(entities.filter((e) => e.area_id && !e.hidden)
    .map((e) => [e.area_id, { area_id: e.area_id, name: e.area, count: 0 }])).values()]
    .map((a) => ({ ...a, count: counts.get(a.name) || 0 }));
  // 设备清单（设备页「同一设备的实体框在一起」+ 仪表盘 dev:<id> 卡）：注册表里有、且本次 states
  // 里出现了它的实体的设备才列——纯注册表设备（无在线实体）在面板上无从展示
  const devBox = new Map();
  for (const e of entities) {
    if (!e.device_id || devBox.has(e.device_id)) continue;
    const d = devices.get(e.device_id) || {};
    devBox.set(e.device_id, {
      id: e.device_id,
      name: String(d.name_by_user || d.name || e.device_id),
      manufacturer: String(d.manufacturer || ''),
      model: String(d.model || ''),
      area: e.area, area_id: e.area_id,
      count: entities.filter((x) => x.device_id === e.device_id).length,
    });
  }
  return {
    entities, areas: areaList, at: Date.now(), degraded: !!reg.degraded,
    ...(reg.degraded_error ? { degraded_error: reg.degraded_error } : {}),
    devices: [...devBox.values()], cats: getCategories(), dash: getDashboard(), ws: publicWs(),
  };
}
function publicWs() { return { ...wsState }; }

// ---------- 控制 ----------
async function callService(domain, service, data) {
  return rest(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
    { method: 'POST', body: data || {}, timeoutMs: 10000 });
}
// d：{did, domain, name, room}。控制后回读验证（慢设备 500ms 后仍是旧态 → 如实说「回读仍显示」不谎报成功）。
async function controlEntity(d, wantOn) {
  const svc = domains.serviceFor(d.domain, wantOn ? 'on' : 'off');
  if (!svc) return { ok: false, message: `${d.name}（${domains.labelOf(d.domain)}）不支持开关控制` };
  await callService(d.domain, svc, { entity_id: d.did }); // 不带 entity_id 的服务调用在真 HA 上是空操作
  appendEvent('control', `${wantOn ? '开' : '关'} ${d.name}`, `${d.did} → ${d.domain}.${svc}`, '');
  let after = null;
  await new Promise((r) => setTimeout(r, 500));
  try { after = await getEntityState(d.did); } catch { /* 回读失败不遮掩指令已发的事实 */ }
  const where = d.room && d.room !== '未分区' ? d.room : '';
  if (!after) return { ok: true, verified: false, state: null, message: `好的，已发送${wantOn ? '打开' : '关闭'}${where}${d.name}的指令（未回读到状态）` };
  const on = domains.isOn(d.domain, after.state, after.attributes);
  if (on !== wantOn) {
    return { ok: true, verified: false, state: after.state, message: `指令已发送，但${where}${d.name}回读仍显示「${domains.stateText(d.domain, after.state, after.attributes)}」（部分设备响应需要几秒）` };
  }
  return { ok: true, verified: true, state: after.state, message: `好的，已${wantOn ? '打开' : '关闭'}${where}${d.name}` };
}

// ---------- 摄像头 / 历史 / 服务目录 ----------
async function cameraImage(entityId) {
  return rest(`/api/camera_proxy/${encodeURIComponent(entityId)}`, { raw: true, timeoutMs: 15000 });
}
async function history(entityId, hours = 24) {
  const h = Math.min(168, Math.max(1, Number(hours) || 24));
  const start = new Date(Date.now() - h * 3600 * 1000).toISOString();
  const rows = await rest(`/api/history/period/${start}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response&no_attributes`,
    { timeoutMs: 15000 });
  return Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
}
async function listServices() { return rest('/api/services', { timeoutMs: 12000 }); }

// ---------- 对外总配置（token 只回布尔） ----------
function getPublicConfig() {
  const cfg = getConfig();
  return {
    config: cfg,
    has_token: hasToken(),
    ws: publicWs(),
    version: haInfo.version || '',
    location_name: haInfo.location || '',
  };
}

module.exports = {
  getConfig, saveConfig, getPublicConfig,
  getToken, setToken, clearToken, hasToken,
  testConnection, rest,
  listEntities, getEntityState,
  callService, controlEntity,
  cameraImage, history, listServices,
  ensureHookKey, rotateHookKey, hookKeyOk,
  appendEvent, listEvents, onEvent,
  getCategories, saveCategories, getDashboard, saveDashboard,
  wsSync, ensureConnected,
};
