// ComfyUI 编排层：拉起 ComfyUI 子进程（127.0.0.1:8189），把图生视频工作流 JSON 注入
// 用户图像 / 提示词 / 种子 / 分辨率 / 模型文件名，经 HTTP API 提交并轮询结果。
// 工作流 = work/complete-i2v.json（Wan2.2 I2V A14b lightx2v 4 步 + NSFW lora + GIMM-VFI 帧插值）。
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, getSetting, setSetting, dataDir } = require('../db');
const { PNG } = require('pngjs');            // 纯 JS PNG 解码（图层 PNG → RGBA）
const { writePsdBuffer } = require('ag-psd'); // 纯 JS PSD 组装（Photoshop 打开即分层）

const APP_ROOT = path.join(__dirname, '..', '..');
const COMFY_DIR = process.env.COMFYUI_DIR || path.join(APP_ROOT, 'ComfyUI');
const PYTHON = process.env.VIDEO_PYTHON || path.join(APP_ROOT, 'py312', 'python.exe');
// ComfyUI 子进程解释器：2026-11-06 起 8189 = E 盘便携版（python_embeded），与超分用的 py312 分开
const COMFY_PYTHON = process.env.COMFYUI_PYTHON || PYTHON;
// GIMM-VFI softsplat 经 cupy/NVRTC JIT 需要 CUDA 头：E 盘自带 cuda-home（自 py312 Library 拷贝），不依赖 G 盘
const CUDA_HOME_DIR = process.env.CUDA_HOME_DIR || path.join(path.dirname(path.dirname(COMFY_PYTHON)), 'cuda-home');
const FFMPEG_DIR = path.join(APP_ROOT, 'py312', 'ffmpeg', 'bin');
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || path.join(APP_ROOT, 'work', 'complete-i2v.json');
const PORT = Number(process.env.COMFYUI_PORT || 8189);
const BASE = `http://127.0.0.1:${PORT}`;
const UPLOAD_DIR = path.join(dataDir, 'uploads');
const WORKFLOW_FLF = process.env.WORKFLOW_FLF || path.join(APP_ROOT, 'work', 'Wan2.2_lightx2v_fflv.json');
const WORKFLOW_ZIMAGE = path.join(APP_ROOT, 'work', 'z-image.json');
// H3 独立后端（本系统 8189 无 MiniMax-H3 核心支持，H3 必须走 8188 便携版或局域网地址）
const H3_PORT = Number(process.env.H3_COMFYUI_PORT || 8188);
// 2026-11-06 起 H3 与 Z-image/WAN2.2 统一走 8189（E 盘 0.34 核心已补齐 MiniMax-H3 与 Z-Image 支持）
const H3_DEFAULT_URL = (process.env.H3_COMFY_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

// ---------- ComfyUI WebSocket 实时进度（真实采样步进，替代停在 50% 的假进度，2026-11-06） ----------
// 每个后端一条 /ws?clientId=X 长连（Node≥21 全局 WebSocket），收 progress 事件
// （prompt_id + value/max = 当前节点的真实采样步进）。各生成流程提交 prompt 时带同一
// clientId，轮询期间从这里取真实步进喂 onProgress（进度条=真实百分比，文字=步进数）；
// WS 不可达时自动退回原状态文本进度，不阻塞生成。
const progMonitors = new Map(); // base → {clientId, prog:Map<promptId,{value,max,pct,ts}>, ws}
// 正在 ComfyUI 上跑的生成任务登记表：promptId → { kind, jobId, base, ts, cancelled }。
// 任务中心「停止」用：先 GET /queue 确认这个 prompt 确实是排队/执行中的那个，才允许
// /queue delete 或 /interrupt —— 8189 是共享 GPU，绝不误伤同一后端上别人的任务。
const activeRuns = new Map();
function checkCancelled(promptId) {
  const r = activeRuns.get(promptId);
  if (r && r.cancelled) { activeRuns.delete(promptId); throw new Error('任务已被用户停止'); }
}

function progressMonitor(base) {
  let m = progMonitors.get(base);
  if (m) return m;
  m = { clientId: 'evo_' + Math.random().toString(36).slice(2, 10), prog: new Map(), exec: new Map(), stages: new Map(), ws: null };
  const connect = () => {
    try { m.ws = new WebSocket(base.replace(/^http/i, 'ws') + '/ws?clientId=' + m.clientId); }
    catch { m.ws = null; setTimeout(connect, 10000); return; }
    m.ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // 二进制预览帧不用
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const d = msg && msg.data;
      if (msg.type === 'progress' && d && d.prompt_id) {
        const max = Number(d.max) || 0, value = Number(d.value) || 0;
        // v1.0.13：pct 改为「整条工作流」口径且单调不回退。此前是单节点 0-100：
        // 采样节点跑完 99% 后切到帧插值节点（max=3）会掉回 33%，看起来像假进度（2026-11-06 报障）。
        // 做法：按「发过进度事件的节点」首次出现顺序编号（节点归属来自最近一次 executing），
        // pct = (已完成阶段数 + 当前阶段 value/max) / 已见阶段数（分母多留 1，避免最后阶段顶满），
        // 再叠加高水位（st.high）保证绝不回退。封顶 99：工作流真正结束由 status.completed 决定。
        const nodeKey = String((m.exec.get(d.prompt_id) || {}).node || '');
        const st = m.stages.get(d.prompt_id) || { seen: [], cur: -1, high: 0 };
        let si = st.seen.indexOf(nodeKey);
        if (si < 0) { st.seen.push(nodeKey); si = st.seen.length - 1; }
        st.cur = Math.max(st.cur, si);
        const frac = max > 0 ? Math.min(1, value / max) : 0;
        let pct = Math.round(((st.cur + frac) / Math.max(st.seen.length, st.cur + 2)) * 100);
        st.high = pct = Math.max(st.high, Math.min(99, pct));
        m.stages.set(d.prompt_id, st);
        m.prog.set(d.prompt_id, { value, max, pct, ts: Date.now() });
        if (m.prog.size > 300) { // 防膨胀：删掉最旧一半
          const olds = [...m.prog.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 150).map((e) => e[0]);
          for (const k of olds) { m.prog.delete(k); m.stages.delete(k); }
        }
      }
      // 节点级进度：H3 等自定义采样节点不发数字步进，但每进入一个新节点会广播一次
      // executing（data.node = 节点 id）—— 用它做真实的阶段文字进度
      if (msg.type === 'executing' && d && d.prompt_id) {
        if (d.node) m.exec.set(d.prompt_id, { node: String(d.node), ts: Date.now() });
        else { m.exec.delete(d.prompt_id); m.stages.delete(d.prompt_id); } // node=null：该 prompt 执行完毕
      }
    };
    m.ws.onclose = () => { m.ws = null; setTimeout(connect, 5000); };
    m.ws.onerror = () => { try { m.ws && m.ws.close(); } catch {} };
  };
  connect();
  progMonitors.set(base, m);
  return m;
}
// 某任务当前的真实步进（无 WS 数据或已 60s 未更新则返回 null，调用方退回状态文本）
// 常见节点的中文阶段名（executing 事件只给节点 id，转成可读文字）
const NODE_STAGE_ZH = {
  KSampler: '扩散采样', KSamplerAdvanced: '扩散采样', 'KSampler (Advanced)': '扩散采样',
  VAEDecode: 'VAE 解码', VAEEncode: 'VAE 编码', LoadImage: '加载输入图', CLIPTextEncode: '文本编码',
  SaveImage: '保存图像', SaveAnimatedWEBP: '保存图像', SaveAnimatedPNG: '保存图像',
  UNETLoader: '加载扩散模型', UnetLoaderGGUF: '加载扩散模型（GGUF）', CLIPLoader: '加载文本编码器',
  DualCLIPLoader: '加载文本编码器', VAELoader: '加载 VAE', LoraLoader: '加载 LoRA',
  ImageScale: '图像缩放', EmptyLatentImage: '准备潜空间', LoadImageMask: '加载遮罩',
};
function stageTextOf(wf) {
  return (n) => {
    const node = (wf && wf[String(n)]) || {};
    const t = (node._meta && node._meta.title) || NODE_STAGE_ZH[node.class_type] || node.class_type || ('节点 ' + n);
    return '阶段：' + t;
  };
}
// 某任务当前的真实步进；无数字步进时退回当前执行节点的阶段文字（H3 一个节点可跑
// 数分钟无新事件，而 executing 只在节点开始时发一次，所以 exec 新鲜度放宽到 15 分钟——
// 条目还在就说明该节点仍在算，文字依然真实）
function liveStep(mon, promptId, nodeLabel) {
  const p = mon && mon.prog.get(promptId);
  if (p && Date.now() - p.ts <= 60000) return { text: `采样步进 ${p.value}/${p.max}`, pct: p.pct };
  const x = mon && mon.exec.get(promptId);
  if (x && x.node && Date.now() - x.ts <= 15 * 60 * 1000 && typeof nodeLabel === 'function') {
    return { text: nodeLabel(x.node), pct: null }; // 该节点未提供数字步进：只给真实阶段文字
  }
  return null;
}
// 该 prompt 是否还在 ComfyUI 待执行队列（生产/开发共用统一后端时，排在别的任务后面
// 是常态——此时显示「排队中」而不是误导性的「采样中 50%」）
async function queueState(base, promptId) {
  try {
    const qr = await fetch(base + '/queue', { signal: AbortSignal.timeout(4000) });
    const q = await qr.json();
    return {
      pending: (q.queue_pending || []).some((e) => e[1] === promptId),
      running: (q.queue_running || []).some((e) => e[1] === promptId),
    };
  } catch { return null; }
}
// 三流程共用的轮询进度：WS 实时步进 > 节点阶段文字 > 排队/GPU 忙 > ComfyUI 状态文本
async function pollProgress(mon, promptId, base, wf, prog, fallbackPct, lastStatus) {
  const live = liveStep(mon, promptId, stageTextOf(wf));
  if (live) return prog('生成中：' + live.text, live.pct != null ? live.pct : fallbackPct);
  if (!(mon.prog.has(promptId) || mon.exec.has(promptId))) { // 尚未收到任何事件：多半在排队
    const qs = await queueState(base, promptId);
    if (qs && qs.pending) return prog('排队中：等待 GPU 空闲（统一后端正被其他任务占用）', 15);
    if (qs && qs.running) return prog('生成中：GPU 计算中', fallbackPct);
  }
  if (lastStatus) prog('生成中：' + lastStatus, fallbackPct);
}
const H3_COMFY_DIR = process.env.H3_COMFY_DIR || APP_ROOT; // v1.0.17 起 python_embeded 随系统目录（闭环迁移，不再依赖 E 盘）
const H3_PYTHON = process.env.H3_PYTHON || path.join(H3_COMFY_DIR, 'python_embeded', 'python.exe');
const LORA_DIR = path.join(COMFY_DIR, 'models', 'loras');
const RES_DIR = path.join(APP_ROOT, 'res');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 输出目录：可在「模型配置」页修改（settings.output_dir），默认 data/output
function outputDir() {
  const d = String(getSetting('output_dir') || '').trim() || path.join(dataDir, 'output');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 默认负面提示词（中文 + 英文，与原系统一致；UI 留空时回退到此）
const DEFAULT_NEGATIVE = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走, censored, mosaic censoring, bar censor, pixelated, glowing, bloom, blurry, day, out of focus, low detail, bad anatomy, ugly, overexposed, underexposed, distorted face, extra limbs, cartoonish, 3d render artifacts, duplicate people, unnatural lighting, bad composition, missing shadows, low resolution, poorly textured, glitch, noise, grain, static, motionless, still frame, overall grayish, worst quality, low quality, JPEG compression artifacts, subtitles, stylized, artwork, painting, illustration, cluttered background, many people in background, three legs, walking backward, zoom out, zoom in, mouth speaking, moving mouth, talking, speaking, mute speaking, unnatural skin tone, discolored eyelid, red eyelids, red upper eyelids, no red eyeshadow, closed eyes, no wide-open innocent eyes, poorly drawn hands, extra fingers, fused fingers, poorly drawn face, deformed, disfigured, malformed limbs, thighs, fog, mist, voluminous eyelashes, blush';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ComfyUI 的 status.messages 形如 [[type, data], ...]，data 可能是字符串或
// {exception_type, exception_message, ...}。这里转成可读文本，避免显示成 [object Object]。
function readableError(messages) {
  const parts = [];
  for (const m of messages || []) {
    const data = Array.isArray(m) ? m[1] : m;
    if (data == null) continue;
    if (typeof data === 'string') { parts.push(data); continue; }
    if (typeof data === 'object') {
      const txt = data.exception_message || data.message || data.exception_type || data.error;
      parts.push(txt ? String(txt) : JSON.stringify(data));
      continue;
    }
    parts.push(String(data));
  }
  return parts.filter(Boolean).join('; ');
}

let child = null;
let bootPromise = null;

// ---------- 后端模式（按工作流区分）：i2v(首尾视频/WAN2.2)、zimage(文生图)、h3(视频生成) ----------
// local = 本机拉起 ComfyUI 子进程（i2v/zimage 共享 8189）；remote = 调用内网远端 ComfyUI。
// h3 固定走独立后端（8188 便携版或局域网地址）：本系统 8189 缺 nodes_minimax_h3.py 跑不了 H3。
function getMode(kind) {
  const key = kind === 'zimage' ? 'zimage_mode' : kind === 'h3' ? 'h3_mode' : 'comfy_mode';
  const env = kind === 'zimage' ? 'ZIMAGE_MODE' : kind === 'h3' ? 'H3_MODE' : 'COMFY_MODE';
  return getSetting(key) || process.env[env] || (kind === 'h3' ? 'remote' : 'local');
}
function getUrl(kind) {
  const key = kind === 'zimage' ? 'zimage_url' : kind === 'h3' ? 'h3_url' : 'comfy_url';
  const env = kind === 'zimage' ? 'ZIMAGE_URL' : kind === 'h3' ? 'H3_URL' : 'COMFY_URL';
  return getSetting(key) || process.env[env] || (kind === 'h3' ? H3_DEFAULT_URL : '');
}
function setBackend(kind, mode, url) {
  // 向后兼容旧签名 setBackend(mode, url)（首参不是 i2v/zimage/h3 时按旧调用的 mode 解析）。
  // ⚠ kind 必须显式含 'i2v'：否则路由传入的 'i2v' 会被当旧 mode 压成 local（2026-11-06 生产实踩）
  if (typeof kind !== 'string' || (kind !== 'i2v' && kind !== 'zimage' && kind !== 'h3')) { url = mode; mode = kind; kind = 'i2v'; }
  const mk = kind === 'zimage' ? 'zimage_mode' : kind === 'h3' ? 'h3_mode' : 'comfy_mode';
  const uk = kind === 'zimage' ? 'zimage_url' : kind === 'h3' ? 'h3_url' : 'comfy_url';
  const m = mode === 'remote' ? 'remote' : 'local';
  setSetting(mk, m);
  setSetting(uk, m === 'remote' ? String(url || '').trim().replace(/\/+$/, '') : '');
}
function baseUrl(kind) {
  if (kind === 'h3') return getUrl('h3') || H3_DEFAULT_URL;
  if (getMode(kind) === 'remote' && getUrl(kind)) return getUrl(kind);
  return BASE;
}

// ---------- 算力端（本机作为 GPU 服务器，监听 0.0.0.0 供局域网设备连接） ----------
function lanIp() {
  const nets = os.networkInterfaces();
  const pick = (re) => {
    for (const addrs of Object.values(nets)) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && re.test(a.address)) return a.address;
    return null;
  };
  // 优先 192.168.*（最常见局域网），再 10.*，最后 172.16-31.*（常是 Docker/WSL 虚拟网卡）
  return pick(/^192\.168\./) || pick(/^10\./) || pick(/^172\.(1[6-9]|2\d|3[01])\./) || '127.0.0.1';
}

// ComfyUI 监听地址：算力端模式下用 0.0.0.0（局域网可达），否则 127.0.0.1
function getListenAddr() {
  return getSetting('comfy_listen') === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
}

// 「按算力端配置」：本机改为算力端（监听 0.0.0.0），并生成 start-model.bat。
// 用户定版的两个启动脚本（2026-11-07）：start-model.bat＝局域网服务器模式（后台静默：
//   ComfyUI 8189 + 无界面 9666 中继实例，喂远端浮窗四曲线 + 自愈看护）；start.bat＝本机
//   完整操作模式（9666 + 浏览器 + 按需拉起算力）。没有第三个启动脚本。
// v1.0.17 起 ComfyUI 本体 + python_embeded + cuda-home 全部随系统目录（闭环），bat 一律
// %~dp0 自定位——整个文件夹挪走依旧有效；端口已在跑的子进程自动跳过（重复双击无害）。
function configureComputeNode() {
  setSetting('comfy_listen', '0.0.0.0');
  const ip = lanIp();
  const bat = [
    '@echo off',
    'rem EvolveShot LAN-server launcher (generated by "Model config -> compute node")',
    'rem Server mode: unified ComfyUI backend 0.0.0.0:8189 (WAN2.2 i2v + Z-Image + MiniMax-H3)',
    'rem               + headless web instance :9666 (feeds remote GPU widget, self-heal caretaker).',
    'rem For local interactive use run start.bat instead. No third launcher.',
    'rem Runs entirely from THIS folder (ComfyUI + python_embeded + cuda-home) - move-safe.',
    'rem Already-running children are skipped: double-clicking again is harmless.',
    '',
    'setlocal',
    'cd /d %~dp0',
    '',
    'set "PYTHONHOME="',
    'set "PYTHONPATH="',
    'set "HF_ENDPOINT=https://hf-mirror.com"',
    'set "CUDA_HOME=%~dp0cuda-home"',
    'set "CUDA_PATH=%~dp0cuda-home"',
    'set "PATH=%~dp0cuda-home\\bin;%PATH%"',
    'set "PORT=9666"',
    'set "DATA_DIR=%~dp0data"',
    'set "COMFYUI_DIR=%~dp0ComfyUI"',
    'set "COMFYUI_PYTHON=%~dp0python_embeded\\python.exe"',
    'set "VIDEO_PYTHON=%~dp0py312\\python.exe"',
    'set "WORKFLOW_FILE=%~dp0work\\complete-i2v.json"',
    '',
    `netstat -ano | findstr /C:":${PORT} " | findstr LISTENING >nul || start "EvolveShot-ComfyUI-${PORT}" /min cmd /c "cd /d %~dp0ComfyUI && %~dp0python_embeded\\python.exe -s main.py --port ${PORT} --listen 0.0.0.0 --fast --disable-auto-launch --lowvram --reserve-vram 1.0"`,
    'netstat -ano | findstr /C:":9666 " | findstr LISTENING >nul || start "EvolveShot-Server-9666" /min cmd /c "node server\\index.js >> Logs\\relay.log 2>&1"',
    '',
    'endlocal',
    'exit /b 0',
    '',
  ].join('\r\n');
  const batPath = path.join(APP_ROOT, 'start-model.bat');
  fs.writeFileSync(batPath, bat, 'utf8');
  return { lanIp: ip, listen: '0.0.0.0', batPath, unifiedPort: PORT };
}

// ---------- 默认模型配置（首次运行时播种；均可改） ----------
// group：i2v=首尾视频(WAN2.2)、zimage=文生图(Z-image)、h3=视频生成(MiniMax-H3)，用于「模型配置」3 个 tab 拆分
const DEFAULT_MODELS = [
  { key: 'unet_high_noise', name: '主 UNet（高噪声）GGUF', kind: 'unet', path: 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_1030-Q4_K_M.gguf', grp: 'i2v' },
  { key: 'unet_low_noise', name: '副 UNet（低噪声）GGUF', kind: 'unet', path: 'wan2.2_i2v_A14b_low_noise_lightx2v_4step-Q4_K_M.gguf', grp: 'i2v' },
  { key: 'clip', name: '文本编码器（umt5）', kind: 'text_encoder', path: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', grp: 'i2v' },
  { key: 'vae', name: 'VAE 解码器', kind: 'vae', path: 'Wan2.1_VAE.safetensors', grp: 'i2v' },
  { key: 'clip_vision', name: 'CLIP 视觉', kind: 'clip_vision', path: 'clip_vision_h.safetensors', grp: 'i2v' },
  { key: 'lora_lightx2v', name: 'LightX2V 蒸馏 LoRA', kind: 'lora', path: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors', grp: 'i2v' },
  { key: 'lora_nsfw', name: 'NSFW LoRA', kind: 'lora', path: 'NSFW-22-H-e8.safetensors', grp: 'i2v' },
  { key: 'gimm_vfi', name: 'GIMM-VFI 帧插值模型', kind: 'interpolation', path: 'gimmvfi_r_arb_lpips_fp32.safetensors', grp: 'i2v' },
  // Z-image（文生图）：Lumina2 CLIP + Flux AE + Z-Image Turbo UNet，跑在本机 8189（已验证 lumina2/AuraFlow 支持）
  { key: 'zimage_clip', name: 'Z-Image CLIP 文本编码器', kind: 'text_encoder', path: 'qwen_3_4b.safetensors', grp: 'zimage' },
  { key: 'zimage_vae', name: 'Z-Image VAE（Flux AE）', kind: 'vae', path: 'ae.safetensors', grp: 'zimage' },
  { key: 'zimage_unet', name: 'Z-Image UNet（turbo）', kind: 'diffusion_model', path: 'z_image_turbo_bf16.safetensors', grp: 'zimage' },
  // MiniMax-H3（视频生成）：GGUF 主模型 + qwen3vl 编码器 + 视频/音频双 VAE，跑在 8188 便携版
  { key: 'h3_model', name: 'MiniMax-H3 主模型 (GGUF)', kind: 'diffusion_model', path: 'MiniMax-H3-fl2va-curve-Q4_0.gguf', grp: 'h3' },
  { key: 'h3_clip', name: 'H3 文本编码器', kind: 'text_encoder', path: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', grp: 'h3' },
  { key: 'h3_video_vae', name: 'H3 视频 VAE', kind: 'vae', path: 'minimax_h3_video_vae_fp16.safetensors', grp: 'h3' },
  { key: 'h3_audio_vae', name: 'H3 音频 VAE', kind: 'vae', path: 'minimax_h3_audio_vae_fp32.safetensors', grp: 'h3' },
  // Qwen-Image-Layered（广告图/PSD 分层图）：独立三件套，节点为 8189(0.34) 内置核心节点，无需装
  { key: 'qil_unet', name: 'QIL 扩散模型（Qwen-Image-Layered）', kind: 'diffusion_model', path: 'qwen_image_layered_fp8mixed.safetensors', grp: 'qil' },
  { key: 'qil_clip', name: 'QIL 文本编码器（Qwen2.5-VL）', kind: 'text_encoder', path: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', grp: 'qil' },
  { key: 'qil_vae', name: 'QIL VAE（分层 RGBA）', kind: 'vae', path: 'qwen_image_layered_vae.safetensors', grp: 'qil' },
];

function seedModels() {
  const have = db.prepare('SELECT key FROM model_configs').all().map((r) => r.key);
  const ins = db.prepare('INSERT INTO model_configs(key,name,path,kind,enabled,grp) VALUES(?,?,?,?,1,?)');
  for (const m of DEFAULT_MODELS) {
    if (!have.includes(m.key)) ins.run(m.key, m.name, m.path, m.kind, m.grp || 'i2v');
  }
}

// 模型文件名映射：key → path（可被模型配置页改）；传 group 时只取该组
function modelMap(group) {
  seedModels();
  const out = {};
  const rows = group
    ? db.prepare('SELECT key, path, enabled FROM model_configs WHERE grp=?').all(group)
    : db.prepare('SELECT key, path, enabled FROM model_configs').all();
  for (const r of rows) {
    if (r.enabled) out[r.key] = r.path;
  }
  return out;
}

// ---------- ComfyUI 后端健康检查（本地或远端） ----------
function health() {
  return fetch(baseUrl() + '/system_stats', { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

// 校验端口上的 ComfyUI 是本系统的（工作流依赖的自定义节点必须存在）。
// 否则就是别的项目/默认 ComfyUI 占了端口，直接报清楚而不是把任务提交过去报「node not found」。
async function hasRequiredNode() {
  try {
    const r = await fetch(baseUrl() + '/object_info/PathchSageAttentionKJ', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && Object.keys(j).length);
  } catch { return false; }
}

async function ensureComfy() {
  if (await health()) {
    if (!(await hasRequiredNode())) {
      throw new Error(`端口 ${PORT} 上运行的不是本系统的 ComfyUI（缺少自定义节点，可能是其它项目占用了该端口）。请停止占用 ${PORT} 的进程，或用环境变量 COMFYUI_PORT 换一个端口。`);
    }
    return true;
  }
  if (getMode() === 'remote') throw new Error('远端 ComfyUI 不可达：' + (getUrl() || '(未配置地址)'));
  if (!fs.existsSync(path.join(COMFY_DIR, 'main.py'))) throw new Error('未找到 ComfyUI：' + COMFY_DIR);
  if (!fs.existsSync(COMFY_PYTHON)) throw new Error('未找到 ComfyUI 解释器：' + COMFY_PYTHON);
  const embedded = COMFY_PYTHON !== PYTHON; // E 盘 python_embeded 自带环境，别把 py312 的 PATH/环境塞给它
  if (!bootPromise) {
    bootPromise = (async () => {
      fs.mkdirSync(path.join(APP_ROOT, 'Logs'), { recursive: true });
      const logFd = fs.openSync(path.join(APP_ROOT, 'Logs', 'comfyui.log'), 'a');
      const pyRoot = path.join(APP_ROOT, 'py312');
      const env = embedded ? {
        ...process.env,
        PYTHONHOME: '',
        PYTHONPATH: '',
        PYTHONIOENCODING: 'utf-8', // stdio 重定向到日志文件时 Python 走 GBK，自定义节点启动横幅的
        PYTHONUTF8: '1',           // emoji 会 UnicodeEncodeError 炸掉整个 main.py（2026-11-07 实踩）
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        CUDA_HOME: CUDA_HOME_DIR, // GIMM-VFI softsplat JIT 需要 CUDA 头（NVRTC）
        CUDA_PATH: CUDA_HOME_DIR, // cupy 按 CUDA_PATH 找 nvrtc64_120_0.dll
        PATH: `${CUDA_HOME_DIR}\\bin;${process.env.PATH || ''}`, // NVRTC 运行库 nvrtc64_120_0.dll 等
      } : {
        ...process.env,
        PYTHONHOME: '',
        PYTHONPATH: '',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        TORCH_HOME: path.join(APP_ROOT, 'cache'),
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        HF_HOME: process.env.HF_HOME || path.join(APP_ROOT, 'hf_download'),
        CU_PATH: path.join(pyRoot, 'Lib', 'site-packages', 'torch', 'lib'),
        cuda_PATH: path.join(pyRoot, 'Library'),
        CUDA_HOME: path.join(pyRoot, 'Library'),
        PATH: `${pyRoot};${path.join(pyRoot, 'Scripts')};${path.join(pyRoot, 'Library', 'bin')};${FFMPEG_DIR};${process.env.PATH || ''}`,
      };
      syncModelPaths(); // 拉起前自愈（服务常驻期间发生目录迁移、ComfyUI 恰好没在跑的场景）
      child = spawn(COMFY_PYTHON, ['-s', 'main.py', '--port', String(PORT), '--listen', getListenAddr(), '--fast', '--disable-auto-launch', '--lowvram', '--reserve-vram', '1.0'], {
        cwd: COMFY_DIR, stdio: ['ignore', logFd, logFd], env, detached: true,
      });
      child.unref(); // 让 ComfyUI 独立于 Node 进程存活，Node 重启时不再被连带杀死
      child.on('exit', () => { child = null; bootPromise = null; });
      for (let i = 0; i < 240; i++) {           // 冷启动加载模型可能较久
        if (await health()) {
          if (await hasRequiredNode()) return true;
          throw new Error('ComfyUI 已启动但缺少自定义节点（PathchSageAttentionKJ 未注册，custom_nodes 导入失败），详见 Logs/comfyui.log');
        }
        if (!child) throw new Error('ComfyUI 进程退出，详见 Logs/comfyui.log');
        await sleep(1000);
      }
      throw new Error('ComfyUI 启动超时（240s），详见 Logs/comfyui.log');
    })().finally(() => { bootPromise = null; });
  }
  return bootPromise;
}

// ---------- 模型目录自愈（v1.0.16，2026-11-07）：系统文件夹整体迁移后零手工修复 ----------
// 断链原理：E 盘 ComfyUI 的 extra_model_paths.yaml 以绝对路径引用本系统目录下的
// ComfyUI/models（16 类）。系统文件夹整体挪走/改名后 yaml 仍指旧位置 → ComfyUI 枚举
// 不到模型（首尾视频报 clip_name not in list、Lora 下拉缺文件——2026-11-07 实踩：
// G:\wuxian\video → G:\video 迁移后 umt5/lightx2v 同时消失，同一个断链两个症状）。
// 本系统目录内的启动脚本都用 %~dp0 自定位、代码零硬编码盘符，唯一断点就是这个 yaml。
// syncModelPaths()：把 yaml 里所有「已不存在的 盘符:/…/ComfyUI/models」前缀改写为当前
// 应用根下的 ComfyUI/models。只改失效引用（旧位置还在磁盘上的不动，允许人为指到别处）；
// 本机没有随包模型目录或没有 yaml 时直接跳过（Docker 生产实例即如此，幂等无副作用）。
function syncModelPaths() {
  try {
    const yamlPath = path.join(COMFY_DIR, 'extra_model_paths.yaml');
    if (!fs.existsSync(yamlPath)) return { changed: false };
    const modelsDir = path.join(APP_ROOT, 'ComfyUI', 'models');
    if (!fs.existsSync(modelsDir)) return { changed: false };
    const base = modelsDir.replace(/\\/g, '/');
    const txt = fs.readFileSync(yamlPath, 'utf8');
    const out = txt.replace(/[A-Za-z]:\/[^#\r\n]*?\/ComfyUI\/models/g, (m) => {
      try { if (fs.existsSync(m)) return m; } catch {}
      return base; // 旧位置已不存在 → 指向当前所在位置
    });
    if (out === txt) return { changed: false };
    fs.writeFileSync(yamlPath, out);
    console.log(`[self-heal] extra_model_paths.yaml 已改写 → ${base}（检测到系统目录迁移，自动修复模型引用）`);
    return { changed: true };
  } catch (e) { console.warn('[self-heal] 模型路径自愈失败:', e.message); return { changed: false }; }
}

// 杀掉占用某端口的所有监听进程（自愈重启旧 ComfyUI 实例用；跳过自己）
function killPortListeners(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (m && Number(m[1]) === port && Number(m[2]) !== process.pid) pids.add(m[2]);
    }
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {} }
    return pids.size;
  } catch { return 0; }
}

// selfHealBackend()（服务启动时调用）：①改写 yaml；②ComfyUI 没在跑且本机 local 模式 →
// 拉起它（算力端中继要 24h 供曲线采样）；③在跑但模型列表仍是旧路径的（folder_paths 只在
// 启动时载入，改 yaml 不热生效——含上次自愈被中断的情况）且队列空闲 → 重启它。
// 队列有任务时绝不杀（共享 GPU 上可能有别的客户端的活），只告警等下次机会。
async function selfHealBackend() {
  syncModelPaths();
  try {
    const probe = (p) => fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!(await probe('/system_stats'))) {
      // 可能只是同批启动的 ComfyUI 还在加载（start-model.bat 同时拉起两个子进程，ComfyUI
      // 冷启动 15-30s）——给足耐心再判定「没在跑」，避免抢着二次拉起打端口架。
      for (let i = 0; i < 15; i++) {
        await sleep(3000);
        if (await probe('/system_stats')) return;
      }
      // ComfyUI 确实没在跑：yaml 已修好；本机 local 模式时负责拉起（stdio 重定向已带 UTF-8，见 ensureComfy）
      if (getMode() === 'local' && fs.existsSync(path.join(COMFY_DIR, 'main.py'))) {
        console.log('[self-heal] ComfyUI 未在运行（本机 local 模式）→ 自动拉起');
        await ensureComfy();
        console.log('[self-heal] ComfyUI 已拉起');
      }
      return;
    }
    // 参照物：随包 lora 目录里的任一 safetensors。正在跑的实例若不认识它，说明它载入的是旧路径
    let marker = null;
    try { marker = (fs.readdirSync(path.join(APP_ROOT, 'ComfyUI', 'models', 'loras')).find((f) => f.endsWith('.safetensors'))) || null; } catch {}
    if (!marker) return;
    const loras = await probe('/models/loras');
    if (Array.isArray(loras) && loras.includes(marker)) return; // 实例模型列表没断链，不用动
    const q = await probe('/queue');
    const busy = q && ((q.queue_running || []).length + (q.queue_pending || []).length) > 0;
    if (busy) {
      console.warn('[self-heal] ComfyUI 仍载入着旧模型路径，但队列有任务在跑，本次不重启（空闲后重启本服务生效）');
      return;
    }
    console.log(`[self-heal] ComfyUI 带旧模型路径在跑且队列空闲（缺 ${marker}），自动重启…`);
    killPortListeners(PORT);
    await sleep(2000); // 等端口彻底释放
    await ensureComfy(); // 用完整环境（CUDA 三件套 + UTF-8 stdio + 0.0.0.0 监听）重新拉起
    console.log('[self-heal] ComfyUI 已按新模型路径重启');
  } catch (e) { console.warn('[self-heal] 后端自愈未完成（不影响启动）:', e.message); }
}

// ---------- 工作流注入与生成 ----------
function loadWorkflow(file) {
  const raw = fs.readFileSync(file || WORKFLOW_FILE, 'utf8');
  return JSON.parse(raw);
}

function setNode(wf, id, inputs) {
  if (!wf[id]) throw new Error(`工作流缺少节点 ${id}`);
  Object.assign(wf[id].inputs, inputs);
}

// 归一化子目录：ComfyUI 在 Windows 上把 subfolder 写成 `video\H3_DANCE`（反斜杠），
// 而 /view 端点跨平台只认正斜杠——Linux 后端收到反斜杠会把 `\H3_DANCE` 当文件名一部分，
// 导致「取回视频失败：HTTP 404」（视频明明在 output 里）。统一转成正斜杠。
function normSub(s) { return String(s || '').replace(/\\/g, '/'); }

// 从 ComfyUI history 结果里找出视频文件（不区分本地/远端，供 H3 等独立后端使用）
function extractVideoRaw(history) {
  const found = [];
  for (const pid of Object.values(history)) {
    for (const nodeOut of Object.values(pid.outputs || {})) {
      const candidates = [];
      if (Array.isArray(nodeOut.gifs)) candidates.push(...nodeOut.gifs);
      if (Array.isArray(nodeOut.videos)) candidates.push(...nodeOut.videos);
      if (Array.isArray(nodeOut.images)) candidates.push(...nodeOut.images);
      // ComfyUI 0.34 的 SaveVideo 把视频放在 images 键（filename 为 .mp4）；个别版本用 animated 数组
      if (Array.isArray(nodeOut.animated)) candidates.push(...nodeOut.animated);
      for (const c of candidates) {
        const name = String(c.filename || c.name || '');
        if (/\.(mp4|webm|mkv|mov|avi|gif)$/i.test(name)) found.push({ ...c, filename: name, subfolder: normSub(c.subfolder) });
      }
    }
  }
  return found.length ? found[found.length - 1] : null;
}

// 从 history 找出最终静态图（SaveImage 输出在 images 键下）
function extractImage(history) {
  for (const pid of Object.values(history)) {
    for (const nodeOut of Object.values(pid.outputs || {})) {
      if (Array.isArray(nodeOut.images)) {
        for (const c of nodeOut.images) {
          const name = String(c.filename || c.name || '');
          if (/\.(png|jpg|jpeg|webp)$/i.test(name)) return { ...c, filename: name };
        }
      }
    }
  }
  return null;
}

// 从 history 找出某一 SaveImage 节点（按 filename 前缀区分）输出的整批静态图。
// ComfyUI 按 batch 顺序命名 _00001_/_00002_…，返回数组顺序即图层顺序（第 1 层 → 第 N 层）。
function extractImages(history, prefix) {
  const out = [];
  for (const pid of Object.values(history)) {
    for (const nodeOut of Object.values(pid.outputs || {})) {
      if (!Array.isArray(nodeOut.images)) continue;
      for (const c of nodeOut.images) {
        const name = String(c.filename || c.name || '');
        if (prefix && !name.startsWith(prefix)) continue;
        if (/\.(png|jpg|jpeg|webp)$/i.test(name)) out.push({ ...c, filename: name, subfolder: normSub(c.subfolder) });
      }
    }
  }
  return out;
}

// 从 ComfyUI history 结果里找出最终视频文件（VHS_VideoCombine 输出在 gifs/videos 键下）
function extractVideo(history) {
  const found = extractVideoRaw(history);
  if (!found) return null;
  // 本地模式：优先取磁盘上真实存在的视频（跳过 save_output=False 的中间产物，如 lightx2v_*.mp4）
  if (getMode() !== 'remote') {
    for (const pid of Object.values(history)) {
      for (const nodeOut of Object.values(pid.outputs || {})) {
        const candidates = [];
        if (Array.isArray(nodeOut.gifs)) candidates.push(...nodeOut.gifs);
        if (Array.isArray(nodeOut.videos)) candidates.push(...nodeOut.videos);
        for (const c of candidates) {
          const name = String(c.filename || c.name || '');
          if (/\.(mp4|webm|mkv|mov|avi|gif)$/i.test(name) && fs.existsSync(path.join(COMFY_DIR, 'output', c.subfolder || '', name))) return { ...c, filename: name };
        }
      }
    }
  }
  return found;
}

// 放置输入图：本地 = 复制到 ComfyUI/input；远端 = 上传到远端 ComfyUI 的 /upload/image
async function placeInput(imagePath, inputName) {
  if (getMode() === 'remote') {
    const buf = fs.readFileSync(imagePath);
    const mime = 'image/' + (inputName.split('.').pop() || 'png');
    const form = new FormData();
    form.append('image', new Blob([buf], { type: mime }), inputName);
    form.append('overwrite', 'true');
    const r = await fetch(baseUrl() + '/upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('上传图像到远端 ComfyUI 失败：' + (j.error || ('HTTP ' + r.status)));
    return;
  }
  const inputDest = path.join(COMFY_DIR, 'input', inputName);
  fs.mkdirSync(path.dirname(inputDest), { recursive: true });
  fs.copyFileSync(imagePath, inputDest);
}

// 取回最终视频：本地 = 从 ComfyUI/output 复制；远端 = 经 /view 下载
async function fetchOutput(out, dstVideo) {
  if (getMode() === 'remote') {
    const q = new URLSearchParams({ filename: out.filename, subfolder: normSub(out.subfolder), type: out.type || 'output' });
    const r = await fetch(baseUrl() + '/view?' + q.toString(), { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('下载远端视频失败 HTTP ' + r.status);
    fs.writeFileSync(dstVideo, Buffer.from(await r.arrayBuffer()));
    return;
  }
  const srcVideo = path.join(COMFY_DIR, 'output', out.subfolder || '', out.filename);
  if (!fs.existsSync(srcVideo)) throw new Error('生成完成但未找到输出视频：' + out.filename);
  fs.copyFileSync(srcVideo, dstVideo);
}

// 通用：放置输入图（comfyDir 为空 = 远端上传；非空 = 复制到该 ComfyUI 的 input 目录）
async function placeInputTo(imagePath, inputName, base, comfyDir) {
  if (!comfyDir) {
    const buf = fs.readFileSync(imagePath);
    const mime = 'image/' + (inputName.split('.').pop() || 'png');
    const form = new FormData();
    form.append('image', new Blob([buf], { type: mime }), inputName);
    form.append('overwrite', 'true');
    const r = await fetch(base + '/upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('上传图像到远端 ComfyUI 失败：' + (j.error || ('HTTP ' + r.status)));
    return;
  }
  const inputDest = path.join(comfyDir, 'input', inputName);
  fs.mkdirSync(path.dirname(inputDest), { recursive: true });
  fs.copyFileSync(imagePath, inputDest);
}

// 通用：取回输出（comfyDir 为空 = 经 /view 下载；非空 = 从该 ComfyUI 的 output 目录复制）
async function fetchOutputTo(out, dst, base, comfyDir) {
  if (!comfyDir) {
    const q = new URLSearchParams({ filename: out.filename, subfolder: normSub(out.subfolder), type: out.type || 'output' });
    const r = await fetch(base + '/view?' + q.toString(), { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error('下载远端输出失败 HTTP ' + r.status);
    fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
    return;
  }
  const src = path.join(comfyDir, 'output', out.subfolder || '', out.filename);
  if (!fs.existsSync(src)) throw new Error('生成完成但未找到输出：' + out.filename);
  fs.copyFileSync(src, dst);
}

// LoRA 列表（供 Lora_1..4 下拉选择）：优先问 i2v 后端 ComfyUI 的 HTTP 接口
// （NAS 容器/远端模式下没有本地 ComfyUI 目录，也能拿到真实列表），失败退回扫描本机目录。
async function listLoras() {
  try {
    const arr = await fetch(baseUrl('i2v') + '/models/loras', { signal: AbortSignal.timeout(2500) })
      .then((r) => (r.ok ? r.json() : null));
    if (Array.isArray(arr) && arr.length) {
      const names = arr.map(String).filter((n) => n && n !== 'None');
      return ['None', ...names];
    }
  } catch { /* 后端没起来 → 走本地目录 */ }
  const out = ['None'];
  try {
    if (fs.existsSync(LORA_DIR)) {
      for (const f of fs.readdirSync(LORA_DIR)) {
        if (/\.(safetensors|ckpt|pt|pth|bin)$/i.test(f)) out.push(f);
      }
    }
  } catch { /* 目录不存在则返回空 */ }
  return out;
}

// 高清修复：RealESRGAN（原系统 res/inference_realesrgan_video.py），outscale = 视频放大倍数（2/3/4）
async function runHighResFix(videoPath, outscale) {
  const script = path.join(RES_DIR, 'inference_realesrgan_video.py');
  if (!fs.existsSync(script)) throw new Error('高清修复脚本缺失：' + script);
  if (!fs.existsSync(PYTHON)) throw new Error('未找到 Python 解释器：' + PYTHON);
  const scale = Math.max(2, Math.min(4, Math.floor(Number(outscale) || 4)));
  const outdir = path.join(outputDir(), 'hires');
  fs.mkdirSync(outdir, { recursive: true });
  const pyRoot = path.join(APP_ROOT, 'py312');
  const env = {
    ...process.env,
    PYTHONHOME: '',
    PYTHONPATH: '',
    PATH: `${pyRoot};${path.join(pyRoot, 'Scripts')};${path.join(pyRoot, 'Library', 'bin')};${FFMPEG_DIR};${process.env.PATH || ''}`,
  };
  await new Promise((resolve, reject) => {
    const p = spawn(PYTHON, ['-s', script, '-n', 'RealESRGAN_x4plus', '-s', String(scale), '-i', videoPath, '-o', outdir], { env });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('高清修复失败（exit ' + code + '）：' + err.slice(-300)))));
  });
  const base = path.basename(videoPath).replace(/\.mp4$/i, '');
  const outFile = path.join(outdir, `${base}_out.mp4`);
  if (!fs.existsSync(outFile)) throw new Error('高清修复完成但未找到输出：' + outFile);
  return outFile;
}

async function generate({ imagePath, endImagePath, prompt, negativePrompt, seed, length, width, height, fps, steps, interpolation, dub, mode, sageAttention, highRes, highResScale, loras }, onProgress, taskRef) {
  const stagePct = (s) => {
    const t = String(s || '');
    if (/完成/.test(t)) return 100;
    if (/配音/.test(t)) return 95;
    if (/高清/.test(t)) return 90;
    if (/取回/.test(t)) return 85;
    if (/提交/.test(t)) return 22;
    if (/上传/.test(t)) return 14;
    if (/加载/.test(t)) return 5;
    return 50; // 生成中（采样/解码/帧插值），ComfyUI 不提供精确百分比
  };
  const prog = (s, pct) => { if (typeof onProgress === 'function') onProgress(s, pct != null ? pct : stagePct(s)); };
  await ensureComfy();
  const isFlf = mode === 'flf';
  prog('加载工作流…');
  const wf = loadWorkflow(isFlf ? WORKFLOW_FLF : WORKFLOW_FILE);
  const models = modelMap();

  // 输入图：本地模式复制到 ComfyUI input 目录；远端模式经 /upload/image 上传
  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ext = (path.extname(imagePath).toLowerCase() || '.png').replace('.', '');
  const inputName = `vid_${jobId}.${ext || 'png'}`;
  prog('上传首帧图像…');
  await placeInput(imagePath, inputName);
  let endInputName = '';
  if (isFlf) {
    if (!endImagePath) throw new Error('首尾帧模式需要上传尾帧图像');
    const eext = (path.extname(endImagePath).toLowerCase() || '.png').replace('.', '');
    endInputName = `vid_${jobId}_end.${eext || 'png'}`;
    prog('上传尾帧图像…');
    await placeInput(endImagePath, endInputName);
  }

  const pos = String(prompt || '').trim();
  if (!pos) throw new Error('提示词不能为空');

  const L = Math.max(1, Math.min(30, Math.floor(Number(length) || 5)));
  const W = Math.max(256, Math.min(1280, Math.floor(Number(width) || 368)));
  const H = Math.max(256, Math.min(1280, Math.floor(Number(height) || 704)));
  const interp = Math.max(1, Math.min(4, Math.floor(Number(interpolation) || 2)));
  const FPS = Math.max(1, Math.min(60, Math.floor(Number(fps) || 16)));
  const STEPS = Math.max(1, Math.min(50, Math.floor(Number(steps) || 4)));
  // sage-attn：开关映射到 PathchSageAttentionKJ 的合法枚举（开启=auto 自动加速，关闭=disabled）
  const sage = sageAttention === 'disabled' ? 'disabled' : 'auto';

  // 单图 / 首尾帧两套工作流的节点 ID 映射
  const N = isFlf ? {
    loadStart: '224', loadEnd: '243', pos: '227', neg: '220', sampler: '236',
    lenInt: '316', wInt: '314', hInt: '315', resMaster: '283', gi: null, math: '317',
    vhsBase: '237', vhsFinal: null,
  } : {
    loadStart: '206', loadEnd: null, pos: '367', neg: '164', sampler: '165',
    lenInt: '310', wInt: '311', hInt: '312', resMaster: '270', gi: '203', math: '313',
    vhsBase: '166', vhsFinal: '205',
  };

  setNode(wf, N.loadStart, { image: inputName });
  if (N.loadEnd) setNode(wf, N.loadEnd, { image: endInputName });
  setNode(wf, N.pos, { text: pos });
  setNode(wf, N.neg, { text: String(negativePrompt || '').trim() || DEFAULT_NEGATIVE });
  // 种子：默认 -1 = 随机（与原系统一致）；负数一律按随机处理
  const seedNum = (seed === undefined || seed === null || seed === '' || Number(seed) < 0) ? Math.floor(Math.random() * 1e15) : Number(seed);
  setNode(wf, N.sampler, { seed: seedNum, steps: STEPS });
  setNode(wf, N.lenInt, { value: L });
  // SimpleMath+ 公式：总帧数 = 时长(秒) × 基础帧率 + 1（原导出写死 "5*16+1"，这里随 fps 生效）
  setNode(wf, N.math, { value: `a*${FPS}+1` });
  setNode(wf, N.wInt, { value: W });
  setNode(wf, N.hInt, { value: H });
  setNode(wf, N.resMaster, { width: W, height: H });
  // 视频帧率：基础帧率 fps（中间 VHS 节点）；最终输出 = fps × 插值倍数（有 GIMM-VFI 时）
  setNode(wf, N.vhsBase, { frame_rate: FPS });
  if (N.vhsFinal) setNode(wf, N.vhsFinal, { frame_rate: FPS * interp });
  // 帧插值（首尾帧工作流不含 GIMM-VFI 节点）
  if (N.gi) setNode(wf, N.gi, { interpolation_factor: interp, seed: Math.floor(Math.random() * 1e15) });

  // sage-attn（两套工作流的 154/159 节点均存在）
  setNode(wf, '154', { sage_attention: sage });
  setNode(wf, '159', { sage_attention: sage });

  // 模型文件名（均来自模型配置）
  setNode(wf, '370', { unet_name: models.unet_high_noise || DEFAULT_MODELS[0].path });
  setNode(wf, '371', { unet_name: models.unet_low_noise || DEFAULT_MODELS[1].path });
  setNode(wf, '176', { clip_name: models.clip || DEFAULT_MODELS[2].path });
  setNode(wf, '177', { vae_name: models.vae || DEFAULT_MODELS[3].path });
  setNode(wf, '280', { clip_name: models.clip_vision || DEFAULT_MODELS[4].path });
  if (N.gi) setNode(wf, '204', { model: models.gimm_vfi || DEFAULT_MODELS[7].path });

  // Lora 堆栈（Lora_1..4 + 权重；默认 Lora_1=加速蒸馏、Lora_2=NSFW，其余 None）
  const defLoras = [
    { name: models.lora_lightx2v || DEFAULT_MODELS[5].path, strength: 1 },
    { name: models.lora_nsfw || DEFAULT_MODELS[6].path, strength: 1 },
    { name: 'None', strength: 1 },
    { name: 'None', strength: 1 },
  ];
  const loraArr = Array.isArray(loras) && loras.length ? loras : defLoras;
  const loraInputs = { lora_01: 'None', strength_01: 1, lora_02: 'None', strength_02: 1, lora_03: 'None', strength_03: 1, lora_04: 'None', strength_04: 1 };
  for (let i = 0; i < 4; i++) {
    const s = loraArr[i] || { name: 'None', strength: 1 };
    const name = String(s.name || '').trim() || 'None';
    const strength = Number(s.strength);
    loraInputs[`lora_0${i + 1}`] = name;
    loraInputs[`strength_0${i + 1}`] = Number.isFinite(strength) ? strength : 1;
  }
  setNode(wf, '368', loraInputs);

  // 提交
  prog('提交 ComfyUI…');
  const mon = progressMonitor(baseUrl());
  const pr = await fetch(baseUrl() + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: mon.clientId }),
    signal: AbortSignal.timeout(30000),
  });
  const pj = await pr.json();
  if (!pr.ok || !pj.prompt_id) {
    throw new Error('ComfyUI 提交失败：' + JSON.stringify(pj).slice(0, 300));
  }
  const promptId = pj.prompt_id;
  try { taskRef && taskRef.onSubmitted && taskRef.onSubmitted(promptId, baseUrl(), wf); } catch { /* 登记失败不影响生成 */ }

  // 轮询历史（视频生成较久，上限 30 分钟）；进度条优先用 WS 真实采样步进。
  // activeRuns 登记 + checkCancelled：任务中心「停止」能立刻打断轮询（dequeue 后不再空转到超时）
  prog('生成中（采样/解码/帧插值）…');
  activeRuns.set(promptId, { kind: (taskRef && taskRef.kind) || 'i2v', jobId: String((taskRef && taskRef.jobId) || jobId), base: baseUrl(), ts: Date.now(), cancelled: false });
  const deadline = Date.now() + 30 * 60 * 1000;
  let out = null;
  let lastStatus = '';
  try {
    while (Date.now() < deadline) {
      checkCancelled(promptId);
      const hr = await fetch(baseUrl() + `/history/${promptId}`, { signal: AbortSignal.timeout(5000) });
      const hist = await hr.json();
      const entry = hist[promptId];
      if (entry && entry.status) {
        lastStatus = entry.status.status_str || lastStatus;
        if (entry.status.completed) { out = extractVideo(hist); break; }
        if (entry.status.status_str === 'error') {
          const msgs = readableError(entry.status.messages);
          throw new Error('生成失败：' + (msgs.slice(0, 300) || '未知错误'));
        }
      }
      await pollProgress(mon, promptId, baseUrl(), wf, prog, undefined, lastStatus);
      await sleep(2000);
    }
  } finally { activeRuns.delete(promptId); }
  if (!out) throw new Error(`生成超时（最后状态：${lastStatus || '未知'}）`);

  // 取最终视频：本地模式从 output 目录复制；远端模式经 /view 下载
  prog('取回视频…');
  const dstVideo = path.join(outputDir(), `${jobId}.mp4`);
  await fetchOutput(out, dstVideo);

  // 高清修复（RealESRGAN，可选，倍数=视频放大倍数）
  if (highRes) {
    prog(`高清修复（RealESRGAN ${highResScale || 4}x）…`);
    const hires = await runHighResFix(dstVideo, highResScale);
    fs.copyFileSync(hires, dstVideo);
  }

  // 配音：合成音频并入视频（可选）
  let audioPath = '';
  if (dub && String(dub.text || '').trim() && dub.voice_id) {
    prog('配音合成…');
    try {
      const tts = require('./ttsService');
      const audioFile = await tts.synthesize(Number(dub.voice_id), dub.text);
      const muxed = await muxAudio(dstVideo, audioFile);
      fs.copyFileSync(muxed, dstVideo);
      audioPath = audioFile;
    } catch (e) {
      console.warn('[comfy] 配音失败（保留无声视频）：', e.message);
    }
  }

  if (getMode() !== 'remote') {
    try { fs.unlinkSync(path.join(COMFY_DIR, 'input', inputName)); } catch { /* 清理输入图失败不影响 */ }
    if (endInputName) try { fs.unlinkSync(path.join(COMFY_DIR, 'input', endInputName)); } catch { /* 同上 */ }
  }
  prog('完成');
  return { videoPath: dstVideo, audioPath, promptId, status: lastStatus };
}

// ffmpeg 定位：优先 env FFMPEG，其次随包 py312/ffmpeg，最后走 PATH（Linux docker）
function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const local = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(local)) return local;
  return 'ffmpeg';
}

// ffprobe 定位（读取视频时长用；与 ffmpeg 同目录）
function ffprobePath() {
  if (process.env.FFPROBE) return process.env.FFPROBE;
  const local = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (fs.existsSync(local)) return local;
  return 'ffprobe';
}

// 读取视频时长（秒）；失败返回 null（此时退回不截断、只补静音的保守路径）
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve(null));
    p.on('exit', () => {
      const d = parseFloat(out.trim());
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    });
  });
}

// ffmpeg 把音频并入视频（替换原视频音轨；无音轨则直接混入）。
// 不能用 -shortest：配音音频（约 2.5s）比视频（约 5s）短时，-shortest 会把视频也截到音频长度。
// 正确做法：apad 把短音频补静音到视频时长，-t 掐到视频时长（音频过长则截掉）。
async function muxAudio(videoPath, audioPath) {
  const out = videoPath.replace(/\.mp4$/i, '_dub.mp4');
  const ffmpeg = ffmpegPath();
  const dur = await probeDuration(videoPath);
  const args = ['-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-af', 'apad'];
  if (dur) args.push('-t', String(dur)); else args.push('-shortest'); // 读不到时长时退回 -shortest（apad 已把音频补成无限长，-shortest 落在视频结束点，不会截视频）
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffmpeg 合成退出码 ${code}`))));
  });
}

// ---------- MiniMax-H3 后端（独立 8188 便携版 / 局域网） ----------
function h3Health() {
  return fetch(baseUrl('h3') + '/system_stats', { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
}
async function ensureH3() {
  if (await h3Health()) return true;
  throw new Error('MiniMax-H3 后端不可达：' + baseUrl('h3') + '（请确认 8188 端口的 H3 ComfyUI 已启动，或在「模型配置 → H3」页设置局域网地址）');
}

// Z-image 后端：默认与本机 8189 共享（local），也可单独指向局域网远端（remote）。
// 远端只做连通性检查，不拉起本机 ComfyUI；本地复用 ensureComfy（同一个 8189 实例）。
// 版本号 → 数字元组（"0.3.62"→[0,3,62]，"0.34.0"→[0,34,0]，逐位数值比较）
function verTuple(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}
function verLt(a, b) { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); } return false; }

async function ensureZimage() {
  let stats = null;
  try {
    stats = await fetch(baseUrl('zimage') + '/system_stats', { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() : null));
  } catch { stats = null; }
  // 守卫：local 模式指向 8189（0.3.62）时 Qwen3-4B 会被误判成 Llama-3-8B 必炸，提前给指向性报错
  if (stats && getMode('zimage') === 'local') {
    const ver = (stats.system && stats.system.comfyui_version) || stats.comfyui_version;
    const v = verTuple(ver);
    if (v && verLt(v, [0, 3, 74])) {
      throw new Error(`本机 ComfyUI（v${ver}）不支持 Z-Image（需 v0.3.74+）：Qwen3-4B 文本编码器会被误判成 Llama-3-8B 导致 size mismatch。请到「模型配置 → 文生图 Z-image」切换为远端并填 http://127.0.0.1:8188`);
    }
  }
  if (stats) return true;
  if (getMode('zimage') === 'remote') throw new Error('远端 Z-image ComfyUI 不可达：' + (getUrl('zimage') || '(未配置地址)'));
  return ensureComfy();
}

// ---------- Z-image 文生图 工作流参数（从 work/z-image.json 读默认值，供页面预填） ----------
function zimageDefaults() {
  try {
    const wf = loadWorkflow(WORKFLOW_ZIMAGE);
    return {
      prompt: wf['45'].inputs.text, negative: wf['50'].inputs.text,
      clip_name: wf['39'].inputs.clip_name, clip_type: wf['39'].inputs.type, clip_device: wf['39'].inputs.device,
      vae_name: wf['40'].inputs.vae_name,
      unet_name: wf['41'].inputs.unet_name, weight_dtype: wf['41'].inputs.weight_dtype,
      width: 2560, height: 1440, // v1.0.35 默认 QHD 横版（工作流模板自带 1088×1920 竖版，此处覆盖）
      batch_size: wf['43'].inputs.batch_size,
      shift: wf['42'].inputs.shift,
      seed: wf['44'].inputs.seed, steps: wf['44'].inputs.steps, cfg: wf['44'].inputs.cfg,
      sampler_name: wf['44'].inputs.sampler_name, scheduler: wf['44'].inputs.scheduler, denoise: wf['44'].inputs.denoise,
    };
  } catch { return {}; }
}

// H3 示例提示词（取自 dance_street_workflow_ui.json 的 script，作页面预填示例）
const H3_DEFAULT_SCRIPT = '画面从提供的首帧参考图开始，一镜到底连续拍摄，单人舞蹈直拍。\n角色一致性锚点（必须保持）：年轻东亚女性，栗棕色大波浪长卷发及腰，空气刘海，左侧银色星星发夹，小圆环耳环，肚脐钉。五官精致，大眼睛，妆容自然清透。身穿黑色短款牛仔外套（敞开），内搭白色修身短款吊带露腰，高腰浅蓝色阔腿牛仔裤，斜挎黑色漆皮小方包（带银色蝴蝶结装饰）。整体形象与参考图完全一致，不改变发型、发色、服装、配饰和面部特征。\n舞蹈动作：韩系女团风格舞蹈，节奏明快有力。起始姿势为参考图姿态（双手抬至头部两侧），随后双手顺势放下，头部微甩，头发随动作飘动；接着身体向右侧 wave，右手从头顶滑至腰侧，胯部同步摆动；然后向前走两步，双臂交叉打开，配合肩部律动；中段原地转体一圈，长发和牛仔外套随旋转飞扬；随后做一个下蹲起身的动作，双手从膝盖滑至胸前；结尾面对镜头，单手比心放在脸颊旁，俏皮眨眼微笑。动作流畅自然，富有节奏感和表现力，肢体线条优美。\n场景环境：保持参考图的城市街道场景，斑马线、沥青路面、背景建筑和树木不变。夕阳金色光线持续，微风轻拂发丝和衣角。背景有轻微虚化，突出人物主体。街道上无其他行人干扰。\n镜头语言：中景固定机位为主，人物始终在画面中心。舞蹈动作幅度大时镜头轻微跟随，保持人物完整入镜。转体时镜头不晃动，稳定捕捉全身动作。整体镜头稳定，类似直拍 fancam 视角。\n光影氛围：保持参考图的金色夕阳逆光，人物轮廓有温暖光晕，面部有柔和补光。地面和建筑反射夕阳暖色调。整体光影温暖浪漫，与参考图一致。\n画质风格：4K 超清，电影级质感，人物清晰锐利，背景适度虚化。色彩温暖饱和，皮肤质感自然细腻，发丝动态清晰。整体风格时尚青春，类似街头舞蹈直拍。\n负面约束：不改变人物面部特征、发型发色、服装和配饰；不出现多余人物；不切换场景；画面不抖动不模糊；肢体不变形；手指不扭曲；不出现文字水印。\n音频：无人物对白，无旁白，仅有轻柔的街道环境音与低沉的音乐律动。';

function h3Defaults() {
  return {
    prompt: H3_DEFAULT_SCRIPT,
    model_name: 'MiniMax-H3-fl2va-curve-Q4_0.gguf',
    clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', clip_type: 'minimax', mmproj_name: '(auto)',
    video_vae: 'minimax_h3_video_vae_fp16.safetensors', audio_vae: 'minimax_h3_audio_vae_fp32.safetensors',
    shot_count: 1, width: 480, height: 832, frames_per_shot: 362,
    seed: 20260722, steps: 20, seed_per_shot: true, sampler_name: 'euler', scheduler: 'beta',
    self_anchor_voice: false, output_scale: 1, fps: 24, bit_depth: 'auto', color_space: 'sRGB',
  };
}

// 组装 H3 工作流（API 格式）；首帧参考图缺省时走纯文生视频（不接 start_image）
function buildH3Workflow(p) {
  const models = p.models || {};
  const wf = {
    '3': { class_type: 'H3ModelLoaderAny', inputs: { model_name: p.modelName || models.h3_model || 'MiniMax-H3-fl2va-curve-Q4_0.gguf', activation_reserve_gb: 0 } },
    '4': { class_type: 'H3ClipLoaderAny', inputs: { clip_name: p.clipName || models.h3_clip || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: p.clipType || 'minimax', mmproj_name: p.mmprojName || '(auto)' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: p.videoVae || models.h3_video_vae || 'minimax_h3_video_vae_fp16.safetensors' } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: p.audioVae || models.h3_audio_vae || 'minimax_h3_audio_vae_fp32.safetensors' } },
    '7': { class_type: 'H3MultishotSampler', inputs: {
      model: ['3', 0], clip: ['4', 0], video_vae: ['5', 0], audio_vae: ['6', 0],
      script: String(p.prompt || '').trim(),
      shot_count: Math.max(0, Math.min(8, Math.floor(Number(p.shotCount) || 1))),
      width: Math.max(32, Math.floor(Number(p.width) || 480)),
      height: Math.max(32, Math.floor(Number(p.height) || 832)),
      frames_per_shot: Math.max(5, Math.min(481, Math.floor(Number(p.framesPerShot) || 362))),
      seed: (p.seed === undefined || p.seed === null || p.seed === '' || Number(p.seed) < 0) ? Math.floor(Math.random() * 1e15) : Number(p.seed),
      steps: Math.max(1, Math.min(50, Math.floor(Number(p.steps) || 20))),
      seed_per_shot: !!p.seedPerShot,
      sampler_name: p.samplerName || 'euler',
      scheduler: p.scheduler || 'beta',
      self_anchor_voice: !!p.selfAnchorVoice,
      output_scale: Number(p.outputScale) || 1.0,
      save_every_shot: false,
    } },
    '8': { class_type: 'CreateVideo', inputs: { images: ['7', 0], audio: ['7', 1], fps: Number(p.fps) || 24, bit_depth: p.bitDepth || 'auto', color_space: p.colorSpace || 'sRGB' } },
    '9': { class_type: 'SaveVideo', inputs: { video: ['8', 0], filename_prefix: `video/H3_DANCE/h3_${p.jobId}`, format: 'auto' } },
  };
  if (p.inputName) {
    wf['2'] = { class_type: 'LoadImage', inputs: { image: p.inputName } };
    wf['7'].inputs.start_image = ['2', 0];
  }
  return wf;
}

// ---------- Z-image 文生图 生成 ----------
async function generateImage({ prompt, negativePrompt, clipName, clipType, clipDevice, vaeName, unetName, weightDtype, width, height, batchSize, shift, seed, steps, cfg, samplerName, scheduler, denoise, genMode, srcImagePath, upscaleMethod }, onProgress, taskRef) {
  const prog = (s, pct) => { if (typeof onProgress === 'function') onProgress(s, pct); };
  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const W = Math.max(64, Math.floor(Number(width) || 1920)), H = Math.max(64, Math.floor(Number(height) || 1080));
  const isRemote = getMode('zimage') === 'remote';

  // v1.0.36 放大模式（hires=重绘放大 / upscale=纯超分）都要先把原图放进 ComfyUI input
  let inputName = '';
  if (genMode && genMode !== 't2i' && srcImagePath) {
    prog('上传原图到 ComfyUI…', 10);
    const ext = (path.extname(srcImagePath) || '.png').slice(1) || 'png';
    inputName = `zimg2img_${Date.now()}.${ext}`;
    await placeInputTo(srcImagePath, inputName, baseUrl('zimage'), isRemote ? null : COMFY_DIR);
  }

  let wf;
  if (genMode === 'upscale') {
    // 纯超分：LoadImage → RealESRGAN ×4 → 缩到目标尺寸。不加载扩散模型、不采样（秒级）。
    // 模型取 upscale_models 目录第一个 .pth；远端模式目录在算力端（已放 RealESRGAN_x4plus.pth），
    // 缺模型时 ComfyUI 会直接报错——本地模式提前给友好提示。
    let upModel = 'RealESRGAN_x4plus.pth';
    if (!isRemote) {
      const dir = path.join(COMFY_DIR, 'models', 'upscale_models');
      let found = '';
      try { found = fs.readdirSync(dir).filter((n) => /\.pth$/i.test(n)).sort()[0] || ''; } catch { /* 目录不存在 */ }
      if (!found) throw new Error('未找到超分模型：ComfyUI/models/upscale_models/ 下没有 .pth（请放 RealESRGAN_x4plus.pth）');
      upModel = found;
    }
    wf = {
      '1': { class_type: 'UpscaleModelLoader', inputs: { model_name: upModel } },
      '2': { class_type: 'LoadImage', inputs: { image: inputName } },
      '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['1', 0], image: ['2', 0] } },
      '4': { class_type: 'ImageScale', inputs: { image: ['3', 0], upscale_method: 'bicubic', width: W, height: H, crop: 'disabled' } },
      '47': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: `zimage_upscale_${jobId}` } },
    };
  } else {
    prog('加载工作流…', 5);
    await ensureZimage(); // 与本机 8189 共享（lumina2 + ModelSamplingAuraFlow 支持已验证）
    wf = loadWorkflow(WORKFLOW_ZIMAGE);
    const models = modelMap('zimage');
  setNode(wf, '39', { clip_name: clipName || models.zimage_clip || 'qwen_3_4b.safetensors', type: clipType || 'lumina2', device: clipDevice || 'default' });
  setNode(wf, '40', { vae_name: vaeName || models.zimage_vae || 'ae.safetensors' });
  setNode(wf, '41', { unet_name: unetName || models.zimage_unet || 'z_image_turbo_bf16.safetensors', weight_dtype: weightDtype || 'default' });
  setNode(wf, '42', { shift: Number(shift) || 3.0 });
  setNode(wf, '43', { width: Math.max(64, Math.floor(Number(width) || 1088)), height: Math.max(64, Math.floor(Number(height) || 1920)), batch_size: Math.max(1, Math.min(8, Math.floor(Number(batchSize) || 1))) });
  setNode(wf, '45', { text: String(prompt || '').trim() });
  setNode(wf, '50', { text: String(negativePrompt || '').trim() || DEFAULT_NEGATIVE });
  const seedNum = (seed === undefined || seed === null || seed === '' || Number(seed) < 0) ? Math.floor(Math.random() * 1e15) : Number(seed);
  setNode(wf, '44', { seed: seedNum, steps: Math.max(1, Math.floor(Number(steps) || 9)), cfg: Number(cfg) || 1.0, sampler_name: samplerName || 'res_multistep', scheduler: scheduler || 'simple', denoise: Number(denoise) || 1.0 });

  setNode(wf, '47', { filename_prefix: `zimage_${jobId}` });

    // v1.0.36 重绘放大（img2img）：原图先按目标尺寸放大（ImageScale 内置节点）→ VAEEncode
    // → 替换 KSampler 的空 latent；denoise 前端默认 0.2（低重绘=AI 超分：只补细节，>0.3 易改画面/变脸）
    if (genMode === 'hires' && srcImagePath && inputName) {
      wf['59'] = { class_type: 'LoadImage', inputs: { image: inputName } };
      wf['60'] = { class_type: 'ImageScale', inputs: { image: ['59', 0], upscale_method: upscaleMethod || 'nearest-exact', width: W, height: H, crop: 'disabled' } };
      wf['61'] = { class_type: 'VAEEncode', inputs: { pixels: ['60', 0], vae: ['40', 0] } };
      setNode(wf, '44', { latent_image: ['61', 0] });
    }
  } // t2i / hires 分支结束；纯超分分支的 wf 已在上面最小化构建

  prog('提交 ComfyUI…', 22);
  const mon = progressMonitor(baseUrl('zimage'));
  const pr = await fetch(baseUrl('zimage') + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: mon.clientId }), signal: AbortSignal.timeout(30000),
  });
  const pj = await pr.json();
  if (!pr.ok || !pj.prompt_id) throw new Error('ComfyUI 提交失败：' + JSON.stringify(pj).slice(0, 300));
  const promptId = pj.prompt_id;
  try { taskRef && taskRef.onSubmitted && taskRef.onSubmitted(promptId, baseUrl('zimage'), wf); } catch { /* 登记失败不影响生成 */ }

  prog('生成中（采样/解码）…', 30);
  activeRuns.set(promptId, { kind: (taskRef && taskRef.kind) || 'zimage', jobId: String((taskRef && taskRef.jobId) || jobId), base: baseUrl('zimage'), ts: Date.now(), cancelled: false });
  const deadline = Date.now() + 20 * 60 * 1000;
  let out = null; let lastStatus = '';
  try {
    while (Date.now() < deadline) {
      checkCancelled(promptId);
      const hr = await fetch(baseUrl('zimage') + `/history/${promptId}`, { signal: AbortSignal.timeout(5000) });
      const hist = await hr.json();
      const entry = hist[promptId];
      if (entry && entry.status) {
        lastStatus = entry.status.status_str || lastStatus;
        if (entry.status.completed) { out = extractImage(hist); break; }
        if (entry.status.status_str === 'error') {
          const msgs = readableError(entry.status.messages);
          const zhHint = /Llama2|size mismatch/i.test(msgs)
            ? '\n根因：该 ComfyUI 版本过旧（<0.3.74），不认识 Z-Image 的 Qwen3-4B 编码器。请到「模型配置 → 文生图 Z-image」把后端切到 0.3.74+ 的实例（当前统一后端 8189）'
            : '';
          throw new Error('生成失败：' + (msgs.slice(0, 300) || '未知错误') + zhHint);
        }
      }
      await pollProgress(mon, promptId, baseUrl('zimage'), wf, prog, 30, lastStatus);
      await sleep(2000);
    }
  } finally { activeRuns.delete(promptId); }
  if (!out) throw new Error(`生成超时（最后状态：${lastStatus || '未知'}）`);

  prog('取回图像…', 85);
  const dstImage = path.join(outputDir(), `${jobId}.png`);
  await fetchOutputTo(out, dstImage, baseUrl('zimage'), getMode('zimage') === 'remote' ? null : COMFY_DIR);
  prog('完成', 100);
  return { imagePath: dstImage, promptId, status: lastStatus, workflow: wf };
}

// ---------- Qwen-Image-Layered（广告图 / PSD 分层图） ----------
// 模型：qwen_image_layered_fp8mixed + qwen_2.5_vl_7b_fp8_scaled + qwen_image_layered_vae（grp=qil）
// 节点均为 8189(ComfyUI 0.34) 内置核心节点，无需装任何自定义节点。
// 分层原理：EmptyQwenImageLayeredLatentImage 产出 5D latent [batch,16,layers+1,h//8,w//8]，
//   dim2 第 0 层 = 合并预览，1..N = 各透明图层。采样后 LatentCut(dim='t',index=1,amount=16384)
//   丢掉合并层、LatentCutToBatch(slice_size=1) 把图层维转 batch → VAEDecode 逐层出 RGBA PNG。
//   服务端用 pngjs 解码各层 → ag-psd 组装成 .psd（Photoshop 打开即分层、保留透明度与图层顺序）。

// 默认参数（供「广告图」页预填；提示词内置 PSD 分层引导，满足「默认加入提示引导」需求）
function qilDefaults() {
  return {
    prompt: '设计一张可分层的广告图：画面主体（产品或图形元素）与背景清晰分离，主体、装饰元素、背景各自独立成透明图层，各元素边缘干净锐利、轮廓完整，形成带透明背景的分层结构，便于后期在 Photoshop 中逐层编辑与合成。宽幅横向广告构图，主体居中偏右，左侧留出干净负空间。',
    negative: DEFAULT_NEGATIVE,
    clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', clip_type: 'qwen_image', clip_device: 'default',
    vae_name: 'qwen_image_layered_vae.safetensors',
    unet_name: 'qwen_image_layered_fp8mixed.safetensors', weight_dtype: 'default',
    width: 2560, height: 1440, layers: 3, batch_size: 1, // v1.0.34 默认尺寸 2560×1440（恰 16:9，前端自动选中比例锁）
    shift: 1.0,
    seed: -1, steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
  };
}

// 组装 QIL 工作流（API 格式），1:1 复刻用户「数字6 广告图」工作流的节点与连线。
// 两个输出分支：预览（合并层 index=0）+ 图层（index=1..N，经 LatentCutToBatch 转 batch）。
function buildQilWorkflow(p) {
  const models = p.models || {};
  const layers = Math.max(2, Math.min(8, Math.floor(Number(p.layers) || 3)));
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: p.unetName || models.qil_unet || 'qwen_image_layered_fp8mixed.safetensors', weight_dtype: p.weightDtype || 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: p.clipName || models.qil_clip || 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: p.vaeName || models.qil_vae || 'qwen_image_layered_vae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: String(p.prompt || '').trim(), clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: String(p.negativePrompt || '').trim() || DEFAULT_NEGATIVE, clip: ['2', 0] } },
    '6': { class_type: 'EmptyQwenImageLayeredLatentImage', inputs: { width: p.width, height: p.height, layers, batch_size: 1 } },
    '7': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: Number(p.shift) || 1.0 } },
    '8': { class_type: 'KSampler', inputs: { model: ['7', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: p.seed, steps: Math.max(1, Math.floor(Number(p.steps) || 20)), cfg: Number(p.cfg) || 2.5, sampler_name: p.samplerName || 'euler', scheduler: p.scheduler || 'simple', denoise: Number(p.denoise) || 1.0 } },
    '9': { class_type: 'LatentCut', inputs: { samples: ['8', 0], dim: 't', index: 1, amount: 16384 } },
    '10': { class_type: 'LatentCutToBatch', inputs: { samples: ['9', 0], dim: 't', slice_size: 1 } },
    '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    '12': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: `qil_layers_${p.jobId}` } },
    '13': { class_type: 'LatentCut', inputs: { samples: ['8', 0], dim: 't', index: 0, amount: 1 } },
    '14': { class_type: 'LatentCutToBatch', inputs: { samples: ['13', 0], dim: 't', slice_size: 1 } },
    '15': { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['3', 0] } },
    '16': { class_type: 'SaveImage', inputs: { images: ['15', 0], filename_prefix: `qil_prev_${p.jobId}` } },
  };
}

// PNG → RGBA ImageData（pngjs 恒输出 4 通道，不透明图 alpha=255）
function readPngImageData(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

// 把 N 张图层 PNG + 1 张合并预览 PNG 组装成分层 PSD。
// layers 顺序 = 自底向上（第 1 层是背景、第 N 层是前景）；ag-psd children[0] 即最底层。
// width/height 未显式给时从复合图/首层自动推导（保证文档尺寸与 imageData 一致）。
function assemblePsd({ layers, composite, width, height, outPath }) {
  const children = layers.map((f, i) => ({ name: `图层 ${i + 1}`, imageData: readPngImageData(f) }));
  const psd = { children };
  if (composite && fs.existsSync(composite)) psd.imageData = readPngImageData(composite);
  const dim = psd.imageData || (children[0] && children[0].imageData);
  psd.width = width || (dim && dim.width) || 0;
  psd.height = height || (dim && dim.height) || 0;
  const buf = writePsdBuffer(psd, { generateThumbnail: false });
  fs.writeFileSync(outPath, Buffer.from(buf));
  return outPath;
}

// QIL 文生分层图：提交 → 轮询 → 取回合并预览 + N 张图层 → 组装 PSD。
// 复用 zimage 后端（同一 8189 实例），返回 { imagePath(预览), psdPath, layers[], workflow }。
async function generateQilImage({ prompt, negativePrompt, clipName, clipType, clipDevice, vaeName, unetName, weightDtype, width, height, layers, shift, seed, steps, cfg, samplerName, scheduler, denoise }, onProgress, taskRef) {
  const prog = (s, pct) => { if (typeof onProgress === 'function') onProgress(s, pct); };
  prog('加载工作流…', 5);
  await ensureZimage(); // 与 8189 共享（QIL 核心节点 + qwen_image CLIP 均在 0.34）
  const models = modelMap('qil');
  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const seedNum = (seed === undefined || seed === null || seed === '' || Number(seed) < 0) ? Math.floor(Math.random() * 1e15) : Number(seed);
  // 潜空间按 8 整除（节点步进 16）：非 16 倍数会被 ComfyUI 校验拦截，这里先圆整
  const W = Math.max(16, Math.min(2048, Math.round(Number(width || 1088) / 16) * 16));
  const H = Math.max(16, Math.min(2048, Math.round(Number(height || 1920) / 16) * 16));
  const wf = buildQilWorkflow({ prompt, negativePrompt, clipName, vaeName, unetName, weightDtype, width: W, height: H, layers, shift, seed: seedNum, steps, cfg, samplerName, scheduler, denoise, models, jobId });

  prog('提交 ComfyUI…', 22);
  const base = baseUrl('zimage');
  const mon = progressMonitor(base);
  const pr = await fetch(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: mon.clientId }), signal: AbortSignal.timeout(30000) });
  const pj = await pr.json();
  if (!pr.ok || !pj.prompt_id) throw new Error('ComfyUI 提交失败：' + JSON.stringify(pj).slice(0, 300));
  const promptId = pj.prompt_id;
  try { taskRef && taskRef.onSubmitted && taskRef.onSubmitted(promptId, base, wf); } catch { /* 登记失败不影响生成 */ }

  prog('生成中（采样/分层解码）…', 30);
  activeRuns.set(promptId, { kind: (taskRef && taskRef.kind) || 'qil', jobId: String((taskRef && taskRef.jobId) || jobId), base, ts: Date.now(), cancelled: false });
  const deadline = Date.now() + 30 * 60 * 1000;
  let hist = null; let lastStatus = '';
  try {
    while (Date.now() < deadline) {
      checkCancelled(promptId);
      const hr = await fetch(base + `/history/${promptId}`, { signal: AbortSignal.timeout(5000) });
      hist = await hr.json();
      const entry = hist[promptId];
      if (entry && entry.status) {
        lastStatus = entry.status.status_str || lastStatus;
        if (entry.status.completed) break;
        if (entry.status.status_str === 'error') {
          const msgs = readableError(entry.status.messages);
          throw new Error('生成失败：' + (msgs.slice(0, 300) || '未知错误'));
        }
      }
      await pollProgress(mon, promptId, base, wf, prog, 30, lastStatus);
      await sleep(2000);
    }
  } finally { activeRuns.delete(promptId); }
  if (!hist || !hist[promptId] || !hist[promptId].status || !hist[promptId].status.completed) throw new Error(`生成超时（最后状态：${lastStatus || '未知'}）`);

  const layerImgs = extractImages(hist, `qil_layers_${jobId}`);
  const prevImgs = extractImages(hist, `qil_prev_${jobId}`);
  if (!layerImgs.length) throw new Error('生成完成但未找到图层输出');
  const outDir = outputDir();
  const isRemote = getMode('zimage') === 'remote';
  const comfyDir = isRemote ? null : COMFY_DIR;

  prog('取回图层…', 80);
  const layerFiles = [];
  for (let i = 0; i < layerImgs.length; i++) {
    const dst = path.join(outDir, `${jobId}_layer_${i + 1}.png`);
    await fetchOutputTo(layerImgs[i], dst, base, comfyDir);
    layerFiles.push(dst);
  }
  let previewFile = '';
  if (prevImgs.length) {
    previewFile = path.join(outDir, `${jobId}.png`);
    await fetchOutputTo(prevImgs[0], previewFile, base, comfyDir);
  } else if (layerFiles.length) {
    previewFile = layerFiles[0]; // 无独立预览时退回第 1 层
  }

  prog('组装 PSD 分层文件…', 92);
  const psdFile = path.join(outDir, `${jobId}.psd`);
  assemblePsd({ layers: layerFiles, composite: prevImgs.length ? previewFile : '', width: W, height: H, outPath: psdFile });

  prog('完成', 100);
  return { imagePath: previewFile, psdPath: psdFile, layers: layerFiles, promptId, status: lastStatus, workflow: wf };
}

// ---------- MiniMax-H3 图生视频 / 文生视频 生成 ----------
async function generateH3Video({ imagePath, prompt, modelName, clipName, clipType, mmprojName, videoVae, audioVae, shotCount, width, height, framesPerShot, seed, steps, seedPerShot, samplerName, scheduler, selfAnchorVoice, outputScale, fps, bitDepth, colorSpace }, onProgress, taskRef) {
  const prog = (s, pct) => { if (typeof onProgress === 'function') onProgress(s, pct); };
  prog('检查 H3 后端…', 5);
  await ensureH3();
  const base = baseUrl('h3');
  const models = modelMap('h3');
  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let inputName = '';
  if (imagePath) {
    const ext = (path.extname(imagePath).toLowerCase() || '.png').replace('.', '');
    inputName = `h3_${jobId}.${ext || 'png'}`;
    prog('上传首帧参考图…', 14);
    await placeInputTo(imagePath, inputName, base, null);
  }

  prog('组装工作流…', 22);
  const wf = buildH3Workflow({ inputName, prompt, modelName, clipName, clipType, mmprojName, videoVae, audioVae, shotCount, width, height, framesPerShot, seed, steps, seedPerShot, samplerName, scheduler, selfAnchorVoice, outputScale, fps, bitDepth, colorSpace, models, jobId });

  prog('提交 ComfyUI…', 25);
  const mon = progressMonitor(base);
  const pr = await fetch(base + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: mon.clientId }), signal: AbortSignal.timeout(30000),
  });
  const pj = await pr.json();
  if (!pr.ok || !pj.prompt_id) throw new Error('ComfyUI 提交失败：' + JSON.stringify(pj).slice(0, 300));
  const promptId = pj.prompt_id;
  try { taskRef && taskRef.onSubmitted && taskRef.onSubmitted(promptId, base, wf); } catch { /* 登记失败不影响生成 */ }

  prog('生成中（H3 采样/合成视频）…', 30);
  activeRuns.set(promptId, { kind: (taskRef && taskRef.kind) || 'h3', jobId: String((taskRef && taskRef.jobId) || jobId), base, ts: Date.now(), cancelled: false });
  const deadline = Date.now() + 120 * 60 * 1000; // H3 视频生成较久：20 步全尺寸在 3060 上 40min+，上限放宽到 120 分钟
  let out = null; let lastStatus = '';
  try {
    while (Date.now() < deadline) {
      checkCancelled(promptId);
      const hr = await fetch(base + `/history/${promptId}`, { signal: AbortSignal.timeout(5000) });
      const hist = await hr.json();
      const entry = hist[promptId];
      if (entry && entry.status) {
        lastStatus = entry.status.status_str || lastStatus;
        if (entry.status.completed) { out = extractVideoRaw(hist); break; }
        if (entry.status.status_str === 'error') {
          const msgs = readableError(entry.status.messages);
          throw new Error('生成失败：' + (msgs.slice(0, 400) || '未知错误'));
        }
      }
      await pollProgress(mon, promptId, base, wf, prog, 30, lastStatus);
      await sleep(3000);
    }
  } finally { activeRuns.delete(promptId); }
  if (!out) throw new Error(`生成超时（最后状态：${lastStatus || '未知'}）`);

  prog('取回视频…', 85);
  const dstVideo = path.join(outputDir(), `${jobId}.mp4`);
  await fetchOutputTo(out, dstVideo, base, null);
  prog('完成', 100);
  return { videoPath: dstVideo, promptId, status: lastStatus, workflow: wf };
}

async function status() {
  const h = await health();
  const mode = getMode();
  return {
    running: !!h,
    mode,
    source: mode === 'remote' ? 'remote' : 'local',
    url: mode === 'remote' ? getUrl() : `http://127.0.0.1:${PORT}`,
    port: mode === 'remote' ? '' : PORT,
    comfy_dir: mode === 'remote' ? '' : COMFY_DIR,
    ...(h ? { device: (h.devices && h.devices[0] && h.devices[0].name) || '' } : {}),
  };
}

// 任一后端（i2v/zimage/h3）的连通状态，供「模型配置」3 个 tab 各显其态
async function statusFor(kind) {
  const url = baseUrl(kind);
  const h = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return { running: !!h, mode: getMode(kind), url, device: (h && h.devices && h.devices[0] && h.devices[0].name) || '' };
}

// ---------- v1.0.13 重启收养 ----------
// 应用重启（升级/崩溃）后，已提交算力端的任务凭任务行的 prompt_id + comfy_base 恢复跟踪：
// history 里已完成 → 返回 { out, hist }（调用方取回产物落库 done）；
// 出错 → 抛错（调用方落 failed）；仍在排队/执行 → 持续轮询到完成。
// 同时登记 activeRuns，任务中心的「停止」在收养期间同样有效。
async function adoptRun({ base, promptId, kind, jobId, extract, deadlineMin = 130, prog = () => {} }) {
  if (!activeRuns.has(promptId)) activeRuns.set(promptId, { kind: kind || 'i2v', jobId: String(jobId || ''), base, ts: Date.now(), cancelled: false });
  const deadline = Date.now() + deadlineMin * 60 * 1000;
  let absent = 0; // 连续既不在 history 也不在 queue 的次数（被移出/中断即判死，不空转到超时）
  try {
    while (Date.now() < deadline) {
      checkCancelled(promptId);
      const hist = await fetch(base + `/history/${promptId}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
      const entry = hist && hist[promptId];
      if (entry && entry.status) {
        absent = 0;
        if (entry.status.completed) {
          const out = extract === 'image' ? extractImage(hist) : (extract === 'raw' ? extractVideoRaw(hist) : extractVideo(hist));
          if (out) return { out, hist, entry };
          throw new Error('算力端显示完成但未找到输出文件');
        }
        if (entry.status.status_str === 'error') throw new Error('生成失败：' + readableError(entry.status.messages).slice(0, 400));
        prog('恢复跟踪：' + (entry.status.status_str || '执行中'));
      } else {
        // 不在 history：ComfyUI 完成后才写 history——执行中/排队中都查不到。
        // 分开判定：queue_running=正在算（显示 GPU 计算中），queue_pending=还在排队
        let running = false, pending = false;
        try {
          const q = await fetch(base + '/queue', { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
          running = (q.queue_running || []).some((e) => e && e[1] === promptId);
          pending = (q.queue_pending || []).some((e) => e && e[1] === promptId);
        } catch { /* 队列查询失败按在队处理，别误杀 */ }
        if (running) { absent = 0; prog('恢复跟踪：GPU 计算中', 30); }
        else if (pending) { absent = 0; prog('恢复跟踪：排队等待 GPU', 15); }
        else if (++absent >= 3) throw new Error('算力端已无此任务（已被移出或中断）');
      }
      await sleep(3000);
    }
    throw new Error('收养跟踪超时');
  } finally { activeRuns.delete(promptId); }
}

// 从任意 base（含本机 local 模式的 8189）经 HTTP /view 下载产物——收养路径统一走 HTTP，避免依赖当前模式
async function downloadOutput(out, dst, base) { await fetchOutputTo(out, dst, base, null); }

module.exports = { ensureComfy, ensureZimage, generate, generateImage, generateH3Video, ensureH3, zimageDefaults, h3Defaults, qilDefaults, generateQilImage, buildQilWorkflow, assemblePsd, extractImages, status, statusFor, modelMap, DEFAULT_MODELS, DEFAULT_NEGATIVE, seedModels, listLoras, runHighResFix, getMode, getUrl, baseUrl, setBackend, outputDir, lanIp, getListenAddr, configureComputeNode, UPLOAD_DIR, COMFY_DIR, PYTHON, FFMPEG_DIR, WORKFLOW_FLF, WORKFLOW_ZIMAGE, activeRuns, adoptRun, downloadOutput, syncModelPaths, selfHealBackend };
