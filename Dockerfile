# OpenKittens – schlankes Produktionsimage
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3333 \
    HOST=0.0.0.0

WORKDIR /app

# Abhängigkeiten zuerst, damit Docker den Layer cachen kann
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

USER node
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
