# ── 多阶段构建：后端 API 服务 ──

# 阶段 1：编译 TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY skills/ ./skills/

RUN npm run build

# 阶段 2：生产镜像
FROM node:20-alpine AS production

WORKDIR /app

# 仅安装生产依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 拷贝编译产物
COPY --from=builder /app/dist ./dist

# 拷贝运行时需要的非 TS 资源
COPY public/ ./public/
COPY data/ ./data/
COPY db/ ./db/
COPY skills/ ./skills/

ENV NODE_ENV=production
EXPOSE 3000

# 修正：tsc 的 rootDir 为项目根目录，编译产物在 dist/src/ 下
CMD ["node", "dist/src/index.js"]
