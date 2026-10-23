#!/usr/bin/env bash
cd "$(dirname "$0")"
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "  DDrace 3D - 本地服务器"
echo "  本机:      http://localhost:8117"
[ -n "$IP" ] && echo "  局域网:    http://$IP:8117"
echo ""
python3 -m http.server 8117 --bind 0.0.0.0
