# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src/server/ ./src/server/
COPY src/client/ ./src/client/
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /data/storage && chown node:node /data/storage && chmod 0750 /data/storage
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist/server/ ./dist/server/
COPY --from=build /app/dist-client/ ./dist-client/
COPY skills/agentfiles/SKILL.md ./skills/agentfiles/SKILL.md
COPY LICENSE THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js", "--host=0.0.0.0"]
