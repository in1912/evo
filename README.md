# 衍像｜EvolveShot（evo）

AI 生成一体化系统：**首尾视频、文生视频、文生图、广告图（PSD 分层）、语音克隆配音、视频剪辑**，
一套网页系统全部搞定。前端 + Node 后端 + ComfyUI 计算后端三件解耦，支持
**Windows 一键包 / macOS / Docker** 三端部署，模型外置、按需下载。

> **默认管理员账号：`videoadmin` / 密码 `admin123`** —— 首次登录后请立即在「设置 → 用户管理」修改密码。

## 为什么做这个

把「图生视频 + 出图 + 配音 + 剪辑成片」这条流水线从多个工具（ComfyUI 网页、剪辑软件、配音工具）
收进**一个**网页系统：普通用户打开浏览器就能用，管理员在「模型配置」页管理模型与算力后端，
不需要懂 ComfyUI。

## 功能总览

| 功能 | 说明 |
|---|---|
| 首尾视频 | WAN2.2 图生视频：上传首帧/尾帧（或从系统历史选图）生成中间过渡视频，GIMM-VFI 补帧，支持批量、配音 |
| 视频生成 | MiniMax-H3 文/图生视频（带音轨），首帧参考图支持系统历史选图 |
| 文生图 | Z-Image-Turbo 文生图；三档生成模式（文生图 / 重绘放大 / 纯超分）；多段文本粘贴一键批量出图；负面提示词快捷按钮 |
| 广告图 | Qwen-Image-Layered 分层出图，直接产出 **PSD 分层文件**（Photoshop 打开即分层） |
| 语音配音 | MOSS-TTS-Nano 本地离线语音克隆（或远端引擎），上传参考音频即克隆，ffmpeg 混入视频音轨 |
| 视频剪辑 | 网页多轨剪辑台（素材库/帧预览/检查器/时间线，拖动/修剪/分割/磁吸/微调），驱动 Concat 引擎（MCP 无头模式）真渲染 |
| 任务中心 | 跨页看全部任务：排队/执行中/完成/失败，精确停止、断线重连自动接续、重启自动收养 |
| 我的历史 | 按用户隔离的生成历史，图片/视频查看器（翻页/缩放/循环播放） |
| 模型配置 | 模型存在性按后端真实枚举校验；缺失模型**一键拉取**（hf-mirror 国内镜像、断点续传）；后端本地/远端切换 |
| 远程开机 | HomeAssistant 移植模块：局域网设备开关/状态 |
| 设置 | 用户管理（邀请码注册/配额/页面授权）、登录日志、IP 封禁、HTTPS 自签证书、在线升级、AI 接入配置 |

另附：GPU/CPU/显存**性能浮窗**（算力端中继采样，nvidia-smi + WMI）；登录防爆破（同 IP 5 次锁账号、10 次封 IP）；白天/暗黑主题；9666 端口 HTTP/HTTPS 自适应（配置证书后同端口自动走 HTTPS）。

## 安装部署

三端安装包都自带《安装说明》与《模型下载说明》（**模型不内嵌**，下载地址与放置目录一一列明，全量约 110GB，可按功能分批）。

### Windows（推荐，本机出图）

1. 解压 `EvolveShot_Windows_*.zip` 到短路径英文目录（如 `D:\EvolveShot`）；
2. 装 Node.js 24+，双击 `start.bat` —— ComfyUI(8189) + 网页(9666) 全部自动拉起，浏览器自动打开；
3. 登录 `videoadmin / admin123`，按《模型下载说明.md》下载模型（或在「模型配置」页一键拉取）。

局域网算力机模式：双击 `start-model.bat`（无界面、自动最小化、带端口守卫防重复双击；同时暴露
ComfyUI `0.0.0.0:8189` 与 TTS `0.0.0.0:9640` 供其它机器使用）。

### macOS

解压 `EvolveShot_macOS_*.zip`，`chmod +x start-mac.command` 后双击。
两种后端模式：**远端模式**（推荐——指向局域网 GPU 机的 ComfyUI，Mac 本地零模型）或本机自装
ComfyUI（需自行安装 custom_nodes 与模型，详见包内《安装说明-macOS.md》）。

### Docker（NAS/无显卡机做前端，GPU 机做算力）

```bash
docker compose up -d --build     # 端口 9666，./data 挂载为卷
```

镜像只含前端 + Node 后端。登录后「模型配置 → 模型后端」把三个后端指向 GPU 机的 ComfyUI，
「语音配音 → 配音后端」指向 GPU 机的 TTS（也可用环境变量，见下表）。生成时图片/参考音频上传到
GPU 机，成片回传到 NAS 的 `./data/output`。模型放在 GPU 机器上，清单见《模型下载说明.md》。

### 模型清单（摘要）

| 功能 | 模型组 | 体积 |
|---|---|---|
| 首尾视频 | WAN2.2 I2V A14B Q4 ×2 + umt5 + Wan2.1 VAE + clip_vision_h + LightX2V LoRA | ~27GB |
| 视频生成 | MiniMax-H3 GGUF + qwen3vl-32b + 视频/音频双 VAE | ~31GB |
| 文生图 | Z-Image-Turbo + qwen3-4b + AE（重绘放大同组，纯超分另需 RealESRGAN） | ~19GB |
| 广告图 | Qwen-Image-Layered fp8 + qwen2.5-vl-7b + 分层 VAE | ~28GB |
| 图像理解 | qwen3-vl-2b（首尾视频「看图写提示词」，放应用根目录） | ~4GB |
| 帧插值 | GIMM-VFI（首尾视频补帧） | ~0.1GB |

### 语音引擎安装

首次使用「语音配音」在页面点「一键安装引擎」：下载 MOSS-TTS-Nano 推理仓库到 `data/tts/`
（随包 `py312` 已含全部 Python 依赖）；ONNX 模型（约 670MB）由引擎首次合成时经 hf-mirror 自动下载。

## 访问方式

- 本机：http://127.0.0.1:9666 ；局域网：`http://<机器IP>:9666`（Windows 防火墙放行 9666/8189）。
- 默认账号见文首；移动端可用。

## 数据与备份

所有用户数据在 `data/`（SQLite 数据库 + 生成产物 + 上传 + 音色 + 证书 + 升级备份），整目录拷走即完成备份迁移。

## 版本升级

系统内「设置 → 升级」上传新版本 zip：自动备份旧版 → manifest 逐文件 SHA256 校验 → 原子替换 → 重启生效。
支持回滚（`data/upgrades/backup-*`）。

## 技术架构

```
浏览器 (Vue3 CDN 单文件 SPA, hash 路由, 无构建步骤)
   │ REST + 会话认证 (scrypt 口令)
Node 24 服务 (Express + node:sqlite DatabaseSync, 端口 9666, HTTPS 同端口自适应)
   │ ComfyUI HTTP API (8189, 本机或远端)
ComfyUI 0.34 统一后端（本地模式随 Windows 包附带；远端模式指向任意 GPU 机）
   ├── 首尾视频：WAN2.2 I2V A14B GGUF ×2 (UnetLoaderGGUF) + GIMM-VFI 补帧
   ├── 文生图：Z-Image-Turbo（三档：t2i / img2img 重绘 / RealESRGAN 纯超分）
   ├── 广告图：Qwen-Image-Layered → ag-psd 组装 PSD 分层
   └── 视频生成：MiniMax-H3 (GGUF + qwen3vl 文本编码 + 双 VAE)
配音：MOSS TTS（本地 py312 引擎或远端 9640）→ ffmpeg 混流
剪辑：Concat 引擎 (concat --mcp headless, JSON-RPC 2.0) 每用户常驻会话、15min 空闲自动存关
看图写提示词：qwen3-vl-2b（VIDEO_PYTHON 子进程）
```

- **队列与可靠性**：每类任务独立内存串行队列 + SQLite 落库；重启凭 `prompt_id` 收养 ComfyUI 里
  仍在跑的任务；前端断线自动接续；假进度根修（阶段加权单调递增，批量显示第 N/共 M）。
- **多用户**：用户/配额/邀请码注册/页面级授权/登录日志/IP 封禁；数据按用户隔离，管理员全局可见。
- **自愈**：模型路径失效自动改写、ComfyUI 掉线自动拉起、旧路径实例空闲自动重启（队列有任务绝不杀）。

## 目录结构

```
├── server/            Node 后端（routes/ 按域拆分 + services/：comfy/concat/tts/ssl/zip/restart/ipBan）
├── web/               前端（app.js 单文件 Vue3 + index.html + vendor/）
├── work/              工作流模板（complete-i2v.json 等）
├── res/               高清修复脚本（RealESRGAN）+ Concat 安装包托管（安装包不入 git）
├── ComfyUI/           ComfyUI 0.34 本体 + custom_nodes（仅 Windows 包/本机部署，不入 git）
├── python_embeded/    ComfyUI 运行时 Python 3.13（同上，不入 git）
├── py312/             高清修复/本地 TTS/qwen3-vl 用的 Python 3.12（同上，不入 git）
├── cuda-home/         CUDA 组件（同上，不入 git）
├── qwen3-vl-2b/       看图写提示词模型（不入 git，按说明下载）
├── data/              运行数据（不入 git）
├── release/           三端安装包源与产物（zip 不入 git）
├── Dockerfile / docker-compose.yml / .dockerignore
├── start.bat          Windows 本机完整模式
└── start-model.bat    Windows 局域网算力端模式
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 9666 | Web 服务端口 |
| `COMFYUI_PORT` | 8189 | ComfyUI 引擎端口 |
| `COMFYUI_DIR` | `<app>/ComfyUI` | ComfyUI 目录 |
| `COMFYUI_PYTHON` | `<app>/python_embeded/python.exe` | ComfyUI 解释器 |
| `VIDEO_PYTHON` | `<app>/py312/python.exe` | 高清修复/TTS/qwen3-vl 解释器 |
| `WORKFLOW_FILE` | `<app>/work/complete-i2v.json` | 工作流模板 |
| `DATA_DIR` | `<app>/data` | 数据目录 |
| `DEFAULT_ADMIN` / `DEFAULT_ADMIN_PASSWORD` | videoadmin / admin123 | 默认管理员 |
| `COMFY_MODE` | local | 模型后端模式（local/remote，UI 保存后优先） |
| `COMFY_URL` | 空 | 远端 ComfyUI 地址（如 http://192.168.1.100:8189） |
| `MOSS_TTS_MODE` | local | TTS 配音后端模式（local/remote，UI 保存后优先） |
| `MOSS_TTS_URL` | 空 | 远端 TTS 引擎地址（如 http://192.168.1.100:9640） |
| `HF_ENDPOINT` | hf-mirror.com | HuggingFace 镜像 |

## 常见问题

- **登录不上**：默认 `videoadmin / admin123`；连续错 5 次锁账号、同 IP 10 次封 IP（管理员在设置页解封）。
- **生成报模型缺失**：对照《模型下载说明.md》核对文件名与目录，或在「模型配置」页看校验状态（显示「未校验」= 后端不可达）。
- **GPU 显存 12GB 够吗**：够（启动带 `--lowvram --reserve-vram 1.0`），速度换的；16GB+ 更稳。
- **Docker 版能出图吗**：能，但计算发生在远端 GPU 机的 ComfyUI 上；容器本身无显卡。
- **剪辑台没反应**：需安装 Concat 引擎（Windows 包内「视频剪辑 → 快速合成」页有安装卡，或官网 concat.standalones.org）。
- **想手动拉模型**：模型配置页支持完整 URL（`huggingface.co` 自动改写 hf-mirror）或 `hf:仓库名/文件路径`，自动落 `ComfyUI/models/<类别目录>/`。

## 安全说明

- 首次部署**务必修改默认密码**；系统建议部署在可信局域网。
- 登录日志记录 IP/UA（不存明文密码），支持手动封禁 IP 与自动防爆破。
- 升级接口仅管理员可用；升级包带 manifest 逐文件 SHA256 校验，应用前自动备份可回滚。
