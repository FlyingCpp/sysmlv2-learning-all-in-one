FROM node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --cache ./.npm-cache && npm cache clean --force
COPY apps/web ./apps/web
RUN npm run build:web

FROM node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache ./.npm-cache && npm cache clean --force
COPY apps/web/server.js apps/web/syson-layout-enhancer.js ./apps/web/
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
