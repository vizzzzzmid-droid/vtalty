.PHONY: dev up down logs ps migrate test-integration test-e2e

dev: ## Start postgres+livekit for host development
	docker compose -f docker-compose.dev.yml up -d
	@echo "Postgres :5432 and LiveKit :7880 are up."
	@echo "Run 'pnpm --filter @vitality/server dev' and 'pnpm --filter @vitality/web dev' in separate terminals."

up: ## Build and start the full stack
	docker compose up --build

down: ## Stop the full stack
	docker compose down

logs: ## Follow stack logs
	docker compose logs -f

ps: ## List stack containers
	docker compose ps

migrate: ## Run DB migrations against dev postgres (needs DATABASE_URL)
	pnpm --filter @vitality/server migrate

test-integration: ## Run server integration tests against real Postgres
	docker compose -f docker-compose.dev.yml up -d postgres
	pnpm --filter @vitality/server test:integration

test-e2e: ## Run Playwright e2e (needs server :3000 + web :5173 running)
	pnpm --filter @vitality/web test:e2e
