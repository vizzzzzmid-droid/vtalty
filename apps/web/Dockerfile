# vitality web image: Vite static build served by Caddy.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /repo
RUN npm install --global pnpm@9.15.0
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @vitality/shared build
RUN pnpm --filter @vitality/web build

FROM caddy:2-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e AS runner
COPY --from=build /repo/apps/web/dist /srv/web
COPY apps/web/web.Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
