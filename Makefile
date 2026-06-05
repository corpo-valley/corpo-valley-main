# corpo-valley-main: build + push platform container images.
# Deploy automation lives in corpo-valley-hetzner (or your equivalent
# deployment repo); this Makefile only handles local image builds.

.PHONY: help new-app build push run-local

GHCR_NAMESPACE ?= corpo-valley
IMAGE_PREFIX   ?= corpo-valley-
REGISTRY       ?= ghcr.io/$(GHCR_NAMESPACE)
PLATFORMS      ?= linux/amd64,linux/arm64
TAG            ?= dev

YELLOW := \033[1;33m
GREEN  := \033[0;32m
BLUE   := \033[0;34m
NC     := \033[0m

help:
	@echo "$(BLUE)corpo-valley-main$(NC) - container image builds"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make $(YELLOW)<target>$(NC)\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  $(YELLOW)%-18s$(NC) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

new-app: ## Scaffold a new app: APP_NAME=foo [LANG=typescript] [PORT=3000]
	@./scripts/new-app.sh $(if $(APP_NAME),--name $(APP_NAME)) $(if $(LANG),--lang $(LANG)) $(if $(PORT),--port $(PORT))

build: ## Build an image locally. Usage: make build APP_NAME=portal [TAG=dev]
	@test -n "$(APP_NAME)" || { echo "APP_NAME required"; exit 1; }
	docker build -t $(REGISTRY)/$(IMAGE_PREFIX)$(APP_NAME):$(TAG) \
		-f containers/$(APP_NAME)/Dockerfile \
		$$(if [ -f containers/$(APP_NAME)/context.txt ]; then cat containers/$(APP_NAME)/context.txt; \
		   elif [ -d typescript/$(APP_NAME) ]; then echo typescript/$(APP_NAME); \
		   elif [ -d python/$(APP_NAME) ]; then echo python/$(APP_NAME); \
		   else echo .; fi)

push: ## Push a locally built image. Usage: make push APP_NAME=portal [TAG=dev]
	@test -n "$(APP_NAME)" || { echo "APP_NAME required"; exit 1; }
	docker push $(REGISTRY)/$(IMAGE_PREFIX)$(APP_NAME):$(TAG)

run-local: ## Run a built image locally. Usage: make run-local APP_NAME=portal PORT=3000
	@test -n "$(APP_NAME)" || { echo "APP_NAME required"; exit 1; }
	docker run --rm -p $(or $(PORT),3000):$(or $(PORT),3000) $(REGISTRY)/$(IMAGE_PREFIX)$(APP_NAME):$(TAG)
