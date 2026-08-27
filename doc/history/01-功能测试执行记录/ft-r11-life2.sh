#!/bin/zsh
# ft-r11-life2.sh — R11 T-LIFE 面板（修正版：独立 profile 避免 Chrome singleton；chrome-stop CLI 先于 server 会话；python 计时）
set -u
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
D=doc/17-执行记录
LEDGER=$HOME/.cache/lasso/launched-chromes.json
M() { node $D/ft-r11-meter.mjs 2>/dev/null | grep '^{' ; }
PROBE() { curl -s --noproxy '*' --max-time 3 "http://127.0.0.1:$1/json/version" | head -c 80; }
FRONT() { osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null; }
NOWMS() { python3 -c 'import time; print(int(time.time()*1000))'; }
LED() { node -e "try{const l=require('$LEDGER');console.log(JSON.stringify(l.map(e=>({port:e.port,pid:e.pid,mode:e.launchMode,idleMs:e.idleMs}))))}catch(e){console.log('[]')}"; }

echo "=== T-LIFE2 开始 $(date +%H:%M:%S) ==="
M > $D/ft-r11-life2-res-before.json
echo "FRONT_BEFORE: $(FRONT)"
echo "LEDGER_BEFORE: $(LED)"

echo; echo "--- A: T-LIFE-01/03 双起（独立 profile）+ L-COST-12 ---"
T0=$(NOWMS)
node dist/index.js launch-chrome --port 9229 --mode hidden --profile $HOME/.cache/lasso/ft-p9229 > $D/ft-r11-a1.json 2>&1; echo "A1 exit=$? wall_ms=$(( $(NOWMS) - T0 ))"
cat $D/ft-r11-a1.json
sleep 1
T1=$(NOWMS)
node dist/index.js launch-chrome --port 9230 --profile $HOME/.cache/lasso/ft-p9230 > $D/ft-r11-a2.json 2>&1; echo "A2 exit=$? wall_ms=$(( $(NOWMS) - T1 ))"
cat $D/ft-r11-a2.json
sleep 1
echo "PROBE_9229: $(PROBE 9229)"
echo "PROBE_9230: $(PROBE 9230)"
echo "FRONT_AFTER: $(FRONT)"
echo "LEDGER_A: $(LED)"
echo "FLAGS_9229: $(ps -ww -o command= -p $(node -e "const l=require('$LEDGER');console.log(l.find(e=>e.port===9229)?.pid??'NONE')") 2>/dev/null | tr ' ' '\n' | grep -E '^--(no-startup-window|disable-background|disable-renderer|mute-audio)' | tr '\n' ' ')"
echo "FLAGS_9230: $(ps -ww -o command= -p $(node -e "const l=require('$LEDGER');console.log(l.find(e=>e.port===9230)?.pid??'NONE')") 2>/dev/null | tr ' ' '\n' | grep -E '^--(no-startup-window|disable-background|disable-renderer|mute-audio)' | tr '\n' ' ')"

echo; echo "--- B: T-LIFE-07a/05 chrome-stop 定向 9230 ---"
node dist/index.js chrome-stop --port 9230 2>&1; echo "B exit=$?"
sleep 1
echo "PROBE_9230_AFTER: $(PROBE 9230)"
echo "PROBE_9229_STILL: $(PROBE 9229)"
echo "LEDGER_B: $(LED)"

echo; echo "--- C: T-LIFE-10/11/12 server 会话指向 9229 ---"
LASSO_CDP_PORT=9229 LASSO_LAUNCH_IDLE_MS=0 node $D/ft-r11-life-loggedin.mjs 2>&1 | grep -v "Now using"
echo "LEDGER_C_after_server_exit: $(LED)"
echo "PROBE_9229_after_server_exit: $(PROBE 9229)"

echo; echo "--- D: T-LIFE-07b 空台账幂等 + --all ---"
node dist/index.js chrome-stop --all 2>&1; echo "D-all exit=$?"
node dist/index.js chrome-stop 2>&1; echo "D-noflag exit=$?"

echo; echo "--- E: T-LIFE-08 idle reaper（9231, idle-ms 9000）---"
node dist/index.js launch-chrome --port 9231 --mode hidden --profile $HOME/.cache/lasso/ft-p9231 --idle-ms 9000 > $D/ft-r11-e1.json 2>&1; echo "E-launch exit=$?"
sleep 1; echo "PROBE_9231_ALIVE: $(PROBE 9231)"; echo "LEDGER_E: $(LED)"
LASSO_LAUNCH_IDLE_MS=9000 node $D/ft-r11-life-reaper-watch.mjs 2>&1 | grep -v "Now using" | tail -14

echo; echo "--- F: T-LIFE-09 reaper 禁用 ---"
env LASSO_LAUNCH_IDLE_MS=0 node $D/ft-r11-life-reaper-watch.mjs 2>&1 | grep -v "Now using" >/dev/null; grep -o '"evt":"chrome_idle_reaper_disabled"[^}]*' $D/ft-r11-life-stderr.log | head -1

M > $D/ft-r11-life2-res-after.json
echo "FINAL_LEDGER: $(LED)"
echo "RES_AFTER: $(cat $D/ft-r11-life2-res-after.json | head -c 200)"
echo "=== T-LIFE2 结束 $(date +%H:%M:%S) ==="
