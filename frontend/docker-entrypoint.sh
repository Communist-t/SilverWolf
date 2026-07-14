#!/bin/sh
set -e

# 通过环境变量注入后端 API 地址和前端基址
# API_BASE: 后端 API 地址（例如 http://localhost:3000 或 https://api.example.com）
# FRONTEND_BASE: 前端页面基址（例如 https://app.example.com）

CONFIG_FILE=/usr/share/nginx/html/config.js

if [ -n "$API_BASE" ]; then
  sed -i "s|window.__SILVER_WOLF_API_BASE__ ?? \"\"|window.__SILVER_WOLF_API_BASE__ ?? \"$API_BASE\"|" "$CONFIG_FILE"
  echo "[frontend] API_BASE set to: $API_BASE"
fi

if [ -n "$FRONTEND_BASE" ]; then
  sed -i "s|window.__SILVER_WOLF_FRONTEND_BASE__ ?? \"\"|window.__SILVER_WOLF_FRONTEND_BASE__ ?? \"$FRONTEND_BASE\"|" "$CONFIG_FILE"
  echo "[frontend] FRONTEND_BASE set to: $FRONTEND_BASE"
fi

exec nginx -g 'daemon off;'
