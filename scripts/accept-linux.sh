#!/usr/bin/env bash
# Run in an isolated checkout with sibling zhilume-worker and zhilume-studio.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$(uname -s)" == Linux ]] || { echo '需要 Linux 环境'; exit 1; }
command -v node >/dev/null
command -v npm >/dev/null
command -v uv >/dev/null
command -v "${ZHILUME_FFMPEG:-ffmpeg}" >/dev/null || { echo 'CPU 媒体验收需要 FFmpeg'; exit 1; }
[[ -f ../zhilume-worker/uv.lock && -d ../zhilume-studio/src/contracts ]] || { echo '请在同级准备 Studio 和 Worker 仓库'; exit 1; }
# No user Server, cloud credentials, ComfyUI process or GPU weights are used.
# Tests create isolated temporary servers and use fake ComfyUI responses.
unset ZHILUME_SERVER ZHILUME_ENROLLMENT ZHILUME_COMFY_CONFIG ZHILUME_ENABLE_IMAGE ZHILUME_TEST_PYTHON
(cd ../zhilume-worker && bash deploy/install.sh && uv run --no-sync python -m unittest discover -s tests -v)
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build
npm test
echo 'Linux CPU/协议与测试 ComfyUI 验收通过；不代表云端网络或真实 GPU 推理通过。'
