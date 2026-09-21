# vitality web image: Vite static build served by Caddy.
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install --global pnpm@9.15.0
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @vitality/shared build
RUN pnpm --filter @vitality/web build

FROM caddy:2-alpine AS runner
COPY --from=build /repo/apps/web/dist /srv/web
COPY apps/web/web.Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
