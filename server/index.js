// 衍像｜EvolveShot 服务入口：认证 / 多租户 / 生成 / 历史 / 语音配音 / 模型配置 / HTTPS / 升级。
// 单端口 HTTP/HTTPS 自适应（首字节 0x16 = TLS 握手 → 走 HTTPS）。
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const express = require('express');

const { db } = require('./db');
const auth = require('./auth');
const ipBan = require('./services/ipBanService');
const ssl = require('./services/sslService');

const APP_ROOT = path.join(__dirname, '..');
const WEB_DIR = path.join(APP_ROOT, 'web');
const PORT = Number(process.env.PORT || 9666);
const SYSTEM_NAME = '衍像｜EvolveShot';
const PKG_VERSION = require(path.join(APP_ROOT, 'package.json')).version; // v1.0.45 提前：静态段就要用（health 同源）

const app = express();
app.disable('x-powered-by');

// ---------- ① IP 封禁（最先，覆盖一切，含静态） ----------
app.use((req, res, next) => {
  const ip = ipBan.clientIp(req);
  if (ipBan.isBanned(ip)) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: '该 IP 已被封禁' });
    return res.status(403).send('403 Forbidden — IP 已被封禁');
  }
  next();
});

// ---------- ② 静态资源（无需登录：登录页 + 前端资源） ----------
// v1.0.45 修复「升级后页面版本弹窗反复弹」：index.html 里 app.js 的 ?v= 不再靠手改（1.0.44
// 部署后仍是 ?v=1.0.43 → 页面守卫比对 health 1.0.44 永远不一致，刷新一次弹一次）。
// 这里改为请求时按 package.json 版本动态注入，并给 index.html 加 no-cache（app.js 本体仍走 ETag）。
const sendIndex = (req, res) => {
  fs.readFile(path.join(WEB_DIR, 'index.html'), 'utf8', (e, html) => {
    if (e) return res.status(500).send('index.html missing');
    res.set('Cache-Control', 'no-cache');
    res.send(html.replace(/app\.js\?v=[0-9.A-Za-z-]*/, 'app.js?v=' + PKG_VERSION));
  });
};
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(WEB_DIR, { index: false, maxAge: 0 }));

// ---------- ③ JSON 解析（base64 图像/音频较大） ----------
app.use(express.json({ limit: '80mb' }));

// ---------- ③b 公开系统信息（无需登录） ----------
app.get('/api/health', (req, res) => res.json({ ok: true, name: SYSTEM_NAME, version: PKG_VERSION }));
app.get('/api/system', (req, res) => res.json({ name: SYSTEM_NAME, version: PKG_VERSION }));
app.use('/api', require('./routes/systemRoutes').publicRouter); // GPU 采样公开（算力端实例间中继用）

// ---------- ④ 认证与页级授权（仅 /api） ----------
function extractToken(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.query && req.query.token) return String(req.query.token);
  return '';
}
function isExempt(req) {
  const p = req.path;
  if (p === '/auth/login' && req.method === 'POST') return true;
  if (p === '/auth/register' && req.method === 'POST') return true;
  if (p.startsWith('/tts/ref-audio')) return true;
  if (/^\/ha\/hook\/[\w.-]+$/.test(p)) return true; // HA 自动化 webhook 反调（key 即凭证，处理里不碰 req.user）
  return false;
}
app.use('/api', (req, res, next) => {
  if (isExempt(req)) return next();
  const token = extractToken(req);
  const user = token ? auth.resolveUser(token) : null;
  if (!user) return res.status(401).json({ error: '未登录' });
  const page = auth.pageForPath(req.path);
  if (!auth.canAccess(user, page)) return res.status(403).json({ error: '无权访问该功能' });
  req.user = user;
  req.token = token;
  req.tdb = db; // 本项目无独立租户库，兼容 tts 路由签名
  next();
});

// ---------- ⑤ 业务路由 ----------
// 三个生成模块要留引用：启动收养（v1.0.13）通过 router.resume 恢复上次中断的任务
const generateRoutes = require('./routes/generateRoutes');
const imageRoutes = require('./routes/imageRoutes');
const h3Routes = require('./routes/h3Routes');
app.use('/api', require('./routes/authRoutes'));
app.use('/api', require('./routes/sslRoutes'));
app.use('/api', require('./routes/upgradeRoutes'));
app.use('/api', require('./routes/modelRoutes'));
app.use('/api', generateRoutes);
app.use('/api', imageRoutes);
app.use('/api', h3Routes);
app.use('/api', require('./routes/historyRoutes'));
app.use('/api', require('./routes/ttsRoutes'));
app.use('/api', require('./routes/aiRoutes'));     // AI 设置（v1.0.19，系统内置 AI 功能的接入配置）
app.use('/api', require('./routes/editRoutes'));   // 视频剪辑（v1.0.19，素材清单 + Concat 安装包托管）
app.use('/api', require('./routes/haRoutes'));      // HomeAssistant（v1.0.11，自工作台移植）
app.use('/api', require('./routes/taskRoutes'));   // 任务中心（v1.0.11）
app.use('/api', require('./routes/systemRoutes').authedRouter);

// ---------- ⑦ SPA 兜底 ----------
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  sendIndex(req, res); // v1.0.45：深链兜底同样注入当前版本号
});

// ---------- 启动 ----------
auth.initAdmin();
setInterval(auth.cleanupSessions, 60 * 60 * 1000).unref();
auth.cleanupSessions();

// 启动清账（v1.0.13 升级为「收养」）：串行任务队列是内存态，上次进程退出（升级/重启/崩溃）时
// 还在 running/pending 的任务，其轮询协程已随之消亡。v1.0.13 起提交算力端成功即落库
// prompt_id + comfy_base —— 有这两个字段的任务重启后由各模块 resume() 重新收养：
// 已完成→直接取回产物落库；排队/执行中→继续轮询跟踪；算力端已无此任务→置失败。
// 没有登记信息的老任务维持原行为：直接置为失败，避免「生成中」永久卡住。
const resumeMods = { gen_jobs: generateRoutes, img_jobs: imageRoutes, h3_jobs: h3Routes };
for (const [t, mod] of Object.entries(resumeMods)) {
  try {
    const rows = db.prepare("SELECT * FROM " + t + " WHERE status IN ('running','pending')").all();
    if (!rows.length) continue;
    let adopted = 0, failed = 0;
    for (const row of rows) {
      if (row.prompt_id && row.comfy_base && mod.resume) {
        adopted++;
        mod.resume(row).catch(() => {});
      } else {
        failed++;
        db.prepare("UPDATE " + t + " SET status='failed', error='服务重启，任务中断', progress_pct=100 WHERE id=?").run(row.id);
      }
    }
    console.log(`[boot] ${t}: 收养恢复 ${adopted} 个、置失败 ${failed} 个（上次中断任务）`);
  } catch (e) { console.warn(`[boot] ${t} 清账失败:`, e.message); }
}

// 模型目录自愈（v1.0.16）：系统文件夹整体迁移/改名后，E 盘 ComfyUI 的 extra_model_paths.yaml
// 仍指旧位置（umt5 not in list / Lora 缺文件的根因）→ 启动时自动改写为当前所在目录；
// 若 ComfyUI 正带着旧模型路径在跑且队列空闲，顺带自动重启它。详见 comfyService.selfHealBackend。
require('./services/comfyService').selfHealBackend().catch(() => {});

// 快剪任务收养（v1.0.19）：引擎会话随进程消亡，running 置失败（素材都在可重提），pending 重新入队
require('./services/concatService').adoptOnBoot();

function startServer() {
  const certExists = fs.existsSync(ssl.CERT_PATH) && fs.existsSync(ssl.KEY_PATH);
  // 优雅重启的接替进程要等父进程释放端口；单发定时在 Windows 上会撞 EADDRINUSE（父进程
  // 800ms 才退、端口释放更晚），改为首次延迟 600ms + 失败后每 400ms 重试，最多 40 次。
  const firstDelay = process.env.WB_GRACEFUL_RESTART === '1' ? 600 : 0;
  const attempt = (n) => {
    setTimeout(() => {
      const srv = listenOnce(certExists);
      srv.on('error', (e) => {
        if (e.code === 'EADDRINUSE' && n < 40) {
          console.log(`[listen] 端口 ${PORT} 暂被占用，重试（${n + 1}/40）…`);
          attempt(n + 1);
        } else {
          console.error(`[listen] 监听 ${PORT} 失败：`, e.message);
          process.exit(1);
        }
      });
    }, n === 0 ? firstDelay : 400);
  };
  attempt(0);
}

function listenOnce(certExists) {
  if (certExists) {
    const httpsServer = https.createServer({
      cert: fs.readFileSync(ssl.CERT_PATH),
      key: fs.readFileSync(ssl.KEY_PATH),
    }, app);
    const httpServer = http.createServer(app);
    const tls = net.createServer((socket) => {
      socket.once('data', (buf) => {
        const target = buf[0] === 0x16 ? httpsServer : httpServer; // 0x16 = TLS ClientHello
        socket.unshift(buf);
        target.emit('connection', socket);
      });
    });
    tls.listen(PORT, () => console.log(`[${SYSTEM_NAME}] 监听 ${PORT}（HTTP/HTTPS 自适应，证书已启用）`));
    return tls;
  }
  const httpSrv = http.createServer(app);
  httpSrv.listen(PORT, () => console.log(`[${SYSTEM_NAME}] 监听 ${PORT}（HTTP）`));
  return httpSrv;
}

startServer();

// 启动后后台拉起 ComfyUI（已在跑则复用 health，避免 Node 重启后「模型离线」）
const comfy = require('./services/comfyService');
setTimeout(() => {
  comfy.ensureComfy()
    .then(() => console.log('[comfy] 本机模型已就绪'))
    .catch((e) => console.warn('[comfy] 本机模型启动失败:', e.message));
}, 1500);
