# vitality server image (Node.js 22 per the fixed stack).
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install --global pnpm@9.15.0
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @vitality/shared build
RUN pnpm --filter @vitality/server build

FROM node:22-alpine AS runner
RUN npm install --global pnpm@9.15.0
WORKDIR /app
ENV NODE_ENV=production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY apps/server/migrations apps/server/migrations
WORKDIR /app/apps/server
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
