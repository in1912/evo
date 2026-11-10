# 衍像｜EvolveShot — Docker 安装说明

## 架构一句话

Docker 镜像只跑**前端 + Node 后端**（端口 9666）；生成计算由 **GPU 机器上的 ComfyUI** 承担。
所以 Docker 版可以跑在无显卡的 NAS（fnOS 群晖威联通等）上，模型也**全部放在 GPU 机器**，
容器里不放任何模型（见《模型下载说明.md》）。

## 部署步骤

1. 把整个目录（含 `Dockerfile`、`docker-compose.yml`、`server/`、`web/`、`node_modules/`、
   `package.json`）上传到 NAS，进入该目录；
2. `docker compose up -d --build`（镜像 `evolveshot:latest`，端口 9666，数据卷 `./data`）；
3. 浏览器打开 `http://<NAS的IP>:9666`，登录默认账号 **`videoadmin / admin123`**（登录后请立即改密码）；
4. 配置后端（二选一）：
   - compose 里取消注释并设环境变量后 `docker compose up -d` 重建：
     ```yaml
     environment:
       - COMFY_MODE=remote
       - COMFY_URL=http://192.168.110.57:8189   # GPU 机的 ComfyUI
       - MOSS_TTS_MODE=remote
       - MOSS_TTS_URL=http://192.168.110.57:9640 # GPU 机的配音引擎（可选）
     ```
   - 或登录后在页面改：「模型配置 → 模型后端」三个后端（首尾视频/文生图/视频生成）都切「远端」
     填 GPU 机地址；「语音配音 → 配音后端」同理。
5. GPU 机侧：双击 Windows 版的 `start-model.bat`（ComfyUI `0.0.0.0:8189` + TTS `0.0.0.0:9640`），
   并按《模型下载说明.md》把模型放进 GPU 机的 ComfyUI 目录。

生成的视频/图片自动回传到 NAS 的 `./data/output/`。

## 剪辑台（可选）：装 Concat 引擎

容器是 Linux 环境，Concat 官方发行版二选一（官网 https://concat.standalones.org ）：

- **AppImage**：放到 `./data/concat/` 后解包：
  `docker compose exec evolveshot sh -c "cd /app/data/concat && ./Concat_*.AppImage --appimage-extract"`
  （系统会自动识别 `./data/concat/squashfs-root/AppRun`）
- **.deb**：`dpkg -x xxx.deb ./data/concat/`（识别 `./data/concat/usr/bin/concat`）

## 数据与升级

- 全部数据在 `./data` 卷（SQLite/生成物/上传/音色/证书/升级备份），备份=拷走这个目录。
- 版本升级：系统内「设置 → 升级」上传新包，或拉新代码后 `docker compose up -d --build`。
- 端口 9666 为 HTTP/HTTPS 自适应（设置页配置证书后同端口自动走 HTTPS）。

## 常见问题

- **构建慢/失败**：镜像构建无需联网装依赖（node_modules 已随包 COPY）；只需 apt 拉 ffmpeg，
  失败多为 NAS 的 apt 源问题，重试即可。
- **生成报后端离线**：检查 GPU 机 8189 是否在线、NAS 与 GPU 机同网段、GPU 机防火墙放行 8189。
- **不要在容器里的「模型配置」页拉模型**：模型拉进容器对远端计算无效；模型一律放 GPU 机。
