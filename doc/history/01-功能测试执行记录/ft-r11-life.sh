#!/bin/zsh
# ft-r11-life.sh — R11 T-LIFE 浏览器生命周期面板（串行 + 资源三采样 + 台账核对）
# 端口选择 9229/9230/9231 避开用户 Chrome 已占 9222 与 CC 会话 MCP 树。
set -u
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
D=doc/17-执行记录
LEDGER=~/.cache/lasso/launched-chromes.json
M() { node $D/ft-r11-meter.mjs 2>/dev/null | grep '^{' ; }
PROBE() { curl -s --noproxy '*' --max-time 3 "http://127.0.0.1:$1/json/version" | head -c 200; }
FRONT() { osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null; }

echo "=== T-LIFE 面板开始 $(date +%H:%M:%S) ==="
M > $D/ft-r11-life-res-before.json; echo "RES_BEFORE: $(cat $D/ft-r11-life-res-before.json)"
echo "FRONT_BEFORE: $(FRONT)"
echo "LEDGER_BEFORE: $(cat $LEDGER)"

echo; echo "--- L1: T-LIFE-01 hidden 启动 + L-COST-12 冷启动计时 (port 9229) ---"
T0=$(date +%s%3 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
S=$(date +%s); NS=$(date +%s%N)
node dist/index.js launch-chrome --port 9229 --mode hidden > $D/ft-r11-l1-launch.json 2>$D/ft-r11-l1-launch-stderr.log; RC=$?
NS2=$(date +%s%N); python3 -c "print('L1_LAUNCH_WALL_MS:', ($NS2-$NS)//1000000)"
echo "exit=$RC"; cat $D/ft-r11-l1-launch.json
sleep 1
echo "PROBE_9229: $(PROBE 9229)"
echo "FRONT_AFTER_HIDDEN_LAUNCH: $(FRONT)"
echo "CMDLINE_FLAGS: $(ps -ww -o command= -p $(node -e "const l=require('$HOME/.cache/lasso/launched-chromes.json');const e=l.find(x=>x.port===9229);console.log(e?e.pid:'NONE')") 2>/dev/null | tr ' ' '\n' | grep -E '^--(no-startup-window|start-minimized|disable-background|mute-audio|user-data-dir)' | head -8)"

echo; echo "--- L2: T-LIFE-03 默认档 (port 9230, 不传 --mode) ---"
node dist/index.js launch-chrome --port 9230 > $D/ft-r11-l2-launch.json 2>&1; echo "exit=$?"
cat $D/ft-r11-l2-launch.json
echo "LEDGER_AFTER_L2: $(cat $LEDGER | node -e "const l=JSON.parse(require('fs').readFileSync(0));console.log(JSON.stringify(l.map(e=>({port:e.port,pid:e.pid,mode:e.launchMode,idleMs:e.idleMs,profile:e.profileDir})),null,1))")"

echo; echo "--- L3: T-LIFE-12 tab_restore + T-LIFE-10 活动打点 (server 指向 9230) ---"
LASSO_CDP_PORT=9230 LASSO_LAUNCH_IDLE_MS=0 node $D/ft-r11-life-loggedin.mjs 2>&1 | grep -v "Now using"

echo; echo "--- L4: T-LIFE-07/05 chrome-stop 定向 + 全量 ---"
echo "PROBE_9230_ALIVE: $(PROBE 9230 | head -c 60)"
echo "PROBE_9229_ALIVE: $(PROBE 9229 | head -c 60)"
node dist/index.js chrome-stop --port 9230; echo "stop-9230 exit=$?"
echo "PROBE_9230_AFTER: $(PROBE 9230 | head -c 60)"
echo "PROBE_9229_STILL: $(PROBE 9229 | head -c 60)"
sleep 1
node dist/index.js chrome-stop --all; echo "stop-all exit=$?"
sleep 1
echo "PROBE_9229_AFTER_ALL: $(PROBE 9229 | head -c 60)"
node dist/index.js chrome-stop; echo "stop-empty exit=$?"
echo "LEDGER_FINAL_L4: $(cat $LEDGER)"

echo; echo "--- L5: T-LIFE-08 idle reaper (server env LASSO_LAUNCH_IDLE_MS=9000, port 9231) ---"
node dist/index.js launch-chrome --port 9231 > $D/ft-r11-l5-launch.json 2>&1; echo "launch exit=$?"
sleep 1; echo "PROBE_9231_ALIVE: $(PROBE 9231 | head -c 60)"
echo "LEDGER_L5: $(cat $LEDGER | head -c 300)"
LASSO_LAUNCH_IDLE_MS=9000 node $D/ft-r11-life-reaper-watch.mjs 2>&1 | grep -v "Now using"

echo; echo "--- L6: T-LIFE-09 reaper 禁用日志 ---"
timeout 6 env LASSO_LAUNCH_IDLE_MS=0 node $D/ft-r11-life-reaper-watch.mjs 2>&1 | grep -E "chrome_idle_reaper_disabled" | head -2

M > $D/ft-r11-life-res-after.json; echo "RES_AFTER: $(cat $D/ft-r11-life-res-after.json)"
echo "FINAL_LEDGER: $(cat $LEDGER)"
echo "=== T-LIFE 面板结束 $(date +%H:%M:%S) ==="
