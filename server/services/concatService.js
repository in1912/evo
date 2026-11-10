// Concat 引擎服务（v1.0.19）：衍像服务端以 MCP 无头模式驱动 Concat 引擎完成视频合成。
// 架构：本服务 spawn `concat.exe --mcp headless`（无窗口跑引擎本体），按行 JSON-RPC 2.0
// 对话（initialize → tools/call），把用户在【视频剪辑】页选好的素材按顺序拼成时间线、
// 可加片头标题与配音音轨，然后 export 出成片——浏览器端只与衍像后端交互（BS 架构，
// 网页里不跑 Concat 本体：它的 UI 是 Slint 原生界面，无法进浏览器，能进的是它的引擎）。
//
// 协议依据：Concat v0.2.9 源码实证（工具参数 = concat-api Request/Command 的 serde 字段，camelCase：
// media.import{path=工程,file=媒体}、export.run{path,+ExportSpec 平铺}、typed 命令 {path,op+命令字段}）。
// 无头模式默认只许写用户主目录：CONCAT_MCP_ROOTS 放行衍像的数据目录与输出目录（Windows 用 ; 分隔）。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, dataDir } = require('../db');
const comfy = require('./comfyService');

const TTS_AUDIO_DIR = path.join(dataDir, 'tts_audio');
const PROJ_ROOT = path.join(dataDir, 'edit_projects');
const OUT_DIR = () => comfy.outputDir();

// ---------- 引擎定位 ----------
function findConcat() {
  const cands = [];
  if (process.env.CONCAT_BIN) cands.push(process.env.CONCAT_BIN);
  // Windows 安装路径（本机/算力机直跑）
  cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Concat', 'concat.exe')); // 每用户安装
  cands.push('C:\\Program Files\\Concat\\concat.exe');                                        // msi / 所有用户
  cands.push('C:\\Program Files (x86)\\Concat\\concat.exe');
  // Linux（NAS / 容器，无窗口，跑 headless MCP）：
  //   .deb 装到系统 → /usr/bin/concat；.deb 用 dpkg -x 解进 data 卷 → /app/data/concat/usr/bin/concat；
  //   AppImage 用 --appimage-extract 解进 data 卷 → /app/data/concat/squashfs-root/AppRun；
  //   Docker 镜像内烤进去的 AppImage 解包目录（evo/Dockerfile：--appimage-extract 到 /opt/concat）
  cands.push('/usr/local/bin/concat');
  cands.push('/usr/bin/concat');
  cands.push('/opt/concat/AppRun');
  cands.push('/opt/concat/usr/bin/concat');
  cands.push('/opt/concat/concat');
  cands.push('/app/concat/concat');
  cands.push('/app/data/concat/concat');
  cands.push('/app/data/concat/usr/bin/concat');
  cands.push('/app/data/concat/squashfs-root/AppRun');
  cands.push('/app/data/concat/squashfs-root/usr/bin/concat');
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch {} }
  return null;
}
function installed() { return !!findConcat(); }

// ---------- 素材路径解析（与 editRoutes 同一套规则） ----------
function resolveAsset(kind, name, uid) {
  const base = path.basename(String(name || ''));
  const dir = kind === 'audio' ? TTS_AUDIO_DIR : OUT_DIR();
  const p = path.resolve(dir, base);
  if (p.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(p)) return p;
  // 导入素材（剪辑台「导入」上传的文件，按用户分目录）
  if (uid) {
    const idir = path.join(dataDir, 'edit_import', 'u' + Number(uid));
    const ip = path.resolve(idir, base);
    if (ip.startsWith(path.resolve(idir) + path.sep) && fs.existsSync(ip)) return ip;
  }
  return null;
}

// ---------- MCP 会话（按行 JSON-RPC 2.0 over stdio） ----------
class McpSession {
  constructor() {
    this.nextId = 1;
    this.pending = new Map(); // id → {resolve, reject}
    this.buffer = '';
    this.proc = null;
    this.dead = '';
  }
  start() {
    const bin = findConcat();
    if (!bin) throw new Error('未检测到 Concat 引擎：请在服务器上安装 Concat（本页上方下载安装包，装完无需打开窗口）');
    this.proc = spawn(bin, ['--mcp', 'headless'], {
      windowsHide: true,
      env: {
        ...process.env,
        // 无头模式的读写白名单：衍像数据目录（素材/配音/工程/成片都在其下）。
        // 分隔符用平台原生 path.delimiter：Windows 是 ';'，Linux/macOS 是 ':'——
        // Concat 引擎按 std::env::split_paths 解析，Linux 上给 ';' 会当成单个目录名整段失效。
        CONCAT_MCP_ROOTS: [dataDir, OUT_DIR()].join(path.delimiter),
      },
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', () => {}); // 引擎日志丢弃（量大且不需要）
    this.proc.on('exit', (code) => { this.dead = '引擎进程退出（code ' + code + '）'; this.failAll(this.dead); });
    this.proc.on('error', (e) => { this.dead = '引擎进程启动失败：' + e.message; this.failAll(this.dead); });
    return this.handshake();
  }
  failAll(msg) { for (const [, p] of this.pending) p.reject(new Error(msg)); this.pending.clear(); }
  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      // 通知（progress 等）忽略：进度我们自己用 export.status 轮询
    }
  }
  request(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error(this.dead));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('引擎响应超时（' + method + '，' + Math.round(timeoutMs / 1000) + 's）'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params: params || {} }); }
  send(msg) {
    if (!this.proc || this.proc.exitCode != null) throw new Error(this.dead || '引擎进程不在');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  async handshake() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'evolveshot', version: '1.0.19' },
    }, 60000);
    this.notify('notifications/initialized');
    return r; // {protocolVersion, serverInfo, ...}
  }
  // tools/call：优先读 structured，退化读 content[0].text
  async tool(name, args, timeoutMs = 120000) {
    const r = await this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
    if (r && r.isError) {
      const t = r.content && r.content[0] && r.content[0].text;
      throw new Error(t || ('工具 ' + name + ' 返回错误'));
    }
    if (r && r.structured != null) return r.structured;
    if (r && r.content && r.content[0] && r.content[0].text) {
      try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
    }
    return r;
  }
  kill() {
    this.pending.clear();
    if (this.proc) { try { this.proc.kill(); } catch {} }
  }
}

// ---------- 渲染任务队列（串行：一个引擎一次跑一个导出） ----------
let queueTail = Promise.resolve();
const active = new Map(); // jobId → {session, exportJobId}

// 导出 + 轮询进度（快剪管线与剪辑台导出共用）。成功 resolve；失败/取消 throw 或落库后 return。
// 引擎五阶段（JobStatus.stage 原文）：cutout → stabilize → rendering → mixing audio → muxing
const STAGES = ['cutout', 'stabilize', 'rendering', 'mixing audio', 'muxing'];
const stageOf = (name) => (name === 'rendering in software' ? 2 : Math.max(0, STAGES.indexOf(String(name || ''))));
async function exportAndPoll(jobId, sess, outPath, opts = {}) {
  const t0 = Date.now();
  setJob(jobId, { progress: '渲染导出中', progress_pct: 55 });
  const ex = await sess.tool('export_start', { path: opts.projectPath, output: outPath, crf: 20 }, 180000);
  const exJob = ex && (ex.job != null ? ex.job : ex.jobId);
  if (active.has(jobId)) active.get(jobId).exportJobId = exJob;
  const tExport = Date.now();
  // stage 在引擎开口前缺席（fraction 同）——按 rendering 起步小量估，避免起步 0% 跳变
  while (true) {
    await new Promise((r) => setTimeout(r, opts.pollMs || 2000));
    const st = db.prepare('SELECT status FROM edit_jobs WHERE id=?').get(jobId);
    if (st && st.status === 'cancelling') {
      try { await sess.tool('export_cancel', exJob != null ? { job: exJob } : {}); } catch {}
      return setJob(jobId, { status: 'cancelled', progress: '已取消', progress_pct: 100, duration_ms: Date.now() - t0 });
    }
    let s;
    try { s = await sess.tool('export_status', exJob != null ? { job: exJob } : {}, 30000); }
    catch (e) { throw new Error('查询导出状态失败：' + e.message); }
    const hasStage = !!(s && s.stage);
    const frac = Math.max(0, Math.min(1, Number(s && s.fraction) || 0));
    const overall = (stageOf(s && s.stage) + (hasStage ? frac : 0.05)) / STAGES.length;
    setJob(jobId, { progress_pct: Math.min(99, 55 + Math.round(overall * 44)), progress: '渲染导出中 ' + Math.round(overall * 100) + '%' });
    if (s && s.state === 'done') break;
    if (s && s.state === 'failed') throw new Error('导出失败：' + ((s.error && (s.error.message || s.error.code)) || '引擎未给出原因'));
    if (s && s.state === 'cancelled') return setJob(jobId, { status: 'cancelled', progress: '已取消', progress_pct: 100, duration_ms: Date.now() - t0 });
    if (Date.now() - tExport > (opts.timeoutMs || 40 * 60 * 1000)) throw new Error('导出超时（>40 分钟）');
  }
  if (!fs.existsSync(outPath)) throw new Error('引擎报告完成但成片文件不存在：' + outPath);
  setJob(jobId, {
    status: 'done', progress: '完成', progress_pct: 100,
    output_path: outPath, duration_ms: Date.now() - t0,
  });
  console.log(`[edit] #${jobId} 合成完成：${outPath}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

function setJob(id, patch) {
  const cols = Object.keys(patch).map((c) => c + '=?').join(', ');
  db.prepare(`UPDATE edit_jobs SET ${cols} WHERE id=?`).run(...Object.values(patch), id);
}

// 探一个视频文件拿画幅/帧率（失败给 1080p30 默认）——快剪与剪辑台共用
async function probeVideoSettings(sess, absPath) {
  try {
    // media.probe 参数是 {path}；回包 MediaSummary{video:{width,height,frameRate,frameRateFraction}}
    const probe = await sess.tool('media_probe', { path: absPath });
    const v = probe && probe.video;
    if (v && Number(v.width) && Number(v.height)) {
      const frac = String(v.frameRateFraction || '').split('/'); // "30000/1001"
      return {
        width: Number(v.width), height: Number(v.height),
        rateNum: Number(frac[0]) || Math.round(Number(v.frameRate)) || 30,
        rateDen: Number(frac[1]) || 1,
      };
    }
  } catch (e) { console.log('[edit] probe 失败（用默认画幅）：' + e.message); }
  return { width: 1920, height: 1080, rateNum: 30, rateDen: 1 };
}

// spec: { title, items: [{kind, name}] }（kind=image|video|audio；name=素材文件名）
async function runJob(jobId) {
  const job = db.prepare('SELECT * FROM edit_jobs WHERE id=?').get(jobId);
  if (!job || job.status === 'cancelled') return;
  const spec = JSON.parse(job.spec || '{}');
  const items = (spec.items || []).filter((i) => i && i.kind && i.name);
  const visuals = [], audios = [], missing = [];
  for (const it of items) {
    const p = resolveAsset(it.kind, it.name, job.user_id);
    if (!p) { missing.push(it.name); continue; }
    (it.kind === 'audio' ? audios : visuals).push({ ...it, abs: p });
  }
  if (!visuals.length && !audios.length) {
    return setJob(jobId, { status: 'failed', error: '素材文件全部不存在：' + missing.join('、'), progress_pct: 100 });
  }
  if (missing.length) console.log(`[edit] 任务 #${jobId} 缺失素材（跳过）：` + missing.join('、'));

  const sess = new McpSession();
  active.set(jobId, { session: sess });
  const t0 = Date.now();
  const projDir = path.join(PROJ_ROOT, 'evoedit_' + jobId);
  const outPath = path.join(OUT_DIR(), 'evoedit_' + jobId + '.mp4');
  let projectPath = '';
  try {
    // ① 引擎握手
    setJob(jobId, { status: 'running', progress: '启动 Concat 引擎', progress_pct: 2 });
    const hello = await sess.start();
    console.log(`[edit] #${jobId} 引擎就绪：` + JSON.stringify(hello && hello.serverInfo || {}));

    // ② 探第一个视频素材拿画幅/帧率（无视频则 1080p30 默认）
    const video = await probeVideoSettings(sess, (visuals.find((v) => v.kind === 'video') || {}).abs);

    // ③ 建工程（并自动打开）。回包是 Summary（不含 path）——工程目录 = location/name，
    //    folder_name() 对 "evoedit_<id>"（字母数字下划线）原样保留，路径确定可推。
    fs.mkdirSync(PROJ_ROOT, { recursive: true });
    setJob(jobId, { progress: '创建剪辑工程', progress_pct: 6 });
    await sess.tool('project_create', { location: projDir, name: 'evoedit_' + jobId, video });
    projectPath = path.join(projDir, 'evoedit_' + jobId);

    // ④ 导入素材 → 时间线。参数名对 concat-api Request/Command 的 serde 字段（camelCase）：
    //    media.import {path=工程, file=媒体}；typed 命令工具 {path=工程, ...命令字段}
    //    （addClipsInSequence{mediaIds, trackId?, start}、addTrack{}、addTextClip{style, above}）
    const mediaIds = [];
    let done = 0;
    const total = visuals.length + audios.length;
    for (const v of visuals) {
      done++;
      setJob(jobId, { progress: `导入素材 ${done}/${total}`, progress_pct: 6 + Math.round(done / total * 34) });
      const r = await sess.tool('media_import', { path: projectPath, file: v.abs });
      const id = r && r.createdId;
      if (id == null) throw new Error('导入素材失败：' + v.name);
      mediaIds.push(id);
    }
    if (mediaIds.length) {
      setJob(jobId, { progress: '编排时间线', progress_pct: 45 });
      await sess.tool('clips_add_sequence', { path: projectPath, mediaIds, start: 0 });
    }
    // 配音/音频：单独一条音轨（addTrack 默认加在最顶），从 0 起依次排
    if (audios.length) {
      setJob(jobId, { progress: '铺配音音轨', progress_pct: 50 });
      const track = await sess.tool('track_add', { path: projectPath });
      const trackId = track && track.createdId;
      const audioIds = [];
      for (const a of audios) {
        const r = await sess.tool('media_import', { path: projectPath, file: a.abs });
        const id = r && r.createdId;
        if (id != null) audioIds.push(id);
      }
      if (audioIds.length && trackId) await sess.tool('clips_add_sequence', { path: projectPath, mediaIds: audioIds, trackId, start: 0 });
    }
    // 片头标题（可选）：above=true 落在画面上方的独立轨
    if (spec.title && String(spec.title).trim()) {
      await sess.tool('title_add', { path: projectPath, start: 0, duration: 4, above: true, style: { content: String(spec.title).trim() } });
    }

    // ⑤ 导出 + 轮询（共用 helper）
    await exportAndPoll(jobId, sess, outPath, { projectPath });

    // ⑥ 收尾：关工程（不保存）、结束引擎
    try { await sess.tool('project_close', { path: projectPath }); } catch {}
  } catch (e) {
    setJob(jobId, { status: 'failed', error: String(e.message || e), progress_pct: 100, duration_ms: Date.now() - t0 });
    console.warn(`[edit] #${jobId} 失败：`, e.message);
  } finally {
    active.delete(jobId);
    sess.kill();
  }
}

// 入队（串行）
function enqueueJob(jobId) {
  queueTail = queueTail.then(() => runJob(jobId)).catch(() => {});
  return jobId;
}

// 取消：改状态，runJob 轮询循环里看到就 cancel
function cancelJob(jobId) {
  const job = db.prepare('SELECT status FROM edit_jobs WHERE id=?').get(jobId);
  if (!job) return false;
  if (job.status === 'running') { setJob(jobId, { status: 'cancelling' }); return true; }
  if (job.status === 'pending') { setJob(jobId, { status: 'cancelled', progress: '已取消', progress_pct: 100 }); return true; }
  return false;
}

// 重启收养：普通快剪任务引擎会话已随进程消亡，直接置失败（素材都在，用户可一键重提）；
// 剪辑台（studio）任务的工程已随导出落盘（导出前 project_save），开新会话重开工程接着导出。
function adoptOnBoot() {
  try {
    const rows = db.prepare("SELECT id, spec FROM edit_jobs WHERE status IN ('running','cancelling')").all();
    let failed = 0, resumed = 0;
    for (const r of rows) {
      const spec = (() => { try { return JSON.parse(r.spec || '{}'); } catch { return {}; } })();
      if (spec.studio && spec.projectPath) {
        resumed++;
        resumeStudioExport(r.id, spec).catch(() => {});
      } else {
        failed++;
        setJob(r.id, { status: 'failed', error: '服务重启，合成中断——素材还在，可重新发起', progress_pct: 100 });
      }
    }
    // pending 的保留，boot 后重新入队（studio 的 pending 也走 resumeStudioExport）
    const pend = db.prepare("SELECT id, spec FROM edit_jobs WHERE status='pending'").all();
    for (const r of pend) {
      const spec = (() => { try { return JSON.parse(r.spec || '{}'); } catch { return {}; } })();
      if (spec.studio && spec.projectPath) { resumed++; resumeStudioExport(r.id, spec).catch(() => {}); }
      else enqueueJob(r.id);
    }
    if (failed || resumed) console.log(`[boot] edit_jobs: 置失败 ${failed} 个、续导出 ${resumed} 个`);
  } catch (e) { console.warn('[boot] edit_jobs 清账失败:', e.message); }
}

// ---------- 剪辑台（studio）：每用户一个常驻引擎会话 + 一个工程 ----------
// 结构对齐 Concat：素材库/多轨时间线/检查器都在衍像网页上，引擎只在服务端跑。
// 会话空闲 15 分钟自动保存关闭；导出前也会保存（工程可续、任务可收养）。
const studios = new Map(); // userId → {sess, projectPath, name, rev, lastTouch, dying}
const STUDIO_IDLE_MS = 15 * 60 * 1000;

function studioStateOf(userId) {
  const st = studios.get(userId);
  if (!st) return null;
  st.lastTouch = Date.now();
  return st;
}

// 剪辑台命令白名单：op 名与字段全按 concat-api Command 枚举（camelCase）
// v1.0.21 增补：贴纸(形状)/转场/效果·滤镜·音效图层——引擎 0.2.9 实测全部可用
const STUDIO_OPS = new Set([
  'addClip', 'addClipAtFirstFree', 'addClipsInSequence', 'trimClip', 'splitClips', 'moveClips',
  'removeClips', 'updateClip', 'setClipTransform', 'setClipSpeed', 'frameClip', 'detachAudio',
  'reattachAudio', 'addTextClip', 'addTrack', 'removeTrack', 'setTrackFlag', 'setTimelineVideo',
  'addShapeClip', 'addTransitionClip', 'addLayerClip',
  'batch',
]);

// 效果目录（转场/滤镜/效果/音效/调节）：引擎级清单与工程无关，进程内缓存一份
let effectsCache = { at: 0, list: null };
async function effectsList() {
  if (effectsCache.list && Date.now() - effectsCache.at < 10 * 60 * 1000) return effectsCache.list;
  // 优先复用任一活着的会话；没有就临时拉一个引擎问一次
  const anyStudio = studios.values().next().value;
  let sess = anyStudio && !anyStudio.dying ? anyStudio.sess : null;
  let tmp = null;
  if (!sess) {
    for (const a of active.values()) { sess = a.session; break; }
  }
  if (!sess) {
    await ensureEngine();
    tmp = new McpSession();
    await tmp.start();
    sess = tmp;
  }
  try {
    const list = await sess.tool('effects_list', {});
    effectsCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
    return effectsCache.list;
  } finally {
    if (tmp) tmp.kill();
  }
}

async function studioOpen(userId, opts = {}) {
  await ensureEngine();
  const existing = studios.get(userId);
  if (existing && !existing.dying) { existing.lastTouch = Date.now(); return existing; }

  // resume：找该用户最近保存的剪辑台工程（目录里有 concat.json 即工程）
  let resumePath = '';
  if (opts.resume) {
    const cands = fs.existsSync(PROJ_ROOT)
      ? fs.readdirSync(PROJ_ROOT)
          .filter((d) => d.startsWith('studio_u' + userId + '_') && fs.existsSync(path.join(PROJ_ROOT, d, 'concat.json')))
          .sort()
      : [];
    if (cands.length) resumePath = path.join(PROJ_ROOT, cands[cands.length - 1]);
  }

  const sess = new McpSession();
  const st = { sess, projectPath: '', name: '', rev: 0, lastTouch: Date.now(), dying: false };
  try {
    await sess.start();
    fs.mkdirSync(PROJ_ROOT, { recursive: true });
    if (resumePath) {
      await sess.tool('project_open', { path: resumePath });
      st.projectPath = resumePath;
      st.name = path.basename(resumePath);
    } else {
      // 新工程：画幅/帧率跟随第一个视频素材（无则 1080p30）
      const items = (opts.items || []).filter((i) => i && i.kind && i.name);
      let video = { width: 1920, height: 1080, rateNum: 30, rateDen: 1 };
      const firstVid = items.find((i) => i.kind === 'video');
      if (firstVid) {
        const abs = resolveAsset('video', firstVid.name, userId);
        if (abs) video = await probeVideoSettings(sess, abs);
      }
      const name = 'studio_u' + userId + '_' + Date.now();
      await sess.tool('project_create', { location: PROJ_ROOT, name, video });
      st.projectPath = path.join(PROJ_ROOT, name);
      st.name = name;
      // 开场即把勾选素材入素材库（不上时间线——由用户在时间线上摆放）
      for (const it of items) {
        const abs = resolveAsset(it.kind, it.name, userId);
        if (abs) { try { await sess.tool('media_import', { path: st.projectPath, file: abs }); } catch (e) { console.log('[studio] 导入跳过 ' + it.name + ': ' + e.message); } }
      }
    }
  } catch (e) {
    sess.kill();
    throw e;
  }
  studios.set(userId, st);
  return st;
}

// 读当前状态（timeline_read → Summary{project,timeline,media,canUndo,canRedo}）
async function studioState(userId) {
  const st = studioStateOf(userId);
  if (!st) return null;
  const summary = await st.sess.tool('timeline_read', { path: st.projectPath });
  return { ...summary, path: st.projectPath, rev: st.rev };
}

// 执行一条剪辑命令（edit.apply），成功后 rev++（前端预览缓存按 rev 失效）
async function studioCommand(userId, op, args) {
  const st = studioStateOf(userId);
  if (!st) throw new Error('剪辑台未打开');
  if (!STUDIO_OPS.has(op)) throw new Error('不支持的剪辑操作：' + op);
  const summary = await st.sess.tool('edit_apply', { path: st.projectPath, command: { op, ...(args || {}) } });
  st.rev++;
  return { ...summary, path: st.projectPath, rev: st.rev };
}

// 素材入素材库
async function studioImport(userId, kind, name) {
  const st = studioStateOf(userId);
  if (!st) throw new Error('剪辑台未打开');
  const abs = resolveAsset(kind, name, userId);
  if (!abs) throw new Error('素材不存在：' + name);
  const summary = await st.sess.tool('media_import', { path: st.projectPath, file: abs });
  return { ...summary, path: st.projectPath, rev: st.rev };
}

// 撤销/重做
async function studioUndo(userId, redo) {
  const st = studioStateOf(userId);
  if (!st) throw new Error('剪辑台未打开');
  const summary = await st.sess.tool(redo ? 'edit_redo' : 'edit_undo', { path: st.projectPath });
  st.rev++;
  return { ...summary, path: st.projectPath, rev: st.rev };
}

// 真实帧预览：preview_frame 不带 output → 回包 content[0].data = base64 PNG（≤1280 边）
async function studioPreview(userId, t) {
  const st = studioStateOf(userId);
  if (!st) throw new Error('剪辑台未打开');
  const time = Math.max(0, Number(t) || 0);
  const r = await st.sess.request('tools/call', { name: 'preview_frame', arguments: { path: st.projectPath, time } }, 60000);
  if (r && r.isError) {
    const txt = r.content && r.content[0] && r.content[0].text;
    throw new Error(txt || '预览渲染失败');
  }
  const img = r && r.content && r.content.find((c) => c.type === 'image');
  const meta = r && r.structured || {};
  return { png: img ? img.data : '', width: meta.width, height: meta.height, time, rev: st.rev };
}

// 保存（导出前/空闲关闭时）
async function studioSave(userId) {
  const st = studios.get(userId);
  if (!st || st.dying) return;
  try { await st.sess.tool('project_save', { path: st.projectPath }); } catch (e) { console.log('[studio] 保存失败：' + e.message); }
}

// 关闭会话（保存 + 结束引擎）
async function studioClose(userId) {
  const st = studios.get(userId);
  if (!st) return;
  st.dying = true;
  studios.delete(userId);
  try { await st.sess.tool('project_close', { path: st.projectPath, save: true }); } catch {}
  st.sess.kill();
}

// 剪辑台导出：edit_jobs 落一行（spec.studio=true），用**用户自己的会话**导出（工程被它
// 占用，第二个引擎进程打不开同一工程）。导出前先保存。
async function studioExport(userId, title) {
  const st = studioStateOf(userId);
  if (!st) throw new Error('剪辑台未打开');
  const info = db.prepare('INSERT INTO edit_jobs(user_id, title, spec) VALUES(?,?,?)').run(
    userId, String(title || '').slice(0, 100),
    JSON.stringify({ studio: true, projectPath: st.projectPath, title: String(title || '').slice(0, 100) })
  );
  const id = Number(info.lastInsertRowid);
  const t0 = Date.now();
  active.set(id, { session: st.sess });
  (async () => {
    try {
      setJob(id, { status: 'running', progress: '保存工程', progress_pct: 5 });
      await studioSave(userId);
      await exportAndPoll(id, st.sess, path.join(OUT_DIR(), 'evoedit_' + id + '.mp4'), { projectPath: st.projectPath });
    } catch (e) {
      setJob(id, { status: 'failed', error: String(e.message || e), progress_pct: 100, duration_ms: Date.now() - t0 });
      console.warn(`[edit] #${id}（剪辑台）失败：`, e.message);
    } finally {
      active.delete(id);
    }
  })().catch(() => {});
  return id;
}

// 服务重启后的剪辑台导出收养：工程已保存，开独立会话重开工程接着导出
async function resumeStudioExport(jobId, spec) {
  const sess = new McpSession();
  const t0 = Date.now();
  active.set(jobId, { session: sess });
  try {
    setJob(jobId, { status: 'running', progress: '重开剪辑工程', progress_pct: 5 });
    await sess.start();
    await sess.tool('project_open', { path: spec.projectPath });
    await exportAndPoll(jobId, sess, path.join(OUT_DIR(), 'evoedit_' + jobId + '.mp4'), { projectPath: spec.projectPath });
    try { await sess.tool('project_close', { path: spec.projectPath }); } catch {}
  } catch (e) {
    setJob(jobId, { status: 'failed', error: '续导出失败：' + String(e.message || e), progress_pct: 100, duration_ms: Date.now() - t0 });
  } finally {
    active.delete(jobId);
    sess.kill();
  }
}

// 引擎检查（剪辑台打开前给一句人话）
function ensureEngine() {
  if (!installed()) throw new Error('服务器未安装 Concat 引擎：请管理员先安装（本页上方可下载），装完无需打开窗口');
  return true;
}

// 空闲回收：每分钟看一眼，>15 分钟未动的会话保存并关闭
setInterval(() => {
  const now = Date.now();
  for (const [uid, st] of studios) {
    if (now - st.lastTouch > STUDIO_IDLE_MS) studioClose(uid).catch(() => {});
  }
}, 60 * 1000).unref();

// 可续开的工程列表（该用户）
function studioProjects(userId) {
  try {
    return fs.readdirSync(PROJ_ROOT)
      .filter((d) => d.startsWith('studio_u' + userId + '_') && fs.existsSync(path.join(PROJ_ROOT, d, 'concat.json')))
      .sort().reverse()
      .map((d) => ({ name: d, mtime: fs.statSync(path.join(PROJ_ROOT, d)).mtime.toISOString() }));
  } catch { return []; }
}

module.exports = {
  installed, findConcat, resolveAsset, enqueueJob, cancelJob, adoptOnBoot, TTS_AUDIO_DIR,
  studioOpen, studioState, studioCommand, studioImport, studioUndo, studioPreview,
  studioSave, studioClose, studioExport, studioProjects, effectsList,
};
