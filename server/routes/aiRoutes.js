// AI 设置路由（v1.0.19，仅管理员）：接入地址 / API Key / 模型 三件套 + 连通测试。
// 供衍像系统内置 AI 功能调用（aiService.chat），密钥只存本服务器主库。
const express = require('express');
const ai = require('../services/aiService');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可配置 AI 设置' });
  next();
}
router.use('/ai', requireAdmin);

router.get('/ai/config', (req, res) => {
  res.json(ai.getConfig());
});

router.put('/ai/config', (req, res) => {
  const { url, key, model } = req.body || {};
  res.json({ ok: true, config: ai.setConfig({ url, key, model }) });
});

router.post('/ai/test', async (req, res) => {
  // 先落库再测：测试的是「页面上正在编辑的配置」而不是库里的旧值
  const b = req.body || {};
  if (b.url !== undefined || b.key !== undefined || b.model !== undefined) ai.setConfig(b);
  res.json(await ai.test());
});

module.exports = router;
