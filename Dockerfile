FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/simulator/package.json packages/simulator/package.json
RUN npm ci

COPY . .
RUN npm run build \
  && npm cache clean --force

ENV NODE_ENV=production

FROM node:24-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app

ENV NODE_ENV=production

EXPOSE 4310

CMD ["npm", "run", "start:api"]
