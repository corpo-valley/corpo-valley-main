#!/bin/bash
#
# new-app.sh
# Scaffolds a new platform service: source code, Dockerfile, and k8s manifest.
#
# Usage:
#   ./scripts/new-app.sh
#   ./scripts/new-app.sh --name myapp --lang typescript --port 3000
#
# Creates:
#   typescript/<app>/ or python/<app>/   - source code
#   containers/<app>/                     - Dockerfile + .dockerignore
#   k8s/platform/<app>.yaml               - Namespace + Deployment + Service + Ingress
#
# Image published by CI: ghcr.io/<GITHUB_USER>/corpo-valley-<app>
# Reachable at: <app>.corpo-valley.com

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$PROJECT_ROOT/templates"
GITHUB_USER="hashtagcyber"
DOMAIN="corpo-valley.com"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

APP_NAME=""; LANGUAGE=""; PORT=""

usage() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --name <name>      App name (lowercase, no spaces)"
    echo "  --lang <language>  Language: typescript or python"
    echo "  --port <port>      Port (default: 3000 for ts, 8000 for python)"
    echo "  -h, --help         Show this help"
    exit 0
}

validate_name() {
    local name="$1"
    if [[ ! "$name" =~ ^[a-z][a-z0-9-]*$ ]]; then
        echo -e "${RED}Error: name must start with a letter; lowercase letters, numbers, hyphens only${NC}"
        return 1
    fi
    if [[ ${#name} -gt 63 ]]; then
        echo -e "${RED}Error: name must be 63 characters or less${NC}"
        return 1
    fi
    return 0
}

prompt_if_empty() {
    local varname="$1" prompt="$2" default="${3:-}"
    if [[ -z "${!varname}" ]]; then
        if [[ -n "$default" ]]; then
            read -p "$prompt [$default]: " value; value="${value:-$default}"
        else
            read -p "$prompt: " value
        fi
        eval "$varname=\"$value\""
    fi
}

replace_placeholders() {
    local file="$1"
    sed -i.bak \
        -e "s/{{APP_NAME}}/$APP_NAME/g" \
        -e "s/{{PORT}}/$PORT/g" \
        -e "s/{{HOSTNAME}}/$APP_NAME.$DOMAIN/g" \
        -e "s/{{GITHUB_USER}}/$GITHUB_USER/g" \
        -e "s/{{DOMAIN}}/$DOMAIN/g" \
        "$file"
    rm -f "${file}.bak"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --name) APP_NAME="$2"; shift 2 ;;
        --lang) LANGUAGE="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; usage ;;
    esac
done

echo -e "${BLUE}=== Corpo Valley App Scaffolder ===${NC}"
echo ""

prompt_if_empty APP_NAME "App name (lowercase)"
validate_name "$APP_NAME" || exit 1

if [[ -d "$PROJECT_ROOT/typescript/$APP_NAME" ]] || [[ -d "$PROJECT_ROOT/python/$APP_NAME" ]]; then
    echo -e "${RED}Error: app '$APP_NAME' already exists${NC}"
    exit 1
fi

if [[ -z "$LANGUAGE" ]]; then
    echo ""
    echo "Select language:"
    echo "  1) typescript"
    echo "  2) python"
    read -p "Choice [1]: " lang_choice
    case "${lang_choice:-1}" in
        1|typescript) LANGUAGE="typescript" ;;
        2|python) LANGUAGE="python" ;;
        *) echo -e "${RED}Invalid choice${NC}"; exit 1 ;;
    esac
fi

if [[ "$LANGUAGE" != "typescript" && "$LANGUAGE" != "python" ]]; then
    echo -e "${RED}Error: language must be 'typescript' or 'python'${NC}"
    exit 1
fi

if [[ -z "$PORT" ]]; then
    case "$LANGUAGE" in
        typescript) DEFAULT_PORT="3000" ;;
        python) DEFAULT_PORT="8000" ;;
    esac
    prompt_if_empty PORT "Port" "$DEFAULT_PORT"
fi

echo ""
echo -e "${YELLOW}Creating app:${NC}"
echo "  Name:      $APP_NAME"
echo "  Language:  $LANGUAGE"
echo "  Port:      $PORT"
echo "  Namespace: cv-$APP_NAME"
echo "  Hostname:  $APP_NAME.$DOMAIN"
echo "  Image:     ghcr.io/$GITHUB_USER/corpo-valley-$APP_NAME"
echo ""
read -p "Continue? [Y/n]: " confirm
if [[ "${confirm:-Y}" =~ ^[Nn] ]]; then echo "Aborted."; exit 0; fi

echo -e "${YELLOW}Creating directories...${NC}"
mkdir -p "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/src"
mkdir -p "$PROJECT_ROOT/containers/$APP_NAME"
mkdir -p "$PROJECT_ROOT/k8s/platform"

echo -e "${YELLOW}Creating source files...${NC}"
if [[ "$LANGUAGE" == "typescript" ]]; then
    cp "$TEMPLATES_DIR/source/typescript/index.ts" "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/src/"
    cp "$TEMPLATES_DIR/source/typescript/package.json" "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/"
    cp "$TEMPLATES_DIR/source/typescript/tsconfig.json" "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/"
    replace_placeholders "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/src/index.ts"
    replace_placeholders "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/package.json"
else
    cp "$TEMPLATES_DIR/source/python/app.py" "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/"
    cp "$TEMPLATES_DIR/source/python/requirements.txt" "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/"
    replace_placeholders "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/app.py"
fi

echo -e "${YELLOW}Creating container files...${NC}"
cp "$TEMPLATES_DIR/container/$LANGUAGE.Dockerfile" "$PROJECT_ROOT/containers/$APP_NAME/Dockerfile"
cp "$TEMPLATES_DIR/container/.dockerignore" "$PROJECT_ROOT/containers/$APP_NAME/"
replace_placeholders "$PROJECT_ROOT/containers/$APP_NAME/Dockerfile"

echo -e "${YELLOW}Creating Kubernetes manifest...${NC}"
cp "$TEMPLATES_DIR/kubernetes/app.yaml.template" "$PROJECT_ROOT/k8s/platform/$APP_NAME.yaml"
replace_placeholders "$PROJECT_ROOT/k8s/platform/$APP_NAME.yaml"

if [[ "$LANGUAGE" == "typescript" ]]; then
    echo -e "${YELLOW}Generating package-lock.json...${NC}"
    (cd "$PROJECT_ROOT/$LANGUAGE/$APP_NAME" && npm install --package-lock-only)
fi

cat > "$PROJECT_ROOT/$LANGUAGE/$APP_NAME/README.md" << EOF
# $APP_NAME

## Development

\`\`\`bash
$(if [[ "$LANGUAGE" == "typescript" ]]; then echo "npm install"; else echo "pip install -r requirements.txt"; fi)
$(if [[ "$LANGUAGE" == "typescript" ]]; then echo "npm run dev"; else echo "python app.py"; fi)
\`\`\`

## Build & Deploy

Push to \`main\` and the build-images workflow builds
\`ghcr.io/$GITHUB_USER/corpo-valley-$APP_NAME\`, then bumps
\`k8s/platform/$APP_NAME.yaml\` to the new tag. ArgoCD rolls it out.

## Endpoints

- \`/\`       - Main endpoint (authenticated via Oathkeeper headers)
- \`/health\` - Health check (no auth)
EOF

echo ""
echo -e "${GREEN}App '$APP_NAME' created.${NC}"
echo ""
echo "Files created:"
echo "  $LANGUAGE/$APP_NAME/"
echo "  containers/$APP_NAME/"
echo "  k8s/platform/$APP_NAME.yaml"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. cd $LANGUAGE/$APP_NAME && implement your service"
echo "  2. git add + commit + push to main -> CI builds and ArgoCD deploys"
