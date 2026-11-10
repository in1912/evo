// 语音合成 / 音色库 / 语音克隆（MOSS-TTS-Nano 本地离线引擎）路由。
// 克隆：上传参考音频（10~30 秒）即成为新音色，随后可给生成的视频配音。
const express = require('express');
const fs = require('fs');
const path = require('path');
const tts = require('../services/ttsService');
const installer = require('../services/ttsInstaller');
const comfy = require('../services/comfyService');
const { db, setSetting, dataDir } = require('../db');

const router = express.Router();

// TTS 后端配置（本地 / 内网远端）
router.get('/tts/config', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json({ mode: tts.getMode(), url: tts.getUrl() });
});
router.put('/tts/config', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const { mode, url } = req.body || {};
  tts.setBackend(mode, url);
  res.json({ ok: true, mode: tts.getMode(), url: tts.getUrl() });
});

// 「按算力端配置」：TTS 引擎改为监听 0.0.0.0（局域网可达），供远端设备调用
router.post('/tts/compute-node', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  setSetting('tts_listen', '0.0.0.0');
  res.json({ ok: true, lanIp: comfy.lanIp(), listen: '0.0.0.0', port: 9640 });
});

// 引擎与音色状态
router.get('/tts/status', async (req, res) => {
  res.json(await tts.status());
});

// 引擎一键安装（管理员）
router.get('/tts/engine/status', (req, res) => {
  res.json({ ...installer.status(), installed: tts.installed() });
});
router.post('/tts/engine/install', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可安装引擎' });
  res.json(installer.start({ by: req.user.username, restart: false }));
});

// 预热（首次会触发模型下载）
router.post('/tts/engine/warmup', async (req, res) => {
  if (tts.getMode() !== 'remote' && !tts.installed()) return res.status(400).json({ error: 'TTS 引擎未安装：请先一键安装' });
  try { await tts.ensureServer(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 音色列表 + 当前默认音色
router.get('/tts/voices', (req, res) => {
  res.json({ voices: tts.listVoices(), default_voice_id: tts.defaultVoiceId(db) });
});

// 参考音频试听
router.get('/tts/ref-audio/:id', (req, res) => {
  const v = tts.getVoice(req.params.id);
  if (!v || !fs.existsSync(v.file_path)) return res.status(404).json({ error: '参考音频不存在' });
  const head = fs.readFileSync(v.file_path).subarray(0, 12).toString('latin1');
  const mime = head.startsWith('fLaC') ? 'audio/flac'
    : head.startsWith('OggS') ? 'audio/ogg'
    : head.startsWith('RIFF') ? 'audio/wav'
    : (head.charCodeAt(0) === 0xff && (head.charCodeAt(1) & 0xe0) === 0xe0) || head.startsWith('ID3') ? 'audio/mpeg' : 'audio/wav';
  res.setHeader('Content-Type', mime);
  fs.createReadStream(v.file_path).pipe(res);
});

// 合成：POST {text, voice_id?} → audio/wav
router.post('/tts/synthesize', async (req, res) => {
  try {
    const { text, voice_id } = req.body || {};
    const file = await tts.synthesize(voice_id || tts.defaultVoiceId(db), text);
    res.setHeader('Content-Type', 'audio/wav');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 文字转语音（v1.0.19）：合成 + 保存为我的配音文件（可播放/下载，进剪辑素材框） ----------
const TTS_AUDIO_DIR = path.join(dataDir, 'tts_audio');
router.post('/tts/speak', async (req, res) => {
  try {
    const { text, voice_id } = req.body || {};
    const vid = Number(voice_id) || tts.defaultVoiceId(db);
    const voice = tts.getVoice(vid) || tts.getVoice(tts.defaultVoiceId(db));
    if (!voice) return res.status(400).json({ error: '音色库为空：请先上传参考音频创建音色' });
    const src = await tts.synthesize(vid, text); // 缓存命中/新合成都返回磁盘路径
    fs.mkdirSync(TTS_AUDIO_DIR, { recursive: true });
    const file = path.join(TTS_AUDIO_DIR, `evo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`);
    fs.copyFileSync(src, file);
    const info = db.prepare(
      'INSERT INTO tts_jobs(user_id, text, voice_id, voice_name, file_path) VALUES(?,?,?,?,?)'
    ).run(req.user.id, String(text || '').slice(0, 2000), voice.id, voice.name, file);
    res.json({ ok: true, id: Number(info.lastInsertRowid), url: '/api/tts/file/' + Number(info.lastInsertRowid), voice_name: voice.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 我的配音文件列表
router.get('/tts/files', (req, res) => {
  let rows = [];
  try { rows = db.prepare('SELECT id, text, voice_id, voice_name, file_path, created_at FROM tts_jobs WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id); }
  catch (e) { return res.json({ files: [] }); }
  res.json({ files: rows.map((r) => ({ id: r.id, text: r.text, voice_name: r.voice_name, created_at: r.created_at, url: '/api/tts/file/' + r.id })) });
});

// 配音文件流（wav；<audio>/下载共用）
router.get('/tts/file/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tts_jobs WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '配音文件不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: '无权访问' });
  if (!row.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ error: '文件已丢失' });
  res.sendFile(row.file_path); // sendFile 自带 Range/206 + ETag 缓存（<audio> 拖进度条要 Range）
});

// 删除配音文件（本人或管理员）
router.delete('/tts/file/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tts_jobs WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '配音文件不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: '无权删除' });
  if (row.file_path && row.file_path.startsWith(dataDir)) { try { fs.unlinkSync(row.file_path); } catch { /* 已删 */ } }
  db.prepare('DELETE FROM tts_jobs WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// 上传参考音频 = 语音克隆（新音色）
router.post('/tts/manage/upload', async (req, res) => {
  try {
    const { name, data_base64 } = req.body || {};
    const b64 = String(data_base64 || '').replace(/^data:audio\/[a-z]+;base64,/, '');
    if (!b64) return res.status(400).json({ error: '音频数据为空' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1000) return res.status(400).json({ error: '音频太短，参考录音建议 10~30 秒' });
    if (buf.length > 20 * 1024 * 1024) return res.status(400).json({ error: '音频过大（>20MB）' });
    const magic = buf.toString('latin1');
    const isAudio = magic.startsWith('RIFF') || magic.startsWith('fLaC') || magic.startsWith('OggS')
      || magic.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    if (!isAudio) return res.status(400).json({ error: '不识别的音频格式（支持 wav/flac/ogg/mp3）' });
    fs.mkdirSync(tts.VOICES_DIR, { recursive: true });
    const file = path.join(tts.VOICES_DIR, `v${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
    fs.writeFileSync(file, buf);
    const id = tts.addVoice(name, file, req.user.id);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tts/manage/voice/:id', (req, res) => {
  try { tts.removeVoice(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/tts/manage/default', (req, res) => {
  try { tts.setDefaultVoice(db, (req.body || {}).voice_id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
