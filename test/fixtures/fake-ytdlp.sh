#!/usr/bin/env bash
# fake-ytdlp.sh（doc/bugs/12 D14 机读协议 fixture 假引擎）
#
# 用途：CI/无真引擎环境下锁定 yt-dlp progress-template 机读协议——按
# src/download/engines/ytdlp.ts YTDLP_PROGRESS_TEMPLATE 的 6 字段 `|` 分隔
# 格式吐 3 行进度后 exit 0。测试以本脚本充当 command 走 spawnDetachedEngine
# 真实 spawn 路径（stdio 文件化 + 尾读解析），协议漂移（模板/parser/假引擎
# 三方任一改动不一致）即红。creepjs-baseline 同款「fixture 锁协议」先例。
#
# 格式锚（与真实 yt-dlp --newline --progress-template 输出同形）：
#   download:<videoId>|<percent>|<downloaded>|<total>|<speed>|<eta>
printf '%s\n' \
  'download:fak3vid1d| 10.0%|  1048576|  10485760|    2.00MiB/s|    00:04' \
  'download:fak3vid1d| 55.0%|  5767168|  10485760|    2.00MiB/s|    00:02' \
  'download:fak3vid1d|100.0%| 10485760|  10485760|    2.00MiB/s|    00:00'
exit 0
