#!/usr/bin/env bash
set -euo pipefail

bash /app/fish/napcat-init.sh
# 保留官方镜像的解压、权限设置和 QQ 启动流程。
cd /app
exec bash /app/entrypoint.sh "$@"
