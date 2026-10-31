#!/usr/bin/env bash
# 一键安装：确保 Node 24（缺失则下载便携包到 .runtime/），再交给 bootstrap.mjs。
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION="${WEIBO_NODE_VERSION:-v24.22.2}"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 24 ]
}

ensure_node() {
  if node_ok; then return 0; fi
  if [ -x ".runtime/node/bin/node" ]; then
    export PATH="$PWD/.runtime/node/bin:$PATH"
    node_ok && return 0
  fi
  local os arch name url
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo "当前系统请改用 install.ps1 或手动安装 Node 24" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
  esac
  name="node-${NODE_VERSION}-${os}-${arch}"
  url="https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz"
  echo "未检测到 Node 24，正在下载便携版：$url"
  mkdir -p .runtime
  curl -fsSL "$url" -o ".runtime/node.tar.gz"
  tar -xzf ".runtime/node.tar.gz" -C .runtime
  mv -f ".runtime/${name}" ".runtime/node"
  rm -f ".runtime/node.tar.gz"
  export PATH="$PWD/.runtime/node/bin:$PATH"
  node_ok || { echo "便携 Node 安装失败" >&2; exit 1; }
}

ensure_node
exec node bootstrap.mjs install "$@"
