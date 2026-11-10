// 视频剪辑页（v1.0.19，衍像 × Concat）：
// - GET /edit/assets          我的素材（图像/视频/音频）：三类生成任务产物 + MOSS 配音文件
// - GET /edit/file/:kind/:name  素材文件流（?dl=1 附下载头）——剪辑页只凭本页权限即可取素材，
//                               不依赖 zimage/h3/voice 各页的 output 端点（普通用户逐页授权模型下不再被 403 拦）
// - GET /edit/concat/status   服务器托管的 Concat 安装包状态（版本/大小/SHA256）
// - GET /edit/concat/download 下载 Concat 安装包（内网用户无需访问 GitHub）
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, dataDir } = require('../db');
const comfy = require('../services/comfyService');
const concat = require('../services/concatService');

const router = express.Router();

// ---------- 素材文件定位 ----------
const TTS_AUDIO_DIR = path.join(dataDir, 'tts_audio');
const CONCAT_DIR = path.join(__dirname, '..', '..', 'res', 'concat');
const IMPORT_ROOT = path.join(dataDir, 'edit_import'); // 剪辑台「导入」上传的素材，按用户分目录
const importDirOf = (uid) => path.join(IMPORT_ROOT, 'u' + Number(uid));

function dirFor(kind) {
  if (kind === 'audio') return TTS_AUDIO_DIR;
  return comfy.outputDir(); // image / video 都在生成输出目录（{id}.png / {id}.mp4）
}
function safeJoin(dir, name) {
  const base = path.basename(String(name || ''));
  const p = path.resolve(dir, base);
  if (!p.startsWith(path.resolve(dir) + path.sep)) return null;
  return p;
}
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
};

// ---------- 我的素材清单 ----------
router.get('/edit/assets', (req, res) => {
  const uid = req.user.id;
  const items = [];
  const push = (kind, filePath, prompt, created_at, src) => {
    const name = path.basename(String(filePath || ''));
    if (!name) return;
    items.push({
      kind, id: src.id, src: src.type, name,
      url: '/api/edit/file/' + kind + '/' + encodeURIComponent(name),
      prompt: String(prompt || '').slice(0, 80), created_at,
    });
  };
  // 三类生成任务的产物（只列本人 + 已完成）：文生图 = 图像；首尾视频 / H3 = 视频
  const q = (sql) => db.prepare(sql).all(uid);
  for (const r of q("SELECT id, prompt, image_path, created_at FROM img_jobs WHERE user_id=? AND status='done' AND image_path!='' ORDER BY id DESC LIMIT 200"))
    push('image', r.image_path, r.prompt, r.created_at, { id: r.id, type: 'zimage' });
  for (const r of q("SELECT id, prompt, video_path, created_at FROM gen_jobs WHERE user_id=? AND status='done' AND video_path!='' ORDER BY id DESC LIMIT 200"))
    push('video', r.video_path, r.prompt, r.created_at, { id: r.id, type: 'i2v' });
  for (const r of q("SELECT id, prompt, video_path, created_at FROM h3_jobs WHERE user_id=? AND status='done' AND video_path!='' ORDER BY id DESC LIMIT 200"))
    push('video', r.video_path, r.prompt, r.created_at, { id: r.id, type: 'h3' });
  // MOSS 配音文件（语音配音页「文字转语音」生成并保存的）
  try {
    for (const r of db.prepare("SELECT id, text, voice_name, file_path, created_at FROM tts_jobs WHERE user_id=? ORDER BY id DESC LIMIT 200").all(uid))
      push('audio', r.file_path, '配音：' + r.text, r.created_at, { id: r.id, type: 'tts' });
  } catch { /* 老库还没 tts_jobs 表（升级未重启完）——空列表即可 */ }
  // 快剪成片（本页合成的视频，回到素材框可继续二剪）
  try {
    for (const r of db.prepare("SELECT id, title, output_path, created_at FROM edit_jobs WHERE user_id=? AND status='done' AND output_path!='' ORDER BY id DESC LIMIT 100").all(uid))
      push('video', r.output_path, (r.title ? '成片：' + r.title : '快剪成片'), r.created_at, { id: r.id, type: 'edit' });
  } catch { /* edit_jobs 表未建（升级未重启完） */ }
  // 导入素材（本页「导入」按钮上传的文件——直接读目录，落盘即生效）
  try {
    const idir = importDirOf(uid);
    if (fs.existsSync(idir)) {
      for (const f of fs.readdirSync(idir).sort().reverse().slice(0, 100)) {
        const full = path.join(idir, f);
        if (!fs.statSync(full).isFile()) continue;
        const ext = path.extname(f).toLowerCase();
        const kind = ({ '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.wav': 'audio', '.mp3': 'audio', '.flac': 'audio', '.ogg': 'audio' })[ext];
        if (kind) push(kind, full, '导入：' + f.replace(/^\d+_/, ''), fs.statSync(full).mtime.toISOString(), { id: f, type: 'import' });
      }
    }
  } catch { /* 目录异常 → 跳过 */ }
  items.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  res.json({ items, counts: {
    image: items.filter((i) => i.kind === 'image').length,
    video: items.filter((i) => i.kind === 'video').length,
    audio: items.filter((i) => i.kind === 'audio').length,
  } });
});

// ---------- 导入素材（本机视频/图片/音频上传进剪辑台素材库） ----------
router.post('/edit/assets/upload', (req, res) => {
  try {
    const { name, data_base64 } = req.body || {};
    const b64 = String(data_base64 || '').replace(/^data:[a-z0-9/+.-]+;base64,/, '');
    if (!b64) return res.status(400).json({ error: '文件内容为空' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: '文件太小，不是有效的媒体文件' });
    if (buf.length > 50 * 1024 * 1024) return res.status(400).json({ error: '文件过大（>50MB），请先压缩再导入（上传走 JSON 通道）' });
    // 魔数识别容器（v1.13.7 的教训：别信扩展名）
    const hex = buf.subarray(0, 16).toString('hex');
    const head = buf.toString('latin1');
    let kind = '';
    if (head.slice(4, 8) === 'ftyp') kind = 'video';                       // mp4 / mov
    else if (hex.startsWith('1a45dfa3')) kind = 'video';                   // webm/mkv (EBML)
    else if (hex.startsWith('89504e47')) kind = 'image';                   // png
    else if (hex.startsWith('ffd8ff')) kind = 'image';                     // jpg
    else if (hex.startsWith('52494646') && head.slice(8, 12) === 'WAVE') kind = 'audio'; // wav
    else if (hex.startsWith('4f676753')) kind = 'audio';                   // ogg
    else if (hex.startsWith('664c6143')) kind = 'audio';                   // flac
    else if (hex.startsWith('494433') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) kind = 'audio'; // mp3
    if (!kind) return res.status(400).json({ error: '不识别的媒体格式（支持 mp4/webm/mov、png/jpg、wav/mp3/flac/ogg）' });
    // 扩展名用识别出的 kind 对应的白名单（防可执行伪装）
    const extOk = { video: ['.mp4', '.webm', '.mov'], image: ['.png', '.jpg', '.jpeg', '.webp'], audio: ['.wav', '.mp3', '.flac', '.ogg'] }[kind];
    const ext = path.extname(String(name || '')).toLowerCase();
    const safeExt = extOk.includes(ext) ? ext : extOk[0];
    const base = path.basename(String(name || 'file')).replace(/\.[^.]*$/, '').replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'media';
    const file = Date.now() + '_' + base + safeExt;
    fs.mkdirSync(importDirOf(req.user.id), { recursive: true });
    fs.writeFileSync(path.join(importDirOf(req.user.id), file), buf);
    res.json({ ok: true, kind, name: file });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 删除素材（素材库） ----------
// 素材来源六类：zimage(文生图)/i2v(首尾视频)/h3(视频生成)/tts(配音)/edit(快剪成片)/import(导入文件)。
// 前五类删数据库记录 + 落盘文件；import 只删本人目录下的文件（无记录）。
router.delete('/edit/assets/:src/:id', (req, res) => {
  const uid = req.user.id;
  const src = String(req.params.src);
  const id = req.params.id;
  try {
    const delFile = (p) => {
      if (!p) return;
      const sp = String(p);
      // 只删自己的盘上产物：dataDir（tts/导入）或输出目录（生成图/视频/成片）
      if (!(sp.startsWith(dataDir) || sp.startsWith(comfy.outputDir()))) return;
      try { fs.unlinkSync(sp); } catch { /* 已删 */ }
    };
    if (src === 'import') {
      const p = safeJoin(importDirOf(uid), id);
      if (!p || !fs.existsSync(p)) return res.status(404).json({ error: '素材不存在' });
      fs.unlinkSync(p);
      return res.json({ ok: true });
    }
    const table = src === 'zimage' ? 'img_jobs' : src === 'i2v' ? 'gen_jobs' : src === 'h3' ? 'h3_jobs'
      : src === 'tts' ? 'tts_jobs' : src === 'edit' ? 'edit_jobs' : null;
    if (!table) return res.status(400).json({ error: '素材来源不合法' });
    const job = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(id));
    if (!job) return res.status(404).json({ error: '素材不存在' });
    if (job.user_id !== uid && req.user.role !== 'admin') return res.status(403).json({ error: '无权删除' });
    delFile(job.image_path); delFile(job.video_path); delFile(job.audio_path); delFile(job.file_path); delFile(job.output_path);
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(Number(id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 素材文件流 ----------
router.get('/edit/file/:kind/:name', (req, res) => {
  const kind = ['image', 'video', 'audio'].includes(req.params.kind) ? req.params.kind : null;
  if (!kind) return res.status(400).json({ error: '素材类型不合法' });
  let p = safeJoin(dirFor(kind), req.params.name);
  if (!p || !fs.existsSync(p)) {
    // 找不到再退到本人导入目录（生成目录同名优先，导入件只在本人目录可读）
    const ip = safeJoin(importDirOf(req.user.id), req.params.name);
    p = ip && fs.existsSync(ip) ? ip : null;
  }
  if (!p) return res.status(404).json({ error: '素材文件不存在' });
  const headers = {};
  if (req.query.dl !== undefined) {
    // RFC 5987：中文文件名用 filename*，老浏览器回退 ASCII
    const ascii = path.basename(p).replace(/[^\x20-\x7e]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`;
  }
  // res.sendFile 自带 HTTP Range/206 与 ETag/304 缓存——视频/音频的流式播放、拖进度、取缩略图帧
  // 都靠 Range 只拉需要的字节。此前 fs.createReadStream 整段吐流，浏览器没法 seek/取帧，
  // 大视频「在线加载慢」的根因即此（#27，2026-11-09）。
  res.sendFile(p, { headers });
});

// ---------- Concat 安装包（服务器托管，内网一键下载） ----------
function concatInstaller() {
  // 扫 res/concat 下的 *-setup.exe，取版本号最大者（以后升级放新包进来即自动生效）
  let best = null;
  try {
    for (const f of fs.readdirSync(CONCAT_DIR)) {
      const m = f.match(/Concat-([\d.]+)-windows-x86_64-setup\.exe$/i);
      if (!m) continue;
      const full = path.join(CONCAT_DIR, f);
      const st = fs.statSync(full);
      const ver = m[1].split('.').map(Number);
      if (!best || cmpVer(ver, best.ver) > 0) best = { ver, file: f, full, size: st.size, mtime: st.mtime };
    }
  } catch { /* 目录不存在 → 未托管 */ }
  return best;
}
function cmpVer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
// SHA256 只算一次并缓存（84MB 每次请求都算太浪费；文件变了按 size+mtime 失效）
const shaCache = new Map();
function sha256File(p, size, mtime) {
  const key = p;
  const hit = shaCache.get(key);
  if (hit && hit.size === size && String(hit.mtime) === String(mtime)) return hit.sha;
  const crypto = require('crypto');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  shaCache.set(key, { size, mtime, sha });
  return sha;
}

router.get('/edit/concat/status', (req, res) => {
  const engine = { installed: concat.installed(), path: concat.findConcat() || '' };
  const it = concatInstaller();
  if (!it) return res.json({ available: false, engine });
  res.json({
    available: true, version: it.ver.join('.'), file: it.file, size: it.size,
    sha256: sha256File(it.full, it.size, it.mtime), engine,
    // GitHub 直链兜底（本机 GitHub 被墙时走 gh-proxy；外网用户视网络情况自选）
    mirrors: [
      'https://github.com/jub0t/Concat/releases/latest',
      'https://concat.standalones.org/#download',
    ],
  });
});

router.get('/edit/concat/download', (req, res) => {
  const it = concatInstaller();
  if (!it) return res.status(404).json({ error: '服务器未托管 Concat 安装包：请管理员将其放入 res/concat/，或到官网 concat.standalones.org 下载' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', it.size);
  res.setHeader('Content-Disposition', `attachment; filename="${it.file}"`);
  fs.createReadStream(it.full).pipe(res);
});

// ---------- 快剪：提交合成任务（网页上选素材 → 服务端驱动 Concat 引擎出片） ----------
router.post('/edit/render', (req, res) => {
  const { title, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '请先在素材框里勾选素材' });
  if (items.length > 50) return res.status(400).json({ error: '单次最多 50 个素材' });
  // 素材必须真实存在且属于本服务器的素材目录（同名即同文件——目录只放生成产物）
  const clean = [];
  for (const it of items) {
    const kind = ['image', 'video', 'audio'].includes(it.kind) ? it.kind : null;
    if (!kind || !concat.resolveAsset(kind, it.name, req.user.id)) return res.status(400).json({ error: '素材不存在：' + (it.name || '?') });
    clean.push({ kind, name: path.basename(String(it.name)) });
  }
  if (!clean.some((i) => i.kind !== 'audio')) return res.status(400).json({ error: '至少选一个图像或视频素材（音频只作配音音轨）' });
  if (!concat.installed()) {
    return res.status(503).json({ error: '服务器未安装 Concat 引擎：请管理员先在本服务器安装上方下载的 Concat（装完无需打开窗口），即可网页直接合成' });
  }
  const info = db.prepare('INSERT INTO edit_jobs(user_id, title, spec) VALUES(?,?,?)')
    .run(req.user.id, String(title || '').slice(0, 100), JSON.stringify({ title: String(title || '').slice(0, 100), items: clean }));
  const id = Number(info.lastInsertRowid);
  concat.enqueueJob(id);
  res.json({ ok: true, id });
});

// 我的合成任务列表
router.get('/edit/jobs', (req, res) => {
  let rows = [];
  try { rows = db.prepare('SELECT id, title, status, error, progress, progress_pct, output_path, duration_ms, created_at FROM edit_jobs WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id); }
  catch (e) { return res.json({ jobs: [] }); }
  res.json({ jobs: rows.map((r) => ({
    ...r,
    output_name: r.output_path ? path.basename(r.output_path) : '',
    output_url: r.output_path && r.status === 'done' ? '/api/edit/file/video/' + encodeURIComponent(path.basename(r.output_path)) : '',
  })) });
});

// 取消进行中的任务
router.post('/edit/render/:id/cancel', (req, res) => {
  const row = db.prepare('SELECT * FROM edit_jobs WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: '无权操作' });
  const okCancel = concat.cancelJob(row.id);
  res.json({ ok: okCancel });
});

// ---------- 剪辑台（studio）：按 Concat 结构的网页剪辑（素材库/预览/检查器/多轨时间线） ----------
// 每用户一个常驻引擎会话（15 分钟空闲自动保存关闭）；命令白名单在 concatService.STUDIO_OPS。
const wrapStudio = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (/未安装 Concat/.test(String(e.message))) return res.status(503).json({ error: e.message });
    res.status(400).json({ error: String(e.message || e) });
  }
};

// 打开/复用剪辑台（resume=true 续接该用户最近保存的工程；items=开场入库的素材）
router.post('/edit/studio/open', wrapStudio(async (req, res) => {
  const { resume } = req.body || {};
  const items = Array.isArray((req.body || {}).items) ? (req.body || {}).items : [];
  const st = await concat.studioOpen(req.user.id, { resume: !!resume, items });
  const state = await concat.studioState(req.user.id);
  res.json({ ok: true, state, projects: concat.studioProjects(req.user.id) });
}));

// 当前状态（timeline + media + canUndo/canRedo + rev）
router.get('/edit/studio/state', wrapStudio(async (req, res) => {
  const state = await concat.studioState(req.user.id);
  if (!state) return res.json({ open: false, projects: concat.studioProjects(req.user.id) });
  res.json({ open: true, state, projects: concat.studioProjects(req.user.id) });
}));

// 执行一条剪辑命令 {op, ...args}（白名单见服务层）
router.post('/edit/studio/command', wrapStudio(async (req, res) => {
  const { op, ...args } = req.body || {};
  if (!op) return res.status(400).json({ error: '缺少 op' });
  const state = await concat.studioCommand(req.user.id, op, args);
  res.json({ ok: true, state });
}));

// 素材入库 {kind, name}
router.post('/edit/studio/import', wrapStudio(async (req, res) => {
  const { kind, name } = req.body || {};
  const state = await concat.studioImport(req.user.id, kind, name);
  res.json({ ok: true, state });
}));

// 撤销/重做 {redo:true}
router.post('/edit/studio/undo', wrapStudio(async (req, res) => {
  const state = await concat.studioUndo(req.user.id, !!(req.body || {}).redo);
  res.json({ ok: true, state });
}));

// 真实帧预览 ?t=秒 → {png: base64}
router.get('/edit/studio/preview', wrapStudio(async (req, res) => {
  const r = await concat.studioPreview(req.user.id, req.query.t);
  res.json(r);
}));

// 效果目录（转场/滤镜/效果/音效/调节）——引擎级清单，进程内缓存
router.get('/edit/studio/effects', wrapStudio(async (req, res) => {
  const list = await concat.effectsList();
  res.json({ effects: list });
}));

// 保存
router.post('/edit/studio/save', wrapStudio(async (req, res) => {
  await concat.studioSave(req.user.id);
  res.json({ ok: true });
}));

// 关闭（保存）
router.post('/edit/studio/close', wrapStudio(async (req, res) => {
  await concat.studioClose(req.user.id);
  res.json({ ok: true });
}));

// 导出 {title} → edit_jobs 一行（进度走 /edit/jobs，成片回素材框）
router.post('/edit/studio/export', wrapStudio(async (req, res) => {
  const id = await concat.studioExport(req.user.id, (req.body || {}).title);
  res.json({ ok: true, id });
}));

module.exports = router;
