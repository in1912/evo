// 系统监控路由：GPU/CPU 利用率实时采样（浮窗曲线图数据源）。
// - GET /api/system/gpu          公开（供算力端实例间中继）：本机 nvidia-smi + WMI 采样
//                                 ?url=http://… 中继另一台算力端（同为衍像实例）；不可用时退回该地址 ComfyUI /system_stats（仅显存）
// - GET /api/system/gpu-sources  登录即可：列出可显示的算力端（本机 + 配置为远端的 zimage/h3）
// 采样口径与任务管理器一致：CUDA=SM 利用率；专用显存=nvidia-smi memory；共享显存=WDDM 共享池（物理内存的一半）；
// CPU=整机处理器占用（v1.0.15：PerfRawData 两次差值算空闲率；WMI「格式化」计数器单次查询恒为 0 不可用）。
const express = require('express');
const { execFile } = require('child_process');
const { db } = require('../db');
const comfy = require('../services/comfyService');

const NSMI = process.env.NVIDIA_SMI || 'nvidia-smi';
const CACHE_MS = 800; // 多标签页同时轮询时合流
let cached = null;    // { at, data }
const remoteCache = new Map(); // url → { at, data }
let ramTotalBytes = 0; // 物理内存总量（共享池=一半；机器不变就不再查）

function sh(cmd, args, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (e, stdout) => (e ? reject(e) : resolve(String(stdout || ''))));
  });
}

async function ramTotal() {
  if (ramTotalBytes > 0) return ramTotalBytes;
  try {
    // wmic CSV 是「表头一行、数值一行」（行尾 \r\r\n），数值行形如 "WPQ-HOME,68550828032"
    const out = await sh('wmic', ['ComputerSystem', 'get', 'TotalPhysicalMemory', '/format:csv']);
    for (const l of out.split(/\r?\n/)) {
      const m = l.trim().match(/^.*?,(\d+)\s*$/);
      if (m) { ramTotalBytes = Number(m[1]); break; }
    }
  } catch { ramTotalBytes = 0; }
  return ramTotalBytes;
}

// Windows GPU 适配器计数（WMI 类名与语言无关）：取专用占用最大的适配器 = 独显（CUDA 所在）
async function wmiAdapterMemory() {
  const out = await sh('wmic', ['path', 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory', 'get', 'DedicatedUsage,SharedUsage', '/format:csv']);
  const lines = out.split(/\r?\n/).filter((l) => l.includes(',') && /\d/.test(l));
  let best = null;
  for (const l of lines) {
    const p = l.trim().split(',');
    const d = Number(p[p.length - 2]) || 0;
    const s = Number(p[p.length - 1]) || 0;
    if (!best || d > best.ded) best = { ded: d, shr: s };
  }
  return best; // bytes；可能为 null（无 WMI GPU 计数器）
}

// 整机 CPU 占用（v1.0.15）。Win32_PerfFormattedData 的 % Processor Time 单次查询恒为 0
// （率型计数器要两个样本），所以读 PerfRawData 原始值自己做差：
//   CPU% = (1 - Δ空闲/Δ总时间) × 100，其中「空闲」=_Total 行的原始 PercentProcessorTime（WMI 的历史怪癖：_Total 的原始值就是 Idle）。
// 原始值是绝对量（自开机累计），跨进程/跨秒取差都成立；首次无差值返回 null（浮窗显 —）。
let lastCpuRaw = null; // { idle, sys }（100ns 单位）
async function cpuSample() {
  try {
    const out = await sh('wmic', ['path', 'Win32_PerfRawData_PerfOS_Processor', 'where', "Name='_Total'", 'get', 'PercentProcessorTime,TimeStamp_Sys100NS', '/format:csv']);
    for (const l of out.split(/\r?\n/)) {
      const p = l.trim().split(',');
      if (p.length >= 3 && /^\d+$/.test(p[p.length - 1]) && /^\d+$/.test(p[p.length - 2])) {
        const idle = Number(p[p.length - 2]), sys = Number(p[p.length - 1]);
        const prev = lastCpuRaw;
        lastCpuRaw = { idle, sys };
        if (prev) {
          const dSys = sys - prev.sys, dIdle = idle - prev.idle;
          if (dSys > 0 && dIdle >= 0 && dIdle <= dSys) return Math.max(0, Math.min(100, +((1 - dIdle / dSys) * 100).toFixed(1)));
        }
        return null; // 首次采样（或计数器回绕）：无差值
      }
    }
  } catch { /* 落到 LoadPercentage 兜底 */ }
  // 兜底：Win32_Processor.LoadPercentage（点值，粒度粗但单次查询就有数）
  try {
    const out = await sh('wmic', ['cpu', 'get', 'loadpercentage', '/format:csv']);
    const vals = out.split(/\r?\n/).map((l) => (l.trim().match(/,(\d+)\s*$/) || [])[1]).map(Number).filter((v) => Number.isFinite(v));
    if (vals.length) return Math.max(0, Math.min(100, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)));
  } catch {}
  return null;
}

async function sampleLocal() {
  try {
    const [smi, adapter, ram, cpu] = await Promise.all([
      sh(NSMI, ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']),
      wmiAdapterMemory().catch(() => null),
      ramTotal(),
      cpuSample().catch(() => null),
    ]);
    const parts = smi.split('\n')[0].trim().split(',').map((s) => s.trim());
    if (parts.length < 4) throw new Error('nvidia-smi 输出异常');
    const memTotal = Number(parts[parts.length - 1]) || 0;
    const memUsed = Number(parts[parts.length - 2]) || 0;
    const util = Number(parts[parts.length - 3]) || 0;
    const device = parts.slice(0, parts.length - 3).join(', ');
    const sharedTotalMB = ram > 0 ? Math.round(ram / 2 / 1048576) : 0; // Windows 共享 GPU 内存上限 = 物理内存 50%
    const sharedUsedMB = adapter ? Math.round(adapter.shr / 1048576) : 0;
    return {
      available: true, ts: Date.now(), device,
      cpu_pct: cpu == null ? null : Math.max(0, Math.min(100, cpu)),
      cuda_pct: Math.max(0, Math.min(100, util)),
      dedicated: { used_mb: memUsed, total_mb: memTotal, pct: memTotal > 0 ? +((memUsed / memTotal) * 100).toFixed(1) : 0 },
      shared: { used_mb: sharedUsedMB, total_mb: sharedTotalMB, pct: sharedTotalMB > 0 ? +((sharedUsedMB / sharedTotalMB) * 100).toFixed(1) : 0 },
    };
  } catch (e) {
    return { available: false, ts: Date.now(), error: 'GPU 采样失败：' + (e.message || e) };
  }
}

// 远端算力端：同为衍像实例 → /api/system/gpu；只有 ComfyUI → /system_stats（仅显存可用）
async function tryEvolveGpu(u) {
  try { return await fetch(u + '/api/system/gpu', { signal: AbortSignal.timeout(2000) }).then((x) => (x.ok ? x.json() : null)); }
  catch { return null; }
}
async function sampleRemote(base) {
  const url = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('地址必须是 http(s)://');
  let r = await tryEvolveGpu(url); // 远端本身是衍像实例（实例间中继）
  if ((!r || !r.available) && !/:9666\b/.test(url)) {
    // 远端是纯 ComfyUI（8188/8189）时，探测同主机 9666 的衍像算力端 → 拿完整 CUDA 三曲线
    const m = url.match(/^https?:\/\/[^:/]+/);
    if (m) { const r2 = await tryEvolveGpu(m[0] + ':9666'); if (r2 && r2.available) r = r2; }
  }
  if (r && r.available) return { ...r, remote: url };
  const st = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(2500) }).then((x) => (x.ok ? x.json() : null));
  const dev = st && st.devices && st.devices[0];
  if (!dev) throw new Error('远端无 GPU 信息');
  const total = Math.round((dev.vram_total || 0) / (1024 * 1024));
  const used = Math.round(((dev.vram_total || 0) - (dev.vram_free || 0)) / (1024 * 1024));
  return {
    available: true, ts: Date.now(), device: dev.name, remote: url, partial: true,
    cpu_pct: null, cuda_pct: null,
    dedicated: { used_mb: used, total_mb: total, pct: total > 0 ? +((used / total) * 100).toFixed(1) : 0 },
    shared: { used_mb: null, total_mb: null, pct: null },
  };
}

const publicRouter = express.Router();
publicRouter.get('/system/gpu', async (req, res) => {
  try {
    if (req.query.url) {
      const data = await sampleRemoteCached(String(req.query.url));
      if (data.available) return res.json(data);
      return res.status(502).json(data);
    }
    if (cached && Date.now() - cached.at < CACHE_MS) return res.json(cached.data);
    const data = await sampleLocal();
    cached = { at: Date.now(), data };
    return res.json(data);
  } catch (e) {
    res.status(502).json({ available: false, error: '远端算力不可达：' + (e.message || e) });
  }
});

function sampleRemoteCached(url) {
  const hit = remoteCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
  return sampleRemote(url)
    .then((data) => { remoteCache.set(url, { at: Date.now(), data }); return data; })
    .catch((e) => {
      const data = { available: false, ts: Date.now(), error: '远端算力不可达：' + (e.message || e) };
      remoteCache.set(url, { at: Date.now(), data });
      return data;
    });
}

// 算力端列表（本机 + remote 模式的 zimage/h3，按 url 去重）
function gpuSources() {
  const list = [{ key: 'local', label: '本机算力', url: null }];
  const seen = new Set();
  for (const kind of ['zimage', 'h3']) {
    if (comfy.getMode(kind) !== 'remote') continue;
    const url = comfy.getUrl(kind);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    list.push({ key: url, label: (kind === 'zimage' ? '文生图' : 'H3') + '远端 ' + url.replace(/^https?:\/\//, ''), url });
  }
  return list;
}

const authedRouter = express.Router();
authedRouter.get('/system/gpu-sources', (req, res) => { res.json({ sources: gpuSources() }); });

// 一次拉回所有算力端采样（浮窗「自动跟随耗用」用：每个 tick 一个请求拿全部）
authedRouter.get('/system/gpu-all', async (req, res) => {
  const sources = gpuSources();
  const local = (cached && Date.now() - cached.at < CACHE_MS) ? cached.data : await sampleLocal();
  cached = { at: Date.now(), data: local };
  const remotes = {};
  await Promise.all(sources.filter((s) => s.url).map(async (s) => { remotes[s.url] = await sampleRemoteCached(s.url); }));
  res.json({ sources, local, remotes });
});

// ---------- 释放显存（浮窗「释放显存」按钮；仅管理员） ----------
// 目标：url = 浮窗当前显示的远端算力端地址；不传/非 http(s) = 本机 ComfyUI（127.0.0.1:8189）。
// 流程：先查「本系统运行中/排队中的任务（三张任务表）+ 目标 ComfyUI 队列」→ 有任务且未带 stop 时
// 返回 200 {busy:true} 让前端弹提醒（点取消不释放）；带 stop:true 再来 = interrupt 中断当前 +
// 清空排队 + 本系统任务置 failed，最后 POST /free {unload_models+free_memory}——
// 专用显存（卸载模型）与共享显存（内存缓存）一次一体释放。
const LOCAL_COMFY = `http://127.0.0.1:${Number(process.env.COMFYUI_PORT || 8189)}`;
authedRouter.post('/system/gpu/free', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可释放显存' });
    const raw = String((req.body && req.body.url) || '').trim().replace(/\/+$/, '');
    const base = /^https?:\/\//i.test(raw) ? raw : LOCAL_COMFY;
    const stop = !!(req.body && req.body.stop);

    // ① 目标 ComfyUI 队列（运行中 + 排队，含其他客户端提交的）
    const qr = await fetch(base + '/queue', { signal: AbortSignal.timeout(4000) });
    if (!qr.ok) throw new Error('算力端队列接口不可达（HTTP ' + qr.status + '）：' + base);
    const qd = await qr.json().catch(() => ({}));
    const qRunning = (qd.queue_running || []).length;
    const qPending = (qd.queue_pending || []).length;

    // ② 本系统数据库里运行中/排队中的任务（远端算力上跑的也是本系统提交的，一并计入）
    const tables = [['gen_jobs', '首尾视频'], ['img_jobs', '文生图'], ['h3_jobs', 'H3视频']];
    const jobs = [];
    for (const [t, label] of tables) {
      const rows = db.prepare(`SELECT id, prompt, status FROM ${t} WHERE status IN ('running','pending') ORDER BY id`).all();
      for (const r of rows) jobs.push({ kind: label, id: r.id, status: r.status, prompt: String(r.prompt || '').slice(0, 60) });
    }

    const total = qRunning + qPending + jobs.length;
    if (total > 0 && !stop) return res.json({ busy: true, running: qRunning, pending: qPending, jobs });
    if (total > 0) {
      await fetch(base + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(4000) }).catch(() => {});
      await fetch(base + '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"clear":true}', signal: AbortSignal.timeout(4000) }).catch(() => {});
      for (const [t] of tables) {
        db.prepare(`UPDATE ${t} SET status='failed', error='管理员释放显存，任务已停止', progress='已停止', progress_pct=100 WHERE status IN ('running','pending')`).run();
      }
    }

    // ③ 一体释放：卸载模型（专用显存）+ 清空缓存（共享显存/内存）。卸载大模型可能要十几秒，超时放宽。
    const fr = await fetch(base + '/free', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"unload_models":true,"free_memory":true}', signal: AbortSignal.timeout(90000),
    });
    if (!fr.ok) throw new Error('释放指令被算力端拒绝（HTTP ' + fr.status + '）：' + base);
    res.json({ ok: true, base, stopped: total });
  } catch (e) {
    const tailed = e && e.name === 'TimeoutError' ? '（算力端无响应）' : '';
    res.status(502).json({ error: '释放显存失败：' + (e.message || e) + tailed });
  }
});

module.exports = { publicRouter, authedRouter };
