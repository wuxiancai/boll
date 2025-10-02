#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 22.04 one-click deploy for BOLL OCR scraper (Node + Puppeteer)
# - Installs system deps and Node.js
# - Installs npm packages and Chrome for Testing (managed by Puppeteer)
# - Creates and starts a systemd service

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
SERVICE_NAME="boll"
NODE_MAJOR="${NODE_MAJOR:-20}"

echo "[1/6] Checking OS..."
if ! grep -qi "Ubuntu" /etc/os-release || ! grep -qi "22.04" /etc/os-release; then
  echo "This script targets Ubuntu Server 22.04. Continue at your own risk." >&2
fi

echo "[2/6] Installing APT dependencies..."
sudo apt-get update -y
sudo apt-get install -y \
  ca-certificates curl gnupg build-essential unzip fontconfig lsb-release \
  libnss3 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 libxrandr2 libgbm1 \
  libgtk-3-0 libxdamage1 libxext6 libasound2

echo "[3/6] Installing Node.js ${NODE_MAJOR}.x..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v) | NPM: $(npm -v)"

echo "[4/6] Installing npm dependencies..."
cd "$PROJECT_DIR"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "[5/6] Installing Chrome for Testing via Puppeteer..."
# Download managed Chrome runtime (non-interactive)
npx puppeteer browsers install chrome || true

# Resolve chrome binary path in Puppeteer cache
CHROME_BIN="$(ls -d "$HOME/.cache/puppeteer/chrome"/*/chrome-linux*/chrome 2>/dev/null | head -n1 || true)"
if [ -z "$CHROME_BIN" ]; then
  echo "Failed to locate Chrome for Testing binary in ~/.cache/puppeteer/chrome. Aborting." >&2
  exit 1
fi
echo "Using Chrome binary: $CHROME_BIN"

echo "[6/6] Creating and starting systemd service..."
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
sudo tee "$UNIT_PATH" >/dev/null <<EOF
[Unit]
Description=BOLL OCR scraper (Puppeteer)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
User=$USER_NAME
Group=$USER_NAME
Environment=HEADLESS=true
Environment=CAPTURE_INTERVAL_MS=1000
Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN
ExecStart=/usr/bin/node $PROJECT_DIR/scrape-boll.js
Restart=always
RestartSec=3
StandardOutput=append:$PROJECT_DIR/${SERVICE_NAME}.log
StandardError=append:$PROJECT_DIR/${SERVICE_NAME}.err.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "Deployment complete."
echo "Service: sudo systemctl status ${SERVICE_NAME}"
echo "Logs:   tail -f $PROJECT_DIR/${SERVICE_NAME}.log"