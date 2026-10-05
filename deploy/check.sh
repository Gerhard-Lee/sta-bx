#!/bin/sh
# 部署后的分层自检：SMTP 出口 → 中继存活与鉴权 → 真发一封 → 队列与开关 → 定时入口。
# 用法：cd 到部署目录（有 docker-compose.yml 和 .env 的那一层）后执行
#   sh /opt/stabx/deploy/check.sh
# 任何一项 FAIL 都会让脚本以非 0 退出，方便接进监控。
set -u
[ -f .env ] && { set -a; . ./.env; set +a; }
fail=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
smtp_host="${SMTP_HOST:-smtp.qq.com}"; smtp_port="${SMTP_PORT:-465}"

# 1 SMTP 出口：云服务器默认封 25，必须走 465（或 587）
if openssl s_client -connect "${smtp_host}:${smtp_port}" -brief </dev/null >/dev/null 2>&1; then
  ok "SMTP ${smtp_host}:${smtp_port} 可达"
else
  bad "SMTP ${smtp_host}:${smtp_port} 不通（检查安全组出方向；25 端口在阿里云默认受限）"
fi

# 2 中继存活：在容器内部自测，不依赖任何公网端口
if docker compose exec -T mail-relay node -e "fetch('http://127.0.0.1:8080/health').then((r)=>process.exit(r.ok?0:1))" >/dev/null 2>&1; then
  ok "mail-relay /health"
else
  bad "mail-relay 未就绪（docker compose logs mail-relay）"
fi

# 3 鉴权：不带 Bearer 必须 401，带错密钥也必须 401
code=$(docker compose exec -T mail-relay node -e "fetch('http://127.0.0.1:8080/send',{method:'POST',body:'{}'}).then((r)=>console.log(r.status))" 2>/dev/null | tail -1)
if [ "$code" = "401" ]; then ok "中继拒绝未授权请求"; else bad "中继鉴权异常（返回 ${code:-无}）"; fi

# 4 真发一封测试信（占用一封配额；收件人默认就是发件账号自己）
if [ -n "${EMAIL_RELAY_TOKEN:-}" ] && [ -n "${EMAIL_FROM:-}" ]; then
  code=$(docker compose exec -T -e EMAIL_RELAY_TOKEN -e EMAIL_FROM -e SMTP_USER mail-relay node -e "
    fetch('http://127.0.0.1:8080/send',{method:'POST',headers:{authorization:'Bearer '+process.env.EMAIL_RELAY_TOKEN,'content-type':'application/json'},
      body:JSON.stringify({from:process.env.EMAIL_FROM,to:process.env.SMTP_USER,subject:'【财务报销平台】中继自检',html:'<p>这是一封部署自检邮件，收到即表示发信通道可用。</p>'})})
      .then((r)=>r.text().then((t)=>console.log(r.status+' '+t)))" 2>/dev/null | tail -1)
  case "$code" in
    200*) ok "中继已受理测试信（去 ${SMTP_USER} 收件箱确认）" ;;
    *) bad "中继发信失败：${code:-无响应}" ;;
  esac
else
  bad "跳过发信测试：.env 里缺 EMAIL_RELAY_TOKEN 或 EMAIL_FROM"
fi

# 5 队列与开关
docker compose exec -T db psql -U postgres -d postgres -c \
  "select email_notify_enabled as 总开关 from public.settings where id = 1;" || bad "读取开关失败"
docker compose exec -T db psql -U postgres -d postgres -c \
  "select status as 队列状态, count(*) as 封数 from public.notifications group by status order by status;" || bad "读取队列失败"
docker compose exec -T db psql -U postgres -d postgres -c \
  "select count(*) filter (where email is not null) as 已绑定邮箱人数, count(*) filter (where active) as 启用成员数 from public.app_users;" || bad "读取绑定情况失败"

# 6 定时入口（需要 /etc/stabx-notify.env 已就位；没配 cron 时这一步可以手工跑）
if [ -f "${STABX_NOTIFY_ENV:-/etc/stabx-notify.env}" ]; then
  if sh "$(dirname "$0")/drain.sh" >/dev/null 2>&1; then ok "定时入口 send_notifications 调用成功"; else bad "定时入口调用失败（CRON_SECRET 与函数密钥不一致？函数未重新部署？）"; fi
else
  bad "跳过定时入口：缺少 /etc/stabx-notify.env"
fi

[ "$fail" = "0" ] && echo "全部通过" || echo "有项目未通过"
exit "$fail"
