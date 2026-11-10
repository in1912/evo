// TTS 引擎路径统一解析（ttsService 与 ttsInstaller 共用）。
// 本项目随包自带 py312（含 onnxruntime/torch/fastapi 等全部依赖），无需 Miniconda；
// 只需把 MOSS-TTS-Nano 推理仓库装进 data/tts（安装器下载，或预先放好），模型首次合成时由引擎自动下载。
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../db');

const APP_ROOT = path.join(__dirname, '..', '..');
const DATA_TTS = path.join(dataDir, 'tts');
const PROJECT_TTS = path.join(__dirname, '..', 'tts');

function detectRoot() {
  if (process.env.TTS_ROOT) return process.env.TTS_ROOT;
  return DATA_TTS; // 仓库/音色/缓存统一落持久 data 目录
}

const TTS_ROOT = detectRoot();

// 解释器：优先随包 py312（已含全部依赖），其次才考虑独立 venv
function findPython(root) {
  return [
    path.join(APP_ROOT, 'py312', 'python.exe'),
    path.join('py', 'python.exe'),
    path.join('py', 'bin', 'python'),
    path.join('.venv', 'Scripts', 'python.exe'),
    path.join('.venv', 'bin', 'python'),
  ].map((p) => (path.isAbsolute(p) ? p : path.join(root, p)))
    .find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || '';
}

module.exports = {
  DATA_TTS,
  PROJECT_TTS,
  TTS_ROOT,
  PY: findPython(TTS_ROOT),
  SERVER: path.join(__dirname, '..', 'tts', 'moss_server.py'),
  REPO: path.join(TTS_ROOT, 'MOSS-TTS-Nano'),
  VOICES_DIR: path.join(TTS_ROOT, 'voices'),
  CACHE_DIR: path.join(TTS_ROOT, 'cache'),
  findPython,
};
