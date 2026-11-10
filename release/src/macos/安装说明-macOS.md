# 衍像｜EvolveShot — macOS 安装说明

## 环境要求

- macOS 13+（Apple silicon 或 Intel）
- **Node.js 24+**（`brew install node`，或官网 https://nodejs.org 下 pkg）
- python3（可选，见下方「本机模式」）

> macOS 包只含网页应用（server + web + node_modules）。ComfyUI 与模型**不在包里**：
> 推荐用「远端模式」把它们放在局域网 GPU 机器上，Mac 零模型开箱即用。

## 快速开始（远端模式，推荐）

1. 解压 `EvolveShot_macOS_*.zip` 到任意目录（如 `~/EvolveShot`）；
2. 终端执行一次：`chmod +x start-mac.command`；
3. 双击 `start-mac.command`（首次若被 Gatekeeper 拦，右键 → 打开）；
4. 浏览器自动打开 http://127.0.0.1:9666，登录默认账号 **`videoadmin / admin123`**（登录后请立即改密码）；
5. 「模型配置 → 模型后端」把三个后端（首尾视频/文生图/视频生成）切到 **远端**，
   填 GPU 机器的 ComfyUI 地址（如 `http://192.168.110.57:8189`）；
   需要配音时「语音配音 → 配音后端 → 远端」填 `http://<GPU机>:9640`。
6. 模型清单与下载地址见包内《模型下载说明.md》——**模型放在 GPU 机器的 ComfyUI 目录**，不放 Mac。

## 本机模式（在 Mac 上跑 ComfyUI，进阶）

Apple silicon 可以跑，但 GGUF 大模型速度与兼容性不如 NVIDIA 显卡机器，请有心理预期。

1. 安装 ComfyUI（0.34）到本包目录下的 `ComfyUI/`（或任意位置后设环境变量 `COMFYUI_DIR` 指过去）：
   ```bash
   git clone https://github.com/comfyanonymous/ComfyUI ComfyUI
   cd ComfyUI && python3 -m venv venv && source venv/bin/activate
   pip install -r requirements.txt torch
   ```
2. 安装 custom_nodes（在 `ComfyUI/custom_nodes/` 下；推荐先装 ComfyUI-Manager 后搜索同名安装）：
   `ComfyUI-GGUF`（必装，GGUF 加载）、`ComfyUI-GIMM-VFI`、`ComfyUI-H3-Multishot`、
   `ComfyUI-WanMoeKSampler`、`Comfyui-Resolution-Master`、`comfyui-kjnodes`、`comfyui-logic`、
   `comfyui-videohelpersuite`、`comfyui_essentials`、`rgthree-comfy`、`wanblockswap`
   （GitHub 搜索同名仓库 git clone 即可）。
3. 按《模型下载说明.md》把模型放进 `ComfyUI/models/...`（Mac 本机目录）。
4. `start-mac.command` 默认已把 `COMFYUI_DIR` 指到包内 `ComfyUI/`、`COMFYUI_PYTHON` 指到
   `python3`——按你的实际安装调整（编辑 `start-mac.command` 顶部的 export 行）。
5. 手动启动 ComfyUI：`cd ComfyUI && python3 main.py --port 8189 --listen 127.0.0.1`。

## 可选功能在 macOS 上的说明

| 功能 | 状态 | 处理办法 |
|---|---|---|
| 语音配音（本地引擎） | 随包 Python 为 Windows 版 | 用远端模式指向 GPU 机的 9640 |
| 高清修复（RealESRGAN） | 同上 | 远端模式由 GPU 机承担；本机自试：`pip3 install torch basicsr realesrgan opencv-python tqdm` |
| 看图写提示词（qwen3-vl-2b） | 模型需另下 | 按《模型下载说明.md》第七节把 `qwen3-vl-2b/` 放到本包根目录，并 `pip3 install torch transformers` |
| 视频剪辑（Concat 引擎） | 需另装 | 官网 https://concat.standalones.org 下载 macOS 版安装 |

## 常见问题

- **双击脚本被拦截**：系统设置 → 隐私与安全性 → 仍要打开；或终端 `chmod +x` 后用 `./start-mac.command` 启动。
- **局域网其它设备访问**：`http://<Mac的IP>:9666`，系统设置 → 网络 → 防火墙放行。
- 数据都在包内 `data/` 目录，整目录拷贝即备份。
