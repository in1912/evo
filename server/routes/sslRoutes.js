// HTTPS 自签名证书 路由（设置页「证书」tab）。
const express = require('express');
const ssl = require('../services/sslService');
const { gracefulRestart } = require('../services/restartService');

const router = express.Router();

// 所有证书端点仅管理员
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
// ⚠ 必须带 '/ssl' 前缀：本路由挂载在 /api 下，裸 router.use 会把之后所有 /api 请求
// （generate/image/h3…）在普通用户处全部拦成 403（2026-11-06 报障：普通用户无法使用系统的根因）
router.use('/ssl', requireAdmin);

router.get('/ssl/status', (req, res) => {
  res.json(ssl.status());
});

// 自动生成并落盘
router.post('/ssl/generate', (req, res) => {
  const { cn, org, san, days } = req.body || {};
  try {
    const pair = ssl.generateCert({ cn, org, san, days });
    ssl.writePair(pair.certPem, pair.keyPem);
    res.json({ ok: true, info: { dns: pair.dnsList, ips: pair.ipList, days: pair.days }, status: ssl.status() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 手动上传（JSON 内 PEM 文本）
router.post('/ssl/upload', (req, res) => {
  const { cert, key } = req.body || {};
  const certPem = String(cert || '').trim();
  const keyPem = String(key || '').trim();
  if (!certPem.includes('BEGIN CERTIFICATE') || !keyPem.includes('BEGIN')) {
    return res.status(400).json({ error: '证书或私钥格式不正确（需要 PEM 文本）' });
  }
  try {
    if (!ssl.pubKeyMatch(new (require('crypto').X509Certificate)(certPem), keyPem)) {
      return res.status(400).json({ error: '证书与私钥不配对' });
    }
  } catch (e) {
    return res.status(400).json({ error: '证书解析失败：' + e.message });
  }
  ssl.writePair(certPem + (certPem.endsWith('\n') ? '' : '\n'), keyPem + (keyPem.endsWith('\n') ? '' : '\n'));
  res.json({ ok: true, status: ssl.status() });
});

// 下载当前证书/私钥文件
router.get('/ssl/file/cert', (req, res) => {
  res.download(ssl.CERT_PATH, 'cert.pem');
});
router.get('/ssl/file/key', (req, res) => {
  res.download(ssl.KEY_PATH, 'key.pem');
});

// 替换后重启生效
router.post('/ssl/restart', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => gracefulRestart('HTTPS 证书已更新，重启服务生效'), 300);
});

module.exports = router;
