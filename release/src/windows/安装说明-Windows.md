# 衍像｜EvolveShot — Windows 安装说明

## 环境要求

- Windows 10/11 x64
- **NVIDIA 显卡**（本机出图需要；建议 ≥12GB 显存，16GB+ 更稳）
- **Node.js 24+**（https://nodejs.org 下载 LTS 安装；启动脚本会自动检查）
- 磁盘空间：程序约 28GB + 模型按需 0~110GB（见《模型下载说明.md》）

## 安装步骤

1. 把压缩包解压到**短路径英文目录**，例如 `D:\EvolveShot`
   （内含深度学习运行库，路径太长/含中文可能导致解压失败或启动异常）。
2. 安装 Node.js 24+（如已装可跳过）。
3. 双击 **`start.bat`** = 本机完整模式：自动拉起 ComfyUI(8189) + 网页服务(9666)，
   并自动打开浏览器。首次启动会自动创建 `data\` 数据目录和默认账号。
4. 登录：默认 `videoadmin / admin123`（登录后请在「用户管理」里改密码）。
5. 按《模型下载说明.md》下载所需模型（也可登录后在「模型配置」页一键拉取）。

## 两种启动方式

| 脚本 | 用途 |
|---|---|
| `start.bat` | 本机完整操作：本机出图 + 网页界面，双击即用 |
| `start-model.bat` | 局域网服务器（算力端）模式：无界面跑 8189+9666 供其它机器访问，自动最小化 |

## 局域网访问

其它电脑/手机访问 `http://<本机IP>:9666`。首次需在 Windows 防火墙放行 9666、8189 两个端口
（PowerShell 管理员执行）：

```powershell
New-NetFirewallRule -DisplayName "EvolveShot 9666" -Direction Inbound -LocalPort 9666 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "EvolveShot ComfyUI 8189" -Direction Inbound -LocalPort 8189 -Protocol TCP -Action Allow
```

## 目录结构（解压后）

```
EvolveShot\
├── start.bat / start-model.bat   启动脚本
├── server\ + web\ + node_modules\  网页应用（Node 服务）
├── ComfyUI\                       ComfyUI 0.34 本体（模型放 ComfyUI\models\...）
├── python_embeded\                ComfyUI 的 Python 3.13 运行时
├── py312\                         高清修复/本地配音/看图写提示词用的 Python 3.12
├── cuda-home\                     CUDA 运行组件
├── res\                           高清修复脚本（已含 RealESRGAN 权重）
├── work\                          工作流模板
├── data\                          用户数据/生成结果/数据库（首次启动自动创建）
├── 模型下载说明.md                ← 先看这个
└── 安装说明-Windows.md            本文件
```

## 常见问题

- **双击 start.bat 提示 node not found**：先装 Node.js 24+。
- **生成报模型缺失**：对照《模型下载说明.md》检查文件名与目录。
- **9666/8189 被占用**：脚本有端口守卫，重复双击无害；真被别的程序占了就改掉那个程序。
- **升级**：新版本 zip 在系统里「系统设置 → 升级」上传即可，无需重新解压。
- 剪辑台（可选）需另装 Concat 引擎：官网 https://concat.standalones.org 下载 Windows 安装包，
  装好后在「视频剪辑 → 快速合成」页会自动识别。
