#!/data/data/com.termux/files/usr/bin/bash
# Install the DeepSeek Harness desktop shell into Termux (native Bionic, no proot).
set -euo pipefail

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PREFIX_DIR=${PREFIX:-/data/data/com.termux/files/usr}
TARGET_DIR="${PREFIX_DIR}/share/dsh-desktop"
LAUNCHER="${PREFIX_DIR}/bin/dsh-app"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "检查 Termux 基础环境"
if [ ! -d "/data/data/com.termux/files/usr" ]; then
  echo "这里不是 Termux（未找到 /data/data/com.termux/files/usr）。" >&2
  exit 1
fi

say "启用 X11 仓库并安装 Electron 43 与 Termux:X11 支持"
pkg install -y x11-repo
pkg install -y electron43 termux-x11-nightly

say "检查 Node.js 与 npm"
command -v node >/dev/null || pkg install -y nodejs
command -v npm  >/dev/null || pkg install -y nodejs
node --version
npm --version

say "安装 DeepSeek Harness 的 npm 包"
if command -v dsh >/dev/null 2>&1; then
  echo "已检测到 dsh：$(command -v dsh)"
  dsh --version || true
else
  npm install -g @deepseek-ai/dsh@latest
fi

say "部署桌面外壳"
mkdir -p "${TARGET_DIR}"
rm -rf "${TARGET_DIR}/app"
cp -R "${REPO_DIR}/app" "${TARGET_DIR}/app"
install -Dm755 "${REPO_DIR}/bin/dsh-app" "${LAUNCHER}"

say "完成"
cat <<MESSAGE
启动方式：
  1. 先安装 Termux:X11 的 APK（termux-x11-universal-debug.apk），并打开一次。
  2. 在 Termux 里运行：dsh-app
启动器会在未设置 DISPLAY 时自动拉起 termux-x11 :0。

常用参数：
  dsh-app --devtools              打开开发者工具
  dsh-app --url http://127.0.0.1:3080   连接已经在跑的 Web UI
  DSH_APP_FLAGS="--disable-gpu" dsh-app   覆盖 Chromium 开关
MESSAGE
