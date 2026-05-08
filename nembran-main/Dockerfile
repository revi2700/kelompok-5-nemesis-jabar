# ── Builder stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++ sqlite

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/src          ./src
COPY --from=builder /app/seed         ./seed
COPY --from=builder /app/worker.js    ./worker.js
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p data dataset logs \
    && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["npm", "run", "start"]
