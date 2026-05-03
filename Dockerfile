FROM node:24-slim

ENV NODE_ENV=production
ENV PORT=4317
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY db ./db
COPY scripts ./scripts
COPY src ./src
COPY README.md ./

RUN mkdir -p /app/data/assets && chown -R node:node /app/data
USER node

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]

CMD ["node", "src/server/index.js"]
