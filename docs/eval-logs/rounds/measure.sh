#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
ROOT=$ROOK_ROOT/usr/lib/rook/rook
pids=$(pgrep -f "$ROOT" | tr '\n' ' ')
echo "pids=$pids"
rss=0; pss=0; n=0
for p in $pids; do
  r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null); r=${r:-0}
  s=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null); s=${s:-0}
  rss=$((rss+r)); pss=$((pss+s)); n=$((n+1))
done
echo "spaces=$(pgrep -af "$ROOT" | wc -l) procs=$n rss_mib=$((rss/1024)) pss_mib=$((pss/1024))"
HZ=$(getconf CLK_TCK)
cpu1=0; for p in $pids; do v=$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null); cpu1=$((cpu1+${v:-0})); done
sleep 5
cpu2=0; for p in $pids; do v=$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null); cpu2=$((cpu2+${v:-0})); done
echo "idle_cpu_pct=$(awk -v d=$((cpu2-cpu1)) -v hz=$HZ 'BEGIN{printf "%.2f", d/hz/5*100}')"
