# 衍像｜EvolveShot 主程序镜像（前端 + Node 后端）
# 不含 ComfyUI / py312 / 模型 —— 计算单元在另一台 GPU 机器上（start-model.bat 启动）。
# 本镜像可跑在无显卡的 NAS（fnOS 等），通过「模型后端 → 远端」指向 GPU 机。
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=9666 \
    DATA_DIR=/app/data

WORKDIR /app

# ffmpeg：给生成视频配音混音（moss 音频 -> 视频音轨）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 应用代码（node_modules 纯 JS，直接复用，构建无需联网）
COPY server ./server
COPY web ./web
COPY node_modules ./node_modules
COPY package.json ./package.json

# 预留数据目录（输出视频 / 上传 / 音色 / sqlite / 证书 / 升级包）读写权限
RUN mkdir -p /app/data/output /app/data/uploads /app/data/tts && chmod -R 777 /app/data

EXPOSE 9666

# 启动时再次确保卷挂载后的目录可读写（bind mount 会覆盖镜像内权限）
CMD ["sh", "-c", "mkdir -p /app/data/output /app/data/uploads /app/data/tts && chmod -R 777 /app/data && exec node server/index.js"]
