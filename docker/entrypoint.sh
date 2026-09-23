#!/bin/sh
# 先起 Xvfb 再 exec 业务进程：exec 让 node 顶替 PID 1，
# 这样 docker stop 的 SIGTERM 能落到 server.js 的 stop()，Chromium 正常关闭、
# profile 落盘。少了这一步，容器被杀会留下带锁的脏 profile，下次启动要人工清。
set -e

: "${DISPLAY:=:99}"
NUM="${DISPLAY#:}"
SOCK="/tmp/.X11-unix/X${NUM}"

Xvfb "$DISPLAY" -screen 0 "${GEO_BROWSER_XVFB_SCREEN:-1920x1080x24}" -nolisten tcp \
    >/tmp/xvfb.log 2>&1 &

i=0
while [ ! -e "$SOCK" ] && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.2
done

if [ ! -e "$SOCK" ]; then
    echo "Xvfb 未能启动（DISPLAY=$DISPLAY）" >&2
    cat /tmp/xvfb.log >&2 || true
    exit 1
fi

# profile 挂载点若被宿主以 root 之外的属主创建，Chromium 会写不进去并且只在
# 首次登录时才报错，这里提前失败并说清楚。
if [ -n "${GEO_BROWSER_DATA_DIR:-}" ] && [ ! -w "${GEO_BROWSER_DATA_DIR}" ]; then
    echo "GEO_BROWSER_DATA_DIR=${GEO_BROWSER_DATA_DIR} 不可写：检查挂载目录属主" >&2
    exit 1
fi

exec "$@"
