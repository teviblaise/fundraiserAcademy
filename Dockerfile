FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/academy.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.mjs backend.mjs password-recovery.mjs passwords.mjs two-factor.mjs sessions.mjs delivery.mjs certificates.mjs contracts.mjs market-data.mjs live-quotes.mjs support.mjs support-ai.mjs support-admin.mjs leaderboard.mjs ./
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "--use-env-proxy", "server.mjs"]
