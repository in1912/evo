// TTS 引擎一键安装（简化版）：本项目随包自带 py312（含全部 Python 依赖），
// 只需下载 MOSS-TTS-Nano 推理仓库到 data/tts；模型（~670MB）由引擎首次合成时经 hf-mirror 自动下载。
// 网络策略：仓库走 GitHub 加速镜像（国内直连不稳），可用 GH_MIRRORS / TTS_REPO_ZIP_URL 覆盖。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, setSetting } = require('../db');
const { extractZip } = require('./zipService');
const { TTS_ROOT, SERVER } = require('./ttsPaths');

const GH_MIRRORS = (process.env.GH_MIRRORS || 'https://ghproxy.net/https://github.com,https://gh-proxy.com/https://github.com')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
function ghUrls(repoPath) {
  return [...GH_MIRRORS.map((m) => `${m}/${repoPath}`), 'https://github.com/' + repoPath];
}
const REPO_ZIP_PATH = 'OpenMOSS/MOSS-TTS-Nano/archive/refs/heads/main.zip';

const state = { running: false, done: false, progress: 0, error: '', startedAt: null, finishedAt: null, log: [] };
function addLog(line) {
  const clean = String(line).split('\r').pop().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 300);
  if (!clean.trim()) return;
  state.log.push(clean);
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}
function status() { return { ...state, log: state.log.slice(-30) }; }

async function download(url, dest, onBytes) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}：${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) throw new Error(`下载内容异常（${buf.length}B）：${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  if (onBytes) onBytes(buf.length, buf.length);
  return buf;
}
async function downloadFirst(urls, dest, onBytes) {
  const errs = [];
  for (const u of urls) {
    try { addLog('下载：' + u); return await download(u, dest, onBytes); }
    catch (e) { errs.push(e.message.slice(0, 80)); addLog('  失败，换下一个源：' + e.message.slice(0, 80)); }
  }
  throw new Error('所有下载源均失败：\n' + errs.slice(-4).join('\n'));
}

async function install(opts = {}) {
  state.running = true; state.done = false; state.error = ''; state.progress = 0; state.log = [];
  state.startedAt = new Date().toISOString(); state.finishedAt = null;
  addLog(`安装目标：${TTS_ROOT}`);
  try {
    for (const d of [TTS_ROOT, path.join(TTS_ROOT, 'voices'), path.join(TTS_ROOT, 'cache'), path.join(TTS_ROOT, 'tmp')]) {
      fs.mkdirSync(d, { recursive: true });
    }
    const repo = path.join(TTS_ROOT, 'MOSS-TTS-Nano');
    if (fs.existsSync(path.join(repo, 'onnx_tts_runtime.py'))) {
      addLog('推理仓库已存在，跳过下载');
    } else {
      const urls = process.env.TTS_REPO_ZIP_URL ? [process.env.TTS_REPO_ZIP_URL] : ghUrls(REPO_ZIP_PATH);
      const buf = await downloadFirst(urls, path.join(TTS_ROOT, 'dl-repo.zip'), (got, total) => {
        state.progress = Math.min(90, Math.round((got / Math.max(1, total)) * 90));
      });
      const entries = extractZip(buf).filter((e) => e.name.startsWith('MOSS-TTS-Nano-main/'));
      if (!entries.length) throw new Error('仓库压缩包内容不符合预期');
      for (const e of entries) {
        const rel = e.name.slice('MOSS-TTS-Nano-main/'.length);
        if (!rel || rel.endsWith('/')) continue;
        const dest = path.join(repo, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.data);
      }
      fs.unlinkSync(path.join(TTS_ROOT, 'dl-repo.zip'));
      if (!fs.existsSync(path.join(repo, 'onnx_tts_runtime.py'))) throw new Error('仓库文件不完整（缺 onnx_tts_runtime.py）');
    }
    fs.copyFileSync(SERVER, path.join(TTS_ROOT, 'moss_server.py'));
    setSetting(db, 'tts_engine_installed', { at: new Date().toISOString(), by: opts.by || '' });
    state.progress = 100; state.done = true; state.finishedAt = new Date().toISOString();
    addLog('安装完成。模型将在首次合成时自动下载（约 670MB）。');
  } catch (e) {
    state.error = e.message; state.finishedAt = new Date().toISOString();
    addLog('安装失败：' + e.message);
  } finally {
    state.running = false;
  }
}

function start(opts = {}) {
  if (state.running) return { ok: true, already: true };
  install(opts).catch((e) => { state.error = e.message; state.running = false; });
  return { ok: true };
}

module.exports = { start, status, install };
