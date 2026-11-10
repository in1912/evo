#!/bin/bash
# 衍像｜EvolveShot macOS 启动器（首次使用先 chmod +x start-mac.command）
cd "$(dirname "$0")" || exit 1

export PORT=9666
export DATA_DIR="$(pwd)/data"
export COMFYUI_DIR="$(pwd)/ComfyUI"
export COMFYUI_PYTHON="$(command -v python3 || echo python3)"
export VIDEO_PYTHON="$(command -v python3 || echo python3)"
export WORKFLOW_FILE="$(pwd)/work/complete-i2v.json"
[ -d Logs ] || mkdir -p Logs

command -v node >/dev/null 2>&1 || {
  echo "[ERROR] 未找到 node，请先安装 Node.js 24+（brew install node）"
  read -r -p "按回车退出..." _
  exit 1
}

echo "============================================"
echo "  衍像 | EvolveShot"
echo "  http://127.0.0.1:9666   登录: videoadmin / admin123"
echo "============================================"

( sleep 2; open "http://127.0.0.1:9666" ) >/dev/null 2>&1 &
exec node server/index.js
