// 系统升级：打包 / 上传 / 应用 / 回滚（零依赖 zip）。升级范围 = 应用代码（server/ + web/dist/ + 入口），
// 不含 data/ 与模型资产。应用后需重启生效（或走 /upgrade/restart 优雅重启）。
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting, dataDir } = require('../db');
const { buildZip, extractZip } = require('../services/zipService');
const { gracefulRestart } = require('../services/restartService');

const router = express.Router();
const APP_ROOT = path.join(__dirname, '..', '..');
const UPGRADES_DIR = path.join(dataDir, 'upgrades');
fs.mkdirSync(UPGRADES_DIR, { recursive: true });

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
// ⚠ 必须带 '/upgrade' 前缀：本路由挂载在 /api 下，裸 router.use 会把之后所有 /api 请求
// 在普通用户处全部拦成 403（同 sslRoutes，2026-11-06 修复）
router.use('/upgrade', requireAdmin);

const CURRENT_VERSION = () => getSetting(db, 'current_version', '1.0.0');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 递归收集目录内文件 → entries。
// skipDirs：要跳过的目录名（如 .v8-cache，Node 字节码缓存非代码）；skipExt：要跳过的文件后缀（如 .js.map）。
function collect(dir, base, out, skipDirs = new Set(), skipExt = null) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      collect(full, base, out, skipDirs, skipExt);
    } else {
      if (skipExt && e.name.endsWith(skipExt)) continue;
      const rel = path.relative(base, full).split(path.sep).join('/');
      out.push({ name: rel, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
    }
  }
}

router.get('/upgrade/status', (req, res) => {
  res.json({ version: CURRENT_VERSION(), upgrades_dir: UPGRADES_DIR });
});

// 打包当前应用代码
router.post('/upgrade/package', (req, res) => {
  const version = String((req.body || {}).version || '').trim();
  if (!/^[\w.\-]{1,32}$/.test(version)) return res.status(400).json({ error: '版本号须为字母数字点横线' });
  const entries = [];
  for (const sub of ['server', 'web']) {
    const dir = path.join(APP_ROOT, sub);
    if (fs.existsSync(dir)) collect(dir, APP_ROOT, entries);
  }
  // 纯 JS 依赖（无原生二进制，跨平台）：生产镜像不含新增依赖时，由升级包带上 node_modules 补齐。
  // ag-psd = 广告图 PSD 组装；pngjs = 图层 PNG 解码；pako/base64-js = ag-psd 的传递依赖
  //   （⚠ 只打包 ag-psd/pngjs 会漏 pako/base64-js → 生产启动 Cannot find module 'pako' 崩溃循环，1.0.26 实踩）。
  // 跳过 .v8-cache 字节码缓存与 .js.map。以后再加纯 JS 依赖，务必连它的传递依赖一起列进这里。
  for (const sub of ['node_modules/ag-psd', 'node_modules/pngjs', 'node_modules/pako', 'node_modules/base64-js']) {
    const dir = path.join(APP_ROOT, sub);
    if (fs.existsSync(dir)) collect(dir, APP_ROOT, entries, new Set(['.v8-cache']), '.js.map');
  }
  for (const f of ['package.json', 'start.bat', 'start.sh']) {
    const p = path.join(APP_ROOT, f);
    if (fs.existsSync(p)) entries.push({ name: f, data: fs.readFileSync(p), mtime: fs.statSync(p).mtime });
  }
  const manifest = { name: 'video-system', version, built_at: new Date().toISOString(), files: entries.map((e) => ({ path: e.name, sha256: sha256(e.data) })) };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  const zip = buildZip(entries);
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = `${ts}_${version}.zip`;
  fs.writeFileSync(path.join(UPGRADES_DIR, file), zip);
  db.prepare('INSERT INTO upgrade_logs(version, action, detail) VALUES(?,?,?)').run(version, 'package', `打包 ${entries.length} 个文件`);
  res.json({ ok: true, file, version, entries: entries.length, size: zip.length });
});

// 升级包列表
router.get('/upgrade/list', (req, res) => {
  const list = fs.readdirSync(UPGRADES_DIR).filter((f) => f.endsWith('.zip')).sort().reverse()
    .map((f) => ({ file: f, size: fs.statSync(path.join(UPGRADES_DIR, f)).size, mtime: fs.statSync(path.join(UPGRADES_DIR, f)).mtime.toISOString() }));
  res.json({ list });
});

// 下载升级包
router.get('/upgrade/download/:file', (req, res) => {
  const file = path.basename(String(req.params.file));
  const p = path.join(UPGRADES_DIR, file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '升级包不存在' });
  res.download(p, file);
});

// 上传升级包（JSON 内 base64）
router.post('/upgrade/upload', (req, res) => {
  const { file, data } = req.body || {};
  const name = path.basename(String(file || '')).replace(/\.zip$/i, '') + '.zip';
  if (!/^[\w.\-]+\.zip$/.test(name)) return res.status(400).json({ error: '文件名非法' });
  const buf = Buffer.from(String(data || ''), 'base64');
  if (buf.length < 32) return res.status(400).json({ error: '数据为空' });
  fs.writeFileSync(path.join(UPGRADES_DIR, name), buf);
  res.json({ ok: true, file: name, size: buf.length });
});

// 应用升级包（备份 → 覆盖 → 记版本）
router.post('/upgrade/apply', (req, res) => {
  const file = path.basename(String((req.body || {}).file || ''));
  const p = path.join(UPGRADES_DIR, file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '升级包不存在' });
  let entries;
  try { entries = extractZip(fs.readFileSync(p)); }
  catch (e) { return res.status(400).json({ error: '升级包解析失败：' + e.message }); }
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  let version = '';
  try { version = manifestEntry ? JSON.parse(manifestEntry.data.toString('utf8')).version : ''; }
  catch { version = ''; }
  if (!version) return res.status(400).json({ error: '升级包缺少 manifest.json / 版本号' });

  // 备份被覆盖的应用代码
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupDir = path.join(UPGRADES_DIR, `backup-${ts}-${version}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const changed = [];
  for (const e of entries) {
    if (e.name === 'manifest.json' || e.name.endsWith('/')) continue;
    const dest = path.join(APP_ROOT, ...e.name.split('/'));
    if (fs.existsSync(dest)) {
      const relBackup = path.join(backupDir, e.name);
      fs.mkdirSync(path.dirname(relBackup), { recursive: true });
      fs.copyFileSync(dest, relBackup);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
    changed.push(e.name);
  }
  setSetting(db, 'current_version', version);
  db.prepare('INSERT INTO upgrade_logs(version, action, detail) VALUES(?,?,?)').run(version, 'apply', `应用 ${changed.length} 个文件，备份 ${backupDir}`);
  res.json({ ok: true, version, changed, backup: backupDir, restart: true });
});

router.post('/upgrade/restart', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => gracefulRestart('升级完成，重启服务'), 300);
});

module.exports = router;
