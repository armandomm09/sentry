#!/usr/bin/env bash
# sentry-doctor.sh — diagnose Sentry camera streaming on a Coolify host.
#
# Coolify names containers <service>-<app-uuid>-<deployment>, so there is nothing
# stable to `docker exec` by hand. This finds the backend container, reports
# stream health, and detects the specific failure mode that used to wedge
# streams silently: ffmpeg processes alive but burning zero CPU, blocked on an
# RTSP socket the camera stopped feeding.
#
# Usage:
#   ./scripts/sentry-doctor.sh            # diagnose only
#   ./scripts/sentry-doctor.sh --probe    # also test-dial every camera's RTSP URL
#   ./scripts/sentry-doctor.sh --restart  # restart the backend if any camera is stalled
set -uo pipefail

PROBE=0
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --probe)   PROBE=1 ;;
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

CONTAINER=$(docker ps --filter "name=^backend-" --format '{{.Names}}' | head -1)
if [[ -z "$CONTAINER" ]]; then
  echo "FAIL: no running container matching 'backend-*'." >&2
  echo "      Is the Sentry stack deployed? Try: docker ps | grep backend" >&2
  exit 1
fi

echo "== contenedor =="
docker ps --filter "name=$CONTAINER" --format '{{.Names}}\t{{.Status}}'
echo

echo "== salud de streams (/health/streams) =="
HEALTH=$(docker exec "$CONTAINER" wget -qO- 'http://localhost:9305/health/streams' 2>/dev/null)
if [[ -z "$HEALTH" ]]; then
  echo "  sin respuesta — backend viejo (sin el endpoint) o proceso caido"
else
  if command -v jq >/dev/null 2>&1; then
    echo "$HEALTH" | jq -r '
      "  estado: \(.status)   total=\(.summary.total) live=\(.summary.live) stalled=\(.summary.stalled)",
      (.cameras[] | "  - \(.name): \(.status)\(if .stalled then "  [ATASCADA]" else "" end)\(if .last_frame_age_seconds != null then "  ultimo frame hace \(.last_frame_age_seconds)s" else "  (sin frames)" end)")'
  else
    echo "$HEALTH"
  fi
fi
echo

# A hung ffmpeg sits in state S with utime/stime frozen. Sample twice: any RTSP
# reader whose CPU counters do not move is blocked, not merely idle.
echo "== ffmpeg colgados (CPU congelado) =="
read_cpu() {
  docker exec "$CONTAINER" sh -c '
    for p in /proc/[0-9]*; do
      pid=${p#/proc/}
      [ -r "$p/cmdline" ] || continue
      tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "rtsp_transport" || continue
      awk "{print \"$pid \" \$14+\$15}" "$p/stat" 2>/dev/null
    done' 2>/dev/null
}
BEFORE=$(read_cpu)
sleep 3
AFTER=$(read_cpu)

HUNG=0
while read -r pid cpu; do
  [[ -z "${pid:-}" ]] && continue
  new=$(echo "$AFTER" | awk -v p="$pid" '$1==p {print $2}')
  [[ -z "$new" ]] && continue           # exited between samples: healthy churn
  if [[ "$new" == "$cpu" ]]; then
    url=$(docker exec "$CONTAINER" sh -c "tr '\0' ' ' < /proc/$pid/cmdline" 2>/dev/null \
          | grep -oE 'rtsp://[^ ]+' | sed -E 's#(rtsp://[^:]+:)[^@]*@#\1***@#')
    echo "  pid $pid SIN CPU en 3s -> $url"
    HUNG=$((HUNG+1))
  fi
done <<< "$BEFORE"
[[ "$HUNG" -eq 0 ]] && echo "  ninguno (todos los lectores RTSP consumen CPU)"
echo

if [[ "$PROBE" -eq 1 ]]; then
  echo "== prueba RTSP directa desde el contenedor =="
  docker exec "$CONTAINER" sh -c '
    sed -n "s/.*\"rtsp_url\": \"\([^\"]*\)\".*/\1/p" /app/data/cameras.json | while read -r url; do
      safe=$(echo "$url" | sed -E "s#(rtsp://[^:]+:)[^@]*@#\1***@#")
      if ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -timeout 8000000 \
           -i "$url" -map 0:v:0 -frames:v 1 -f null - >/dev/null 2>&1; then
        echo "  OK     $safe"
      else
        echo "  FALLA  $safe"
      fi
    done' 2>/dev/null
  echo
fi

STALLED=0
if command -v jq >/dev/null 2>&1 && [[ -n "$HEALTH" ]]; then
  STALLED=$(echo "$HEALTH" | jq -r '.summary.stalled // 0')
fi

if [[ "$RESTART" -eq 1 ]]; then
  if [[ "$STALLED" -gt 0 || "$HUNG" -gt 0 ]]; then
    echo "== reiniciando $CONTAINER (stalled=$STALLED, colgados=$HUNG) =="
    docker restart "$CONTAINER"
  else
    echo "nada que reiniciar."
  fi
fi

# Non-zero exit lets an uptime monitor or cron alert on this.
if [[ "$STALLED" -gt 0 || "$HUNG" -gt 0 ]]; then
  exit 1
fi
exit 0
