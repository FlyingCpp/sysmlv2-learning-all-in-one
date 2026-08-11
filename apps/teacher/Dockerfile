FROM node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 AS agent-builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/clean-teacher-agent-build.js ./scripts/clean-teacher-agent-build.js
COPY apps/teacher/agent ./apps/teacher/agent
COPY apps/teacher/tsconfig.agent.json ./apps/teacher/tsconfig.agent.json
RUN npm run build:teacher-agent

FROM node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY apps/teacher ./apps/teacher
COPY --from=agent-builder /app/apps/teacher/dist ./apps/teacher/dist
COPY packages/teacher-contract ./packages/teacher-contract
COPY packages/agent-resource-policy ./packages/agent-resource-policy
COPY scripts/sysml-knowledge ./scripts/sysml-knowledge
COPY scripts/teacher-db-migrate.js ./scripts/teacher-db-migrate.js
COPY scripts/verify-real-provider.js ./scripts/verify-real-provider.js

ENV PORT=7070
EXPOSE 7070

CMD ["node", "apps/teacher/server.js"]
