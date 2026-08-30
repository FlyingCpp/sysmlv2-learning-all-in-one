FROM node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8
WORKDIR /app
RUN apk add --no-cache unzip p7zip
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache ./.npm-cache && npm cache clean --force
COPY apps/api ./apps/api
COPY apps/teacher ./apps/teacher
COPY packages ./packages
COPY config/llm-protocol-catalog.json ./config/llm-protocol-catalog.json
COPY courses ./courses
COPY knowledge-packs ./knowledge-packs
COPY scripts/sysml-knowledge ./scripts/sysml-knowledge
COPY scripts/auth-db-migrate.js ./scripts/auth-db-migrate.js
COPY scripts/auth-bootstrap-admin.js ./scripts/auth-bootstrap-admin.js
COPY scripts/teacher-db-migrate.js ./scripts/teacher-db-migrate.js
EXPOSE 8080
CMD ["node", "apps/api/server.js"]
