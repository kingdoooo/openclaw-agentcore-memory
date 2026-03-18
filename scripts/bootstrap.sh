#!/bin/bash
# memory-agentcore Bootstrap Script
#
# This script handles the initial setup that must happen BEFORE the plugin
# is installed (chicken-and-egg: plugin skill is only available after install).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<user>/openclaw-agentcore-memory/main/scripts/bootstrap.sh | bash -s -- <memoryId> [region]
#
# Or run locally:
#   bash scripts/bootstrap.sh mem-xxxxxxxxxx us-east-1

set -euo pipefail

MEMORY_ID="${1:-}"
AWS_REGION="${2:-us-east-1}"
REPO_URL="${AGENTCORE_REPO_URL:-https://github.com/anthropics/openclaw-agentcore-memory.git}"
INSTALL_DIR="${HOME}/projects/openclaw-agentcore-memory"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { printf "${GREEN}[agentcore]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[agentcore]${NC} %s\n" "$1"; }
err()  { printf "${RED}[agentcore]${NC} %s\n" "$1"; exit 1; }

# --- Validate ---
if [ -z "$MEMORY_ID" ]; then
  err "Usage: bootstrap.sh <memoryId> [region]"
fi

log "Starting memory-agentcore bootstrap"
log "  Memory ID: $MEMORY_ID"
log "  Region:    $AWS_REGION"

# --- Pre-flight ---
command -v git >/dev/null 2>&1 || err "git is required but not installed"
command -v npm >/dev/null 2>&1 || command -v bun >/dev/null 2>&1 || err "npm or bun is required"
command -v openclaw >/dev/null 2>&1 || err "openclaw is not installed"
aws sts get-caller-identity >/dev/null 2>&1 || err "AWS credentials not configured"

log "Pre-flight checks passed"

# --- Clone / Update ---
if [ -d "$INSTALL_DIR" ]; then
  log "Repository exists, pulling latest..."
  cd "$INSTALL_DIR" && git pull --ff-only
else
  log "Cloning repository..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# --- Install Dependencies ---
log "Installing dependencies..."
if command -v bun >/dev/null 2>&1; then
  bun install --frozen-lockfile 2>/dev/null || bun install
else
  npm install
fi

# --- Install Plugin (link mode) ---
log "Installing plugin into OpenClaw..."
openclaw plugins install -l "$INSTALL_DIR"

# --- Configure ---
log "Configuring plugin..."

CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"

if [ ! -f "$CONFIG_FILE" ]; then
  err "OpenClaw config not found at $CONFIG_FILE"
fi

# Use openclaw config set if available, otherwise provide manual instructions
if openclaw config set plugins.entries.memory-agentcore.enabled true 2>/dev/null && \
   openclaw config set plugins.entries.memory-agentcore.config.memoryId "$MEMORY_ID" 2>/dev/null && \
   openclaw config set plugins.entries.memory-agentcore.config.awsRegion "$AWS_REGION" 2>/dev/null; then
  log "Config set via CLI"
else
  warn "Could not set config via CLI. Please add manually to $CONFIG_FILE:"
  cat <<EOF

  plugins: {
    entries: {
      "memory-agentcore": {
        enabled: true,
        config: {
          memoryId: "$MEMORY_ID",
          awsRegion: "$AWS_REGION",
        },
      },
    },
  }

EOF
fi

# --- Write Checkpoint ---
echo "verify" > ~/.openclaw/.agentcore-setup-checkpoint
log "Checkpoint written for post-restart verification"

# --- Restart ---
log ""
log "============================================"
log "  Installation complete!"
log "  "
log "  Next steps:"
log "    1. Run: openclaw gateway restart"
log "    2. Send any message to your agent"
log "    3. The agent will auto-verify the plugin"
log "============================================"
