// Home Assistant 路由（v1.0.11，衍像「HomeAssistant」页；自工作台 v1.14.0 移植）。
// 权限：/api/ha/* 归 ha 页（auth.js PAGES/pageForPath）；配置/服务调试/轮换 webhook key
// 限管理员；实体一览/控制/摄像头/历史/事件流登录+页即可。
// /ha/hook/:key 在 index.js EXEMPT 免登录（HA 自动化反调，key 即凭证）——处理里不许碰 req.user。
const express = require('express');
const svc = require('../services/haService');
const domains = require('../services/haDomains');

const router = express.Router();
const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[ha]', e.message);
  res.status(503).json({ error: e.message || 'Home Assistant 接口调用失败' });
});
function adminOnly(req, res) {
  if (!req.user || req.user.role !== 'admin') { res.status(403).json({ error: '仅管理员可操作' }); return false; }
  return true;
}

// webhook 地址提示（按请求头推导外部可达前缀；纯提示，HA 侧按自己环境改内外网前缀）
function hookUrlFor(req) {
  const key = svc.ensureHookKey();
  const h = req.headers || {};
  const host = h['x-forwarded-host'] || h.host || '';
  const proto = h['x-forwarded-proto'] || (String(h['x-forwarded-ssl'] || '').toLowerCase() === 'on' ? 'https' : '') || req.protocol || 'http';
  const base = host ? `${proto}://${host}` : '';
  return base ? `${base}/api/ha/hook/${key}` : `/api/ha/hook/${key}`;
}

// ---------- 配置（token 只回布尔，绝不回显；留空=保持） ----------
router.get('/ha/config', (req, res) => {
  const p = svc.getPublicConfig();
  res.json({
    ...p,
    token_set: p.has_token,
    is_admin: !!(req.user && req.user.role === 'admin'),
    hook_url: hookUrlFor(req),
    hook_key: req.user && req.user.role === 'admin' ? svc.ensureHookKey() : '',
  });
});

router.put('/ha/config', asyncH(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = req.body || {};
  // 地址给错格式直接拦（saveConfig 的 normalizeUrl 会把非法串静默清空——这里要的是明确报错）
  const check = (v, label) => {
    if (v === undefined || String(v).trim() === '') return;
    if (!/^https?:\/\/.+/i.test(String(v).trim())) throw new Error(`${label} 必须以 http:// 或 https:// 开头`);
  };
  check(b.url, '内网地址');
  check(b.url_external, '外网地址');
  if (b.pc_switch !== undefined && String(b.pc_switch).trim() !== '' && !/^[\w.-]{1,64}\.[\w.-]{1,64}$/.test(String(b.pc_switch).trim())) {
    throw new Error('电脑开关 entity_id 格式不对（应为 domain.name，如 switch.pc）');
  }
  const saved = svc.saveConfig({
    url: b.url, url_external: b.url_external, cache_ttl_min: b.cache_ttl_min, pc_switch: b.pc_switch,
  });
  if (b.token && String(b.token).trim()) svc.setToken(b.token);
  if (b.token_clear) svc.clearToken();
  if (b.rotate_hook) svc.rotateHookKey();
  res.json({ config: saved, has_token: svc.hasToken(), hook_url: hookUrlFor(req) });
}));

// 测连接：body 可带未保存的 url/url_external/token（保存前先试），不给就用已存配置
router.post('/ha/test', asyncH(async (req, res) => {
  const b = req.body || {};
  const over = {};
  if (b.url !== undefined) over.url = b.url;
  if (b.url_external !== undefined) over.url_external = b.url_external;
  if (b.token !== undefined) over.token = b.token;
  res.json(await svc.testConnection(over));
}));

// ---------- 仪表盘配置（管理员，整表替换；非法输入 400 区别于 HA 调用失败的 503） ----------
router.put('/ha/categories', (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    res.json({ ok: true, categories: svc.saveCategories((req.body || {}).categories) });
  } catch (e) {
    if (e && e.haBad) return res.status(400).json({ error: e.message });
    console.error('[ha]', e.message);
    res.status(503).json({ error: e.message || '保存分类失败' });
  }
});
router.put('/ha/dashboard', (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    res.json({ ok: true, dashboard: svc.saveDashboard((req.body || {}).dashboard) });
  } catch (e) {
    if (e && e.haBad) return res.status(400).json({ error: e.message });
    console.error('[ha]', e.message);
    res.status(503).json({ error: e.message || '保存仪表盘失败' });
  }
});

// ---------- 实体一览 / 详情 / 历史 ----------
router.get('/ha/entities', asyncH(async (req, res) => {
  res.json(await svc.listEntities(req.query.fresh === '1'));
}));

router.get('/ha/entity/:id', asyncH(async (req, res) => {
  res.json(await svc.getEntityState(req.params.id));
}));

router.get('/ha/history/:id', asyncH(async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  res.json({ points: await svc.history(req.params.id, hours) });
}));

// ---------- 快捷开关（面板逐台通断；登录+页即可） ----------
router.post('/ha/control', asyncH(async (req, res) => {
  const entityId = String((req.body || {}).entity_id || '').trim();
  const action = String((req.body || {}).action || '').trim();
  if (!/^[\w.-]{1,64}\.[\w.-]{1,64}$/.test(entityId)) return res.status(400).json({ error: 'entity_id 格式不对（应为 domain.name，如 light.ceiling）' });
  if (!['on', 'off', 'toggle'].includes(action)) return res.status(400).json({ error: 'action 只支持 on / off / toggle' });
  const st = await svc.getEntityState(entityId);
  const domain = entityId.split('.')[0];
  const attrs = st.attributes || {};
  const wantOn = action === 'toggle' ? !domains.isOn(domain, st.state, attrs) : action === 'on';
  const r = await svc.controlEntity({ did: entityId, domain, name: String(attrs.friendly_name || entityId), room: '' }, wantOn);
  res.json(r);
}));

// ---------- 摄像头当前帧（二进制代理；<img> 走 ?token= 鉴权） ----------
router.get('/ha/camera/:id', asyncH(async (req, res) => {
  const buf = await svc.cameraImage(req.params.id);
  res.set('Cache-Control', 'no-store');
  res.type('image/jpeg'); // camera_proxy 恒出 JPEG（fetch 已跟随 302 到签名流）
  res.send(buf);
}));

// ---------- 服务目录 / 服务调用（调试器；限管理员——任意服务等于 HA 全量权限） ----------
router.get('/ha/services', asyncH(async (req, res) => {
  if (!adminOnly(req, res)) return;
  res.json({ services: await svc.listServices() });
}));

router.post('/ha/service', asyncH(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = req.body || {};
  const domain = String(b.domain || '').trim();
  const service = String(b.service || '').trim();
  if (!/^[\w_.-]{1,64}$/.test(domain) || !/^[\w_.-]{1,64}$/.test(service)) {
    return res.status(400).json({ error: 'domain / service 格式不对' });
  }
  if (b.data != null && (typeof b.data !== 'object' || Array.isArray(b.data))) {
    return res.status(400).json({ error: 'data 必须是 JSON 对象' });
  }
  const out = await svc.callService(domain, service, b.data || {});
  res.json({ ok: true, result: out });
}));

// ---------- 实时事件流（SSE：state_changed + webhook 回调 + 控制留痕；EventSource 走 ?token=） ----------
router.get('/ha/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 5000\n\n');
  const off = svc.onEvent((payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { off(); }
  });
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 客户端已断 */ } }, 20000);
  beat.unref && beat.unref();
  req.on('close', () => { off(); clearInterval(beat); });
});

// ---------- 事件 / webhook 回调流水 ----------
router.get('/ha/hooklog', (req, res) => {
  res.json({ events: svc.listEvents(Number(req.query.limit) || 50, Number(req.query.before) || 0) });
});

// webhook 入口（EXEMPT 免登录，key 即凭证）。HA 自动化的 RESTful 动作默认 POST JSON；
// 兼容 GET（HA Webhook 触发器两种都发）。只登记事件 + 实时推 SSE，不执行任何动作。
function handleHook(req, res) {
  if (!svc.hookKeyOk(req.params.key)) return res.status(403).json({ ok: false, error: 'key 不对（轮换后请同步改 HA 自动化里的地址）' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const title = String(b.title || b.name || req.query.title || 'HA 回调').slice(0, 200);
  const message = String(b.message || b.text || req.query.message || '(无正文)').slice(0, 2000);
  let payload = '';
  try { payload = JSON.stringify(req.body).slice(0, 4000); } catch { /* 空包 */ }
  svc.appendEvent('hook', title, message, payload);
  res.json({ ok: true });
}
router.post('/ha/hook/:key', handleHook);
router.get('/ha/hook/:key', handleHook);

module.exports = router;
