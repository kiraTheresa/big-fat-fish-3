# bot-core 生产镜像：Node 22 Debian，使用 Playwright 支持的 Chromium 系统库。
# 零前端构建步骤：COPY 白名单只带运行必需物，
# test / data / napcat / .env / .trae 一概不进镜像（.dockerignore 双保险）。
# 时区：不装系统 tzdata——Node 22 内置 full-ICU，TZ 环境变量（compose 注入
# Asia/Shanghai）由 V8/ICU 直接解析，日志与记忆条目时间戳即为本地时区
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 先拷依赖清单再 npm ci：src 变更不invalidate依赖层，重建只重跑 COPY + 零安装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 安装与锁定 Playwright 版本匹配的无头 Chromium，以及中文字体。
RUN npx playwright install --with-deps chromium --only-shell \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 运行必需：源码 + CHANGELOG（/version 指令的唯一版本数据源，version.js 现读）
COPY CHANGELOG.md ./
COPY src ./src
COPY prompts ./prompts
COPY web ./web

# 非 root 运行（node 镜像内置 uid 1000 用户）；data/ 由 compose 挂载进来，
# 宿主目录属主需与 uid 1000 匹配（首次 mkdir 由容器内 node 用户完成即自动对齐）
USER node

# 直跑 node 而非 npm start：npm 不转发 SIGTERM，直跑让 docker stop 的 10s 宽限
# 内干净退出（compose restart 策略下虽非必需，但信号干净是基线纪律）
CMD ["node", "--env-file-if-exists=.env", "src/index.js"]
