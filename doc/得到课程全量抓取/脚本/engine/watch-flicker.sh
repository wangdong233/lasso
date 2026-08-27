#!/bin/zsh
# P27 闪烁观察器 v2：动态解析 9226 监听 pid（Chrome 重启后不失效）；翻转即记时刻
LOG="../问题集/flicker-watch.log"
LAST="__init__"
while true; do
  PID=$(lsof -ti :9226 -sTCP:LISTEN 2>/dev/null | head -1)
  V=""
  if [ -n "$PID" ]; then
    V=$(osascript -e "tell application \"System Events\"
repeat with p in (application processes whose name is \"Google Chrome\")
if unix id of p is $PID then return visible of p as string
end repeat
end tell" 2>/dev/null)
  fi
  if [ -n "$V" ] && [ "$V" != "$LAST" ]; then
    echo "[$(date '+%H:%M:%S')] pid=$PID visible=$V" >> "$LOG"
    LAST="$V"
  fi
  sleep 0.3
done
