// AI 设置（v1.0.19）：系统级大模型接入配置，供衍像内置 AI 功能调用。
// 配置存主库 settings 表（与工作台「API 接入」同款三件套：接入地址 / API Key / 模型）。
// 兼容 OpenAI Chat Completions 协议（绝大多数服务商与网关都兼容：DeepSeek/Kimi/通义/OpenAI/one-api 等）。
const { db, getSetting, setSetting } = require('../db');

// ---------- 配置读写 ----------
function getConfig() {
  return {
    url: String(getSetting(db, 'ai_base_url', '')).trim(),
    key: String(getSetting(db, 'ai_api_key', '')).trim(),
    model: String(getSetting(db, 'ai_model', '')).trim(),
  };
}
function setConfig(cfg) {
  const c = cfg || {};
  // 三项都允许清空（清空 = 未配置，系统 AI 功能停用）；key 传空串视为「清空」而非「保持」——
  // 前端保存前先 GET 全量回填，所见即所存，避免出现「保存了却还是旧 key」的歧义状态
  setSetting(db, 'ai_base_url', String(c.url || '').trim());
  setSetting(db, 'ai_api_key', String(c.key || '').trim());
  setSetting(db, 'ai_model', String(c.model || '').trim());
  return getConfig();
}

// 完整对话端点：配置里的地址若已带 /v1 就直接拼 /chat/completions，没带也照拼
// （约定填到能拼 /chat/completions 的层级，多数网关两种都接受；测试按钮会当场验证）
function endpoint(cfg) {
  const c = cfg || getConfig();
  return String(c.url || '').replace(/\/+$/, '') + '/chat/completions';
}

// ---------- 对话（系统内置 AI 功能统一入口） ----------
// messages: [{role:'system'|'user'|'assistant', content}]
async function chat(messages, opts) {
  const cfg = getConfig();
  if (!cfg.url || !cfg.key || !cfg.model) throw new Error('AI 未配置：请先在「设置 → AI 设置」填写接入地址、API Key 与模型');
  const o = opts || {};
  const r = await fetch(endpoint(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: Number(o.max_tokens) || 1024,
      temperature: Number.isFinite(o.temperature) ? o.temperature : 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(Number(o.timeout_ms) || 60000),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const msg = (j.error && (j.error.message || j.error.code)) || j.message || ('HTTP ' + r.status);
    throw new Error('AI 调用失败：' + msg);
  }
  const data = await r.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (content == null) throw new Error('AI 返回格式异常（无 choices[0].message.content）');
  return { content: String(content), model: data.model || cfg.model, usage: data.usage || null };
}

// ---------- 连通测试（设置页「测试连接」） ----------
async function test() {
  const cfg = getConfig();
  if (!cfg.url) return { ok: false, error: '请先填写接入地址' };
  if (!cfg.key) return { ok: false, error: '请先填写 API Key' };
  if (!cfg.model) return { ok: false, error: '请先填写模型名称' };
  const t0 = Date.now();
  try {
    const r = await chat([{ role: 'user', content: '收到请只回复：OK' }], { max_tokens: 16, timeout_ms: 20000 });
    return { ok: true, latency_ms: Date.now() - t0, model: r.model, reply: r.content.slice(0, 120) };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.message };
  }
}

module.exports = { getConfig, setConfig, chat, test, endpoint };
