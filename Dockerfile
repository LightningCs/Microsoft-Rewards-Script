# Dockerfile

###############################################################################
# Stage 1: Builder (只负责编译代码)
###############################################################################
FROM node:24-slim AS builder

WORKDIR /usr/src/microsoft-rewards-script

# 复制 package 文件并安装**所有**依赖（含 devDependencies，用于构建）
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

# 复制源码并构建
COPY . .
RUN npm run build

###############################################################################
# Stage 2: Runtime (复用基础镜像的 node_modules)
###############################################################################
# 使用我们刚构建的 base 镜像
FROM ghcr.io/thenetsky/microsoft-rewards-script:base AS runtime

WORKDIR /usr/src/microsoft-rewards-script

# 关键：只从 builder 复制构建产物 dist 和 package 文件
# 绝对不要复制 node_modules，否则会覆盖掉基础镜像里包含浏览器的 node_modules
COPY --from=builder /usr/src/microsoft-rewards-script/dist ./dist
COPY --from=builder /usr/src/microsoft-rewards-script/package*.json ./

# 复制原始脚本中的其余运行时文件
COPY config.example.json ./config.example.json
COPY --chmod=755 scripts/docker/run_daily.sh ./scripts/docker/run_daily.sh
COPY --chmod=755 scripts/docker/healthcheck.sh ./scripts/docker/healthcheck.sh
COPY --chmod=755 scripts/api/ ./scripts/api/
COPY --chmod=644 scripts/env.js ./scripts/env.js
COPY --chmod=644 scripts/package.json ./scripts/package.json
COPY --chmod=644 src/crontab.template /etc/cron.d/microsoft-rewards-cron.template
COPY --chmod=755 scripts/docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "echo 'Container started; cron is running.'"]