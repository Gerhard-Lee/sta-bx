#!/bin/sh
# 消费邮件队列：由主机 crontab / systemd timer 调用，不需要 pg_cron。
# 走的是 app-api 的定时入口（x-app-cron 头），不借用任何人的登录会话，也只能做这一件事。
# 凭据放在单独的文件里（默认 /etc/stabx-notify.env，权限 600），脚本本身可以进版本库。
set -eu

ENV_FILE="${STABX_NOTIFY_ENV:-/etc/stabx-notify.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少凭据文件 $ENV_FILE（模板见 deploy/drain.env.example）" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${STABX_URL:?缺少 STABX_URL}"
: "${STABX_APIKEY:?缺少 STABX_APIKEY}"
: "${CRON_SECRET:?缺少 CRON_SECRET}"

# -f：非 2xx 时以非 0 退出，让 cron 的邮件/日志能看见失败；--max-time 防止卡住下一次调度。
# 注意：--max-time 必须大于函数侧一轮消费的预算（NOTIFY_MAX_RUNTIME_MS，默认 240 秒）。
# 客户端先超时断开的话，函数来不及把没发送的行退回队列，它们会卡在“发送中”直到租约到期（并多算一次尝试）。
curl -fsS --max-time "${STABX_NOTIFY_TIMEOUT:-300}" -X POST "${STABX_URL%/}/functions/v1/app-api" \
  -H "apikey: ${STABX_APIKEY}" \
  -H "content-type: application/json" \
  -H "x-app-cron: ${CRON_SECRET}" \
  -d '{"action":"send_notifications"}'
