import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
// 自托管的 compose 会注入 {"default":""} 这样的空值：取不到密钥时必须回落到 SERVICE_ROLE_KEY，
// 否则拿着空字符串去请求 PostgREST，会在每个接口上返回难以定位的 401。
const secretKey = (secretKeys ? String(JSON.parse(secretKeys).default ?? '') : '') || (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
const publicBaseUrl = (Deno.env.get('SUPABASE_PUBLIC_URL') ?? '').trim().replace(/\/$/, '')
// 自托管时容器内的 SUPABASE_URL 是内网地址（官方 compose 固定为 http://api-gw:8000），
// 签名文件地址要换成浏览器可达的公网地址；云端部署没有这个变量时保持原样。
const toPublicUrl = (value: string) => (publicBaseUrl && supabaseUrl && value.startsWith(supabaseUrl) ? publicBaseUrl + value.slice(supabaseUrl.length) : value)
function createAdmin(req: Request, requestId: string, action = '', actorId = '') {
  const source = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'].find((key) => req.headers.get(key))
  const address = source ? req.headers.get(source)?.split(',')[0].trim() ?? '' : ''
  const ip = /^[0-9a-fA-F:.]{3,64}$/.test(address) ? address : ''
  return createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { 'x-audit-ip': ip, 'x-audit-ip-source': ip ? source! : '', 'x-audit-action': action, 'x-audit-actor': actorId, 'x-audit-request-id': requestId } },
  })
}
type AdminClient = ReturnType<typeof createAdmin>

// 事件名必须与迁移 notifications.event 的 check 约束和触发器 CASE 分支保持一致。
// 只在“需要有人动手”时发信：审批与付款登记类发给对应身份的成员，退回与补充收款码类发给申请人本人；
// 拒绝、已付款等完结态没有待办，不发邮件。
const NOTIFY_EVENTS: Record<string, string> = {
  '待财委审批': '有新的申请等待财委审批',
  '待主席审批': '有新的申请等待主席审批',
  '退回修改': '您的申请被退回，请修改后重新提交',
  '待补充收款码': '您的申请已通过审批，请补充收款信息',
  '待付款登记': '有新的报销等待付款登记',
}
const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', finance_pending: '待财委审批', chair_pending: '待主席审批',
  changes_requested: '退回修改', rejected: '已拒绝', payment_info_required: '待补充收款码',
  payment_pending: '待付款', paid: '已付款', cancelled: '已撤回',
}
// 每个事件对应“仍然需要有人动手”的状态：领取之后、真正发送之前复核一次。
// 状态已经变了（被别人处理、被撤回、收款人换了）就不要再催，直接把这封标记为已作废。
const NOTIFY_EVENT_STATUS: Record<string, string> = {
  '待财委审批': 'finance_pending',
  '待主席审批': 'chair_pending',
  '退回修改': 'changes_requested',
  '待补充收款码': 'payment_info_required',
  '待付款登记': 'payment_pending',
}
// 队列消费参数与 src/notify-rules.js 中的同名常量保持一致（Edge Function 无法直接引用前端模块）。
const NOTIFY_BATCH = 100
const NOTIFY_ROUNDS = 8
const NOTIFY_CONCURRENCY = 5
const NOTIFY_SEND_TIMEOUT_MS = 15000
const NOTIFY_LEASE_SECONDS = 300
const NOTIFY_MAX_AGE_HOURS = 24
const NOTIFY_MAX_ATTEMPTS = 5
const NOTIFY_BACKOFF_CAP_MINUTES = 60
// 一轮消费最多跑这么久：托管 Edge Functions 的墙钟上限是 150 秒（免费）/400 秒（付费），
// 被墙钟杀掉会让剩余的行卡在“发送中”等租约到期。留出余量，时间用尽时把没动过的行原样退回队列。
const NOTIFY_MAX_RUNTIME_MS = 240000
// 邮件服务返回 429（限频）时暂停本轮、按 Retry-After 稍后重试：这是“等一等就好”，不消耗尝试次数，
// 否则中继的每分钟限频会把正常积压误判成永久失败。
const NOTIFY_THROTTLE_MIN_WAIT_SECONDS = 30
const NOTIFY_THROTTLE_MAX_WAIT_SECONDS = 600

// 定时密钥比较：长度不同直接拒绝（长度本身不是秘密），长度相同时逐字符异或，不因为内容不同而提前返回。
function sameSecret(left: string, right: string) {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index++) diff ^= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function buildNotifyEmail(event: string, app: Record<string, any>, ownerName: string) {
  const appUrl = (Deno.env.get('APP_URL') ?? '').trim()
  const money = `¥${Number(app.amount ?? 0).toFixed(2)}`
  const rows: [string, string][] = [
    ['申请标题', app.title], ['金额', money], ['部门 / 活动', app.department],
    ['费用类别', app.category], ['申请人', ownerName], ['当前状态', STATUS_LABELS[app.status] ?? app.status],
  ]
  const lines = rows.map(([label, value]) => `<p>${escapeHtml(label)}：${escapeHtml(value)}</p>`).join('')
  const link = appUrl ? `<p>登录平台处理：<a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></p>` : ''
  return `<div style="font-family:system-ui,sans-serif;color:#243047"><p>${escapeHtml(NOTIFY_EVENTS[event] ?? '有新的申请动态')}</p>${lines}${link}<p style="color:#637189">本邮件由成都七中科学技术协会财务报销平台自动发送，请勿直接回复。</p></div>`
}

const bucket = 'application-files'
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, x-app-session, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

class HttpError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
})

const ok = (data: unknown) => json({ data, error: null })
const fail = (message: string, status = 400) => json({ data: null, error: { message } }, status)

function getSessionToken(req: Request) {
  const headerToken = req.headers.get('x-app-session')?.trim()
  if (headerToken) return headerToken
  const authorization = req.headers.get('authorization') ?? ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function issueSession(userId: string, admin: AdminClient) {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await admin.from('app_sessions').insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt })
  if (error) throw new Error('登录会话创建失败。')
  return { token, expiresAt }
}

async function actorFromRequest(req: Request, admin: AdminClient) {
  const token = getSessionToken(req)
  if (!token) throw new HttpError('请先登录。', 401)
  const tokenHash = await sha256Hex(token)
  const { data: session, error: sessionError } = await admin
    .from('app_sessions')
    .select('user_id,expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (sessionError) throw new Error('登录状态读取失败。')
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    await admin.from('app_sessions').delete().eq('token_hash', tokenHash)
    throw new HttpError('登录已过期，请重新登录。', 401)
  }
  const { data: user, error: userError } = await admin
    .from('app_users')
    .select('id,username,full_name,department,active,email')
    .eq('id', session.user_id)
    .maybeSingle()
  if (userError || !user) throw new HttpError('账号不存在。', 401)
  if (!user.active) throw new HttpError('账号已停用。', 403)
  const { data: roleRows, error: roleError } = await admin.from('user_roles').select('role').eq('user_id', user.id)
  if (roleError) throw new Error('账号权限读取失败。')
  await admin.from('app_sessions').update({ last_seen_at: new Date().toISOString() }).eq('token_hash', tokenHash)
  return { token, user, roles: (roleRows ?? []).map((row) => row.role as string) }
}

function isSuperAdmin(actor: Awaited<ReturnType<typeof actorFromRequest>>) {
  return actor.roles.includes('admin') && actor.user.username.toLowerCase() === 'admin'
}

function hasRole(actor: Awaited<ReturnType<typeof actorFromRequest>>, role: string) {
  // 付款登记（cashier）视同财委（finance），与 private.app_user_has_role 保持一致。
  return actor.roles.includes(role) || (role !== 'admin' && isSuperAdmin(actor)) || (role === 'cashier' && actor.roles.includes('finance'))
}

function requireRole(actor: Awaited<ReturnType<typeof actorFromRequest>>, role: string) {
  if (!hasRole(actor, role)) throw new HttpError('没有对应操作权限。', 403)
}

async function readRequest(req: Request) {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData()
    const fields: Record<string, unknown> = {}
    for (const [key, value] of form.entries()) {
      if (key !== 'file' && typeof value === 'string') fields[key] = value
    }
    fields.file = form.get('file')
    return fields
  }
  return await req.json()
}

function requiredString(value: unknown, message: string) {
  const text = String(value ?? '').trim()
  if (!text) throw new HttpError(message)
  return text
}

async function handle(req: Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') throw new HttpError('请求方式不支持。', 405)
  const body = await readRequest(req) as Record<string, unknown>
  const action = requiredString(body.action, '缺少操作类型。')
  const requestId = crypto.randomUUID()
  let admin = createAdmin(req, requestId, action)
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args)
    if (result.error) throw new HttpError(result.error.message)
    return result.data
  }
  const audit = async (actorId: string | null, event: string, detail: string, metadata: Record<string, unknown> = {}) => {
    const { error } = await admin.from('audit_logs').insert({ actor_id: actorId, event, detail, metadata })
    if (error) throw new Error('操作日志保存失败。')
  }

  // 队列消费：管理员手动点击和定时任务共用这一段逻辑，两处行为完全一致。
  // 每一轮先向数据库原子领取（批次号 + 租约），两个人同时点也不会把同一封邮件寄两次；
  // 中途被超时打断的批次会连同一次尝试计入下一轮，不会永久卡在“发送中”。
  const drainNotifications = async (actorId: string | null) => {
    const apiUrl = (Deno.env.get('EMAIL_API_URL') ?? '').trim()
    const apiKey = (Deno.env.get('EMAIL_API_KEY') ?? '').trim()
    const emailFrom = (Deno.env.get('EMAIL_FROM') ?? '').trim()
    const { data: settingsRow, error: settingsError } = await admin.from('settings').select('email_notify_enabled').eq('id', 1).single()
    if (settingsError) throw new Error('通知设置读取失败。')
    // 开关优先于密钥：关闭时定时任务不应该因为没配邮件服务而反复失败刷日志。
    if (!settingsRow.email_notify_enabled) return ok({ sent: 0, failed: 0, retried: 0, cancelled: 0, deferred: 0, discarded: 0, skipped: true, rounds: 0, pending: 0, message: '总开关关闭，未发送邮件。' })
    if (!apiUrl || !apiKey || !emailFrom) {
      if (actorId === null) return ok({ sent: 0, failed: 0, retried: 0, cancelled: 0, deferred: 0, discarded: 0, misconfigured: true, rounds: 0, pending: 0, message: '邮件服务尚未配置，本轮未发送。' })
      throw new HttpError('邮件服务尚未配置，请项目负责人为 app-api 配置 EMAIL_API_URL、EMAIL_API_KEY 与 EMAIL_FROM。', 503)
    }
    let sent = 0
    let failed = 0
    let retried = 0
    let cancelled = 0
    let deferred = 0
    let discarded = 0
    let rounds = 0
    const startedAt = Date.now()
    const timeLeft = () => NOTIFY_MAX_RUNTIME_MS - (Date.now() - startedAt)
    let stop = false
    let throttleWait = 0
    while (rounds < NOTIFY_ROUNDS && !stop) {
      if (timeLeft() <= 0) break
      const claimId = crypto.randomUUID()
      const claim = await rpc('app_claim_notifications', { p_claim_id: claimId, p_limit: NOTIFY_BATCH, p_lease_seconds: NOTIFY_LEASE_SECONDS, p_max_age_hours: NOTIFY_MAX_AGE_HOURS, p_max_attempts: NOTIFY_MAX_ATTEMPTS })
      discarded += Number(claim?.discarded ?? 0)
      // 领取时顺带作废的“收件人已经没有该待办身份”的行由数据库判定（private.app_user_has_role），
      // 这里只把它计进管理面板的“已作废”，状态语义与 handler 自己复核出来的作废完全一致。
      cancelled += Number(claim?.cancelled ?? 0)
      const rows: Record<string, any>[] = Array.isArray(claim?.rows) ? claim.rows : []
      if (!rows.length) break
      rounds++
      const [appsResult, recipientsResult] = await Promise.all([
        admin.from('applications').select('id,title,amount,department,category,status,version,owner_id').in('id', [...new Set(rows.map((row) => row.application_id))]),
        admin.from('app_users').select('id,email,full_name,username,active').in('id', [...new Set(rows.map((row) => row.recipient_user_id))]),
      ])
      if (appsResult.error || recipientsResult.error) throw new Error('通知数据读取失败。')
      const ownersResult = await admin.from('app_users').select('id,full_name,username').in('id', [...new Set((appsResult.data ?? []).map((app) => app.owner_id))])
      if (ownersResult.error) throw new Error('通知数据读取失败。')
      const apps = new Map((appsResult.data ?? []).map((app) => [app.id, app]))
      const users = new Map((recipientsResult.data ?? []).map((user) => [user.id, user]))
      const owners = new Map((ownersResult.data ?? []).map((user) => [user.id, user.full_name || user.username]))
      // 写回结果必须同时匹配 id、发送中状态和批次号：租约过期被别的批次领走后就写不进去了。
      // touched 记录本轮真正写回成功的行；收尾时把没动过的行原样退回队列，不让它们卡在“发送中”。
      // 写回失败（PostgREST 出错、网络抖动）不算已处理：该行不进 touched，计数也不加，审计不会虚报。
      const touched = new Set<number>()
      const settle = async (note: Record<string, any>, fields: Record<string, unknown>) => {
        const { error } = await admin.from('notifications').update(fields).eq('id', note.id).eq('status', 'sending').eq('claim_id', claimId)
        if (error) return false
        touched.add(note.id)
        return true
      }
      // 时间用尽或遇到限频时把没发送的行退回队列：不记尝试次数，也不等 5 分钟租约到期。
      const release = (note: Record<string, any>, message: string) => settle(note, {
        status: 'pending', claim_id: null, lease_expires_at: new Date().toISOString(),
        next_attempt_at: new Date(Date.now() + throttleWait * 1000).toISOString(),
        last_error: note.last_error || message,
      })
      const sendOne = async (note: Record<string, any>) => {
        const app = apps.get(note.application_id)
        const recipient = users.get(note.recipient_user_id)
        if (!app) {
          if (await settle(note, { status: 'failed', attempts: note.attempts + 1, last_error: '申请已不存在' })) failed++
          return
        }
        if (!recipient?.email) {
          if (await settle(note, { status: 'failed', attempts: note.attempts + 1, last_error: '收件人邮箱已不存在' })) failed++
          return
        }
        if (!recipient.active) {
          if (await settle(note, { status: 'failed', attempts: note.attempts + 1, last_error: '收件人账号已停用' })) failed++
          return
        }
        // 发送前复核版本：被退回修改后重新提交会升 version，旧版本的提醒指向的是上一次待办。
        // 状态可能绕一圈又回到同一个值（finance_pending → changes_requested → finance_pending），
        // 只比状态会把上一版的旧提醒当成有效待办再寄一次，所以版本不匹配就作废。
        if (typeof app.version === 'number' && app.version !== note.application_version) {
          if (await settle(note, { status: 'cancelled', claim_id: null, last_error: `申请已重新提交（版本 ${note.application_version} → ${app.version}），提醒已作废` })) cancelled++
          return
        }
        // 发送前复核：申请已经离开这个待办状态（被别人处理、被撤回、收款人换了）就不再催，
        // 直接把这封标记为已作废 —— “已作废”不参与去重，之后重新产生待办还能再提醒一次。
        const expectedStatus = NOTIFY_EVENT_STATUS[note.event]
        if (expectedStatus && app.status !== expectedStatus) {
          if (await settle(note, { status: 'cancelled', claim_id: null, last_error: `申请状态已变为「${STATUS_LABELS[app.status] ?? app.status}」，提醒已作废` })) cancelled++
          return
        }
        let errorText = ''
        let throttled = false
        try {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ from: emailFrom, to: recipient.email, subject: `【财务报销平台】${NOTIFY_EVENTS[note.event] ?? '有新的申请动态'}`, html: buildNotifyEmail(note.event, app, owners.get(app.owner_id) ?? '成员') }),
            signal: AbortSignal.timeout(NOTIFY_SEND_TIMEOUT_MS),
          })
          if (response.status === 429) {
            // 限频是“等一等就好”：不计入尝试次数，也不逐封重试，暂停本轮并把剩下的行一起退回。
            throttled = true
            const header = Math.floor(Number(response.headers.get('retry-after') ?? ''))
            const wait = Number.isFinite(header) && header > 0 ? header : 60
            throttleWait = Math.max(throttleWait, Math.min(Math.max(wait, NOTIFY_THROTTLE_MIN_WAIT_SECONDS), NOTIFY_THROTTLE_MAX_WAIT_SECONDS))
          } else if (!response.ok) {
            errorText = `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
          }
        } catch (error) {
          errorText = error instanceof Error ? error.message.slice(0, 200) : '邮件服务请求失败'
        }
        if (throttled) {
          if (await settle(note, {
            status: 'pending', claim_id: null, lease_expires_at: new Date().toISOString(),
            next_attempt_at: new Date(Date.now() + throttleWait * 1000).toISOString(),
            last_error: `邮件服务限频（HTTP 429），${throttleWait} 秒后自动重试`,
          })) retried++
          return
        }
        const attempts = note.attempts + 1
        if (!errorText) {
          if (await settle(note, { status: 'sent', attempts, last_error: '', sent_at: new Date().toISOString() })) sent++
          return
        }
        if (attempts >= NOTIFY_MAX_ATTEMPTS) {
          if (await settle(note, { status: 'failed', attempts, last_error: errorText.slice(0, 300) })) failed++
          return
        }
        if (await settle(note, { status: 'pending', attempts, last_error: errorText.slice(0, 300), next_attempt_at: new Date(Date.now() + Math.min(2 ** attempts, NOTIFY_BACKOFF_CAP_MINUTES) * 60000).toISOString() })) retried++
      }
      for (let index = 0; index < rows.length; index += NOTIFY_CONCURRENCY) {
        if (timeLeft() <= 0 || throttleWait > 0) { stop = true; break }
        await Promise.all(rows.slice(index, index + NOTIFY_CONCURRENCY).map(sendOne))
      }
      if (stop) {
        // 限频或时间用尽：剩下的行（含本批还没轮到的那几个）原样退回队列，不消耗尝试次数。
        // 只有写回成功的才算退回，写回失败的留给租约到期那条路。
        const leftovers = rows.filter((note) => !touched.has(note.id))
        const message = throttleWait > 0 ? '邮件服务限频，本轮未发送' : '本轮时间用尽，已退回队列'
        for (let index = 0; index < leftovers.length; index += NOTIFY_CONCURRENCY) {
          const results = await Promise.all(leftovers.slice(index, index + NOTIFY_CONCURRENCY).map((note) => release(note, message)))
          deferred += results.filter(Boolean).length
        }
      }
    }
    const { count: pendingLeft, error: pendingError } = await admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'pending')
    if (pendingError) throw new Error('通知队列读取失败。')
    await audit(actorId, '发送邮件提醒', `${actorId ? '管理员' : '定时任务'}处理 ${rounds} 轮：发送 ${sent} 封，失败 ${failed} 封，稍后重试 ${retried} 封，作废 ${cancelled} 封，本轮退回 ${deferred} 封，丢弃 ${discarded} 封，剩余待发送 ${pendingLeft ?? 0} 封`)
    return ok({ sent, failed, retried, cancelled, deferred, discarded, rounds, pending: pendingLeft ?? 0 })
  }

  if (action === 'public_settings') {
    const { data, error } = await admin.from('settings').select('registration_enabled').eq('id', 1).single()
    if (error) throw new Error('注册设置读取失败。')
    return ok(data)
  }

  if (action === 'register') {
    const result = await rpc('app_create_user', {
      p_username: requiredString(body.username, '请输入用户名。'),
      p_password: requiredString(body.password, '请输入密码。'),
      p_full_name: String(body.full_name ?? '').trim(),
      p_department: String(body.department ?? '').trim(),
    })
    const session = await issueSession(result.id, admin)
    return ok({ user: result, roles: result.roles ?? [], session })
  }

  if (action === 'login') {
    const result = await rpc('app_login', {
      p_username: requiredString(body.username, '请输入用户名。'),
      p_password: requiredString(body.password, '请输入密码。'),
    })
    if (!result) throw new HttpError('用户名或密码不正确。', 401)
    admin = createAdmin(req, requestId, action, result.id)
    const session = await issueSession(result.id, admin)
    await audit(result.id, '登录账号', '用户 @' + result.username)
    return ok({ user: result, roles: result.roles ?? [], session })
  }

  if (action === 'logout') {
    const actor = await actorFromRequest(req, admin)
    admin = createAdmin(req, requestId, action, actor.user.id)
    await audit(actor.user.id, '退出账号', '用户 @' + actor.user.username)
    await admin.from('app_sessions').delete().eq('token_hash', await sha256Hex(actor.token))
    return ok(null)
  }

  // 定时任务没有用户会话：pg_cron（或控制台 Scheduled Functions）只能调用“消费邮件队列”这一个动作，
  // 并且必须携带与 Edge Function 密钥 CRON_SECRET 完全相同的 x-app-cron 头；其它动作一律要求登录。
  const cronHeader = (req.headers.get('x-app-cron') ?? '').trim()
  if (action === 'send_notifications' && cronHeader) {
    const cronSecret = (Deno.env.get('CRON_SECRET') ?? '').trim()
    if (!cronSecret || !sameSecret(cronHeader, cronSecret)) throw new HttpError('定时密钥不正确。', 401)
    admin = createAdmin(req, requestId, action)
    return await drainNotifications(null)
  }

  const actor = await actorFromRequest(req, admin)
  admin = createAdmin(req, requestId, action, actor.user.id)

  if (action === 'me') return ok({ user: actor.user, roles: actor.roles })

  if (action === 'list_applications') {
    const scope = body.scope === 'team' ? 'team' : 'mine'
    if (scope === 'team' && actor.roles.length === 0) throw new HttpError('没有工作台权限。', 403)
    let query = admin.from('applications').select('*').order('updated_at', { ascending: false })
    if (scope === 'mine') query = query.eq('owner_id', actor.user.id)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return ok(data ?? [])
  }

  if (action === 'create_application') {
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new HttpError('请输入有效金额。')
    const payload = {
      owner_id: actor.user.id,
      title: requiredString(body.title, '请输入申请标题。').slice(0, 120),
      purpose: requiredString(body.purpose, '请输入用途说明。').slice(0, 5000),
      amount,
      category: requiredString(body.category, '请输入费用类别。').slice(0, 80),
      department: requiredString(body.department, '请输入部门或活动。').slice(0, 80),
      use_date: requiredString(body.use_date, '请选择使用日期。'),
      status: 'draft',
      version: 0,
    }
    const { data, error } = await admin.from('applications').insert(payload).select().single()
    if (error) throw new Error(error.message)
    return ok(data)
  }

  if (action === 'update_application') {
    const id = requiredString(body.id, '缺少申请编号。')
    const payload = {
      title: requiredString(body.title, '请输入申请标题。').slice(0, 120),
      purpose: requiredString(body.purpose, '请输入用途说明。').slice(0, 5000),
      amount: Number(body.amount),
      category: requiredString(body.category, '请输入费用类别。').slice(0, 80),
      department: requiredString(body.department, '请输入部门或活动。').slice(0, 80),
      use_date: requiredString(body.use_date, '请选择使用日期。'),
    }
    if (!Number.isFinite(payload.amount) || payload.amount <= 0 || payload.amount > 10000000) throw new HttpError('请输入有效金额。')
    const { data, error } = await admin.from('applications').update(payload).eq('id', id).eq('owner_id', actor.user.id).in('status', ['draft', 'changes_requested', 'cancelled']).select().single()
    if (error) throw new Error(error.message)
    return ok(data)
  }

  if (action === 'get_application') {
    const id = requiredString(body.id, '缺少申请编号。')
    const { data: application, error: applicationError } = await admin.from('applications').select('*').eq('id', id).maybeSingle()
    if (applicationError) throw new Error(applicationError.message)
    if (!application || (application.owner_id !== actor.user.id && actor.roles.length === 0)) throw new HttpError('申请不存在或无权查看。', 404)
    const [profileResult, fileResult, actionResult, paymentResult] = await Promise.all([
      admin.from('profiles').select('full_name').eq('id', application.owner_id).maybeSingle(),
      admin.from('application_files').select('*').eq('application_id', id).is('removed_at', null).order('created_at'),
      admin.from('approval_actions').select('*').eq('application_id', id).order('created_at', { ascending: false }),
      admin.from('payments').select('*').eq('application_id', id).maybeSingle(),
    ])
    if (fileResult.error || actionResult.error || paymentResult.error) throw new Error('申请详情读取失败。')
    const visibleFiles = (fileResult.data ?? []).filter((file) => !file.pending ||
      (file.kind === 'qr' && application.owner_id === actor.user.id) ||
      (file.kind === 'receipt' && application.owner_id !== actor.user.id && hasRole(actor, 'cashier')))
    return ok({ application, ownerName: profileResult.data?.full_name ?? '成员', files: visibleFiles, actions: actionResult.data ?? [], payment: paymentResult.data ?? null })
  }

  if (['submit_application', 'approve_application', 'return_application', 'reject_application', 'cancel_application'].includes(action)) {
    const functionName = `app_${action}`
    await rpc(functionName, { p_application_id: requiredString(body.application_id, '缺少申请编号。'), p_actor_id: actor.user.id, p_note: String(body.note ?? '').trim() })
    return ok(null)
  }

  if (action === 'remove_file') {
    await rpc('app_remove_application_file', {
      p_application_id: requiredString(body.application_id, '缺少申请编号。'), p_actor_id: actor.user.id,
      p_file_id: requiredString(body.file_id, '缺少文件编号。'),
    })
    return ok(null)
  }

  if (action === 'save_file_draft' || action === 'submit_file_draft') {
    const args = {
      p_application_id: requiredString(body.application_id, '缺少申请编号。'), p_actor_id: actor.user.id,
      p_file_id: requiredString(body.file_id, '请先选择并保存文件。'), p_value: String(body.value ?? '').trim(),
    }
    if (action === 'save_file_draft') await rpc('app_update_workflow_draft', args)
    else await rpc('app_submit_workflow_file', { ...args, p_confirmed: body.confirmed === true })
    return ok(null)
  }

  if (action === 'upload_file') {
    const file = body.file
    if (!(file instanceof File)) throw new HttpError('请选择文件。')
    if (!file.size || file.size > 5 * 1024 * 1024) throw new HttpError('文件不能为空或超过 5 MB。')
    const applicationId = requiredString(body.application_id, '缺少申请编号。')
    const kind = requiredString(body.kind, '缺少文件类型。')
    if (!['attachment', 'qr', 'receipt'].includes(kind)) throw new HttpError('文件类型不支持。')
    if (!['image/png', 'image/jpeg', 'application/pdf'].includes(file.type) || (kind === 'qr' && file.type === 'application/pdf')) throw new HttpError('请选择 PNG、JPG 图片或 PDF 文件。')
    const { data: application, error: applicationError } = await admin.from('applications').select('id,owner_id,status').eq('id', applicationId).maybeSingle()
    if (applicationError || !application) throw new HttpError('申请不存在。', 404)
    if (kind === 'attachment' && (application.owner_id !== actor.user.id || !['draft','changes_requested','cancelled','finance_pending','chair_pending','payment_info_required','payment_pending'].includes(application.status))) throw new HttpError('当前不能修改申请附件。', 403)
    if (kind === 'qr' && (application.owner_id !== actor.user.id || !['payment_info_required','payment_pending'].includes(application.status))) throw new HttpError('当前不能修改收款信息。', 403)
    if (kind === 'receipt' && (application.owner_id === actor.user.id || !hasRole(actor, 'cashier') || !['payment_pending','paid'].includes(application.status))) throw new HttpError('没有付款登记权限。', 403)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file'
    const storagePath = `${application.owner_id}/${applicationId}/${kind}-${crypto.randomUUID()}-${safeName}`
    const upload = await admin.storage.from(bucket).upload(storagePath, new Uint8Array(await file.arrayBuffer()), { upsert: false, contentType: file.type || 'application/octet-stream' })
    if (upload.error) throw new Error(upload.error.message)
    let fileId
    try {
      fileId = await rpc('app_save_workflow_file', {
        p_application_id: applicationId, p_actor_id: actor.user.id, p_kind: kind,
        p_storage_path: storagePath, p_name: file.name, p_mime: file.type,
        p_value: String(body.value ?? (kind === 'qr' ? body.recipient : body.reference) ?? '').trim(),
      })
    } catch (error) {
      await admin.storage.from(bucket).remove([storagePath])
      throw error
    }
    return ok({ path: storagePath, file_id: fileId })
  }

  if (action === 'file_url') {
    const path = requiredString(body.path, '缺少文件地址。')
    const { data: file, error: fileError } = await admin.from('application_files').select('application_id,owner_id,kind,pending').eq('storage_path', path).is('removed_at', null).maybeSingle()
    if (fileError || !file) throw new HttpError('文件不存在。', 404)
    if (file.owner_id !== actor.user.id && actor.roles.length === 0) throw new HttpError('没有权限。', 403)
    if (file.pending && !((file.kind === 'qr' && file.owner_id === actor.user.id) || (file.kind === 'receipt' && file.owner_id !== actor.user.id && hasRole(actor, 'cashier')))) throw new HttpError('没有草稿文件查看权限。', 403)
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, 300)
    if (error) throw new Error(error.message)
    return ok({ signedUrl: toPublicUrl(data.signedUrl) })
  }

  if (action === 'admin_data') {
    requireRole(actor, 'admin')
    const emailServiceReady = Boolean((Deno.env.get('EMAIL_API_URL') ?? '').trim() && (Deno.env.get('EMAIL_API_KEY') ?? '').trim() && (Deno.env.get('EMAIL_FROM') ?? '').trim())
    const [settingResult, auditResult, pendingResult, sendingResult, sentResult, failedResult, cancelledResult] = await Promise.all([
      admin.from('settings').select('threshold,registration_enabled,email_notify_enabled').eq('id', 1).single(),
      admin.from('audit_logs').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'sending'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'sent'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
    ])
    // 队列统计同样是管理面板的一部分：任何一个查询失败都要报错，不能静默显示 0 封。
    if (settingResult.error || auditResult.error || pendingResult.error || sendingResult.error || sentResult.error || failedResult.error || cancelledResult.error) throw new Error('管理数据读取失败。')
    const missingNames = [...new Set((auditResult.data ?? []).filter((row) => !row.username && row.actor_id).map((row) => row.actor_id))]
    const usersResult = missingNames.length ? await admin.from('app_users').select('id,username').in('id', missingNames) : { data: [], error: null }
    if (usersResult.error) throw new Error('用户信息读取失败。')
    const names = new Map((usersResult.data ?? []).map((u) => [u.id, u.username]))
    const logs = (auditResult.data ?? []).map((row) => ({ ...row, username: row.username || names.get(row.actor_id) || '系统' }))
    const failuresResult = await admin.from('notifications')
      .select('id,event,application_id,recipient_user_id,attempts,last_error,created_at')
      .eq('status', 'failed').order('id', { ascending: false }).limit(5)
    if (failuresResult.error) throw new Error('通知队列读取失败。')
    const failureRows = failuresResult.data ?? []
    const recipientsResult = failureRows.length ? await admin.from('app_users').select('id,username').in('id', [...new Set(failureRows.map((row) => row.recipient_user_id))]) : { data: [], error: null }
    if (recipientsResult.error) throw new Error('用户信息读取失败。')
    const failureNames = new Map((recipientsResult.data ?? []).map((user) => [user.id, user.username]))
    // 失败明细只回传事件、尝试次数、原因和账号名，不回传邮箱地址。
    const failures = failureRows.map((row) => ({ id: row.id, event: row.event, attempts: row.attempts, last_error: row.last_error, username: failureNames.get(row.recipient_user_id) ?? '成员', created_at: row.created_at }))
    return ok({
      threshold: settingResult.data.threshold,
      registration_enabled: settingResult.data.registration_enabled,
      email_notify_enabled: settingResult.data.email_notify_enabled,
      email_service_configured: emailServiceReady,
      notifications: { pending: pendingResult.count ?? 0, sending: sendingResult.count ?? 0, sent: sentResult.count ?? 0, failed: failedResult.count ?? 0, cancelled: cancelledResult.count ?? 0 },
      failures,
      audit: logs,
    })
  }

  if (action === 'admin_members') {
    requireRole(actor, 'admin')
    const result = await rpc('app_list_members', {
      p_actor_id: actor.user.id, p_query: String(body.query ?? '').trim(),
      p_role: String(body.role ?? ''), p_active: String(body.active ?? ''),
      p_page: Number(body.page ?? 1), p_page_size: Number(body.page_size ?? 10),
    })
    // 只回传“是否已绑定”，邮箱地址本身不进入管理列表。
    const ids = (result?.profiles ?? []).map((row) => row.id)
    if (ids.length) {
      const { data: emailRows, error: emailError } = await admin.from('app_users').select('id,email').in('id', ids)
      if (emailError) throw new Error('用户信息读取失败。')
      const bound = new Set((emailRows ?? []).filter((row) => row.email).map((row) => row.id))
      result.profiles = result.profiles.map((row) => ({ ...row, has_email: bound.has(row.id) }))
    }
    return ok(result)
  }

  if (action === 'update_registration') {
    requireRole(actor, 'admin')
    if (typeof body.enabled !== 'boolean') throw new HttpError('请选择是否允许注册。')
    await rpc('app_update_registration', { p_actor_id: actor.user.id, p_enabled: body.enabled })
    return ok(null)
  }

  if (action === 'admin_create_user') {
    requireRole(actor, 'admin')
    const result = await rpc('app_admin_create_user', {
      p_actor_id: actor.user.id, p_username: requiredString(body.username, '请输入用户名。'),
      p_password: requiredString(body.password, '请输入初始密码。'), p_full_name: requiredString(body.full_name, '请输入姓名。'),
      p_department: String(body.department ?? '').trim(), p_roles: Array.isArray(body.roles) ? body.roles : [],
      p_email: String(body.email ?? '').trim(),
    })
    return ok(result)
  }

  if (action === 'export_financial' || action === 'export_audit') {
    requireRole(actor, 'admin')
    const start = String(body.start ?? '').trim(), end = String(body.end ?? '').trim()
    const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
    if ((start && !validDate(start)) || (end && !validDate(end)) || (start && end && start > end)) throw new HttpError('请选择有效的日期范围。')
    const table = action === 'export_financial' ? 'payments' : 'audit_logs'
    const rows: Record<string, any>[] = []
    for (let offset = 0; ; offset += 1000) {
      let query = admin.from(table).select(action === 'export_financial' ? '*,applications(*)' : '*').order('created_at').order(action === 'export_financial' ? 'application_id' : 'id').range(offset, offset + 999)
      if (start) query = query.gte('created_at', start + 'T00:00:00+08:00')
      if (end) query = query.lt('created_at', new Date(Date.parse(end + 'T00:00:00+08:00') + 86400000).toISOString())
      const { data, error } = await query
      if (error) throw new Error('导出数据读取失败。')
      rows.push(...(data ?? []))
      if ((data ?? []).length < 1000) break
      if (rows.length >= 100000) throw new HttpError('数据较多，请缩小日期范围后导出。')
    }
    const { data: users, error } = await admin.from('app_users').select('id,username,full_name')
    if (error) throw new Error('用户信息读取失败。')
    const userMap = new Map((users ?? []).map((u) => [u.id, u]))
    const result = rows.map((row) => action === 'export_financial' ? { ...row, applicant: userMap.get(row.applications?.owner_id)?.full_name || '', username: userMap.get(row.applications?.owner_id)?.username || '', operator: userMap.get(row.actor_id)?.username || '' } : { ...row, username: row.username || userMap.get(row.actor_id)?.username || '系统' })
    await audit(actor.user.id, action === 'export_financial' ? '导出财报' : '导出操作日志', `${start || '全部'} 至 ${end || '现在'} · ${result.length} 条`, { start, end, count: result.length })
    return ok({ rows: result, start, end, generated_at: new Date().toISOString() })
  }

  if (action === 'set_member_roles') {
    requireRole(actor, 'admin')
    await rpc('app_set_member_roles', { p_actor_id: actor.user.id, p_user_id: requiredString(body.user_id, '缺少成员编号。'), p_roles: Array.isArray(body.roles) ? body.roles : [], p_active: Boolean(body.active) })
    return ok(null)
  }

  if (action === 'update_threshold') {
    requireRole(actor, 'admin')
    await rpc('app_update_approval_threshold', { p_actor_id: actor.user.id, p_threshold: Number(body.threshold) })
    return ok(null)
  }

  if (action === 'bind_email') {
    // 收件人只能是当前登录账号自己；请求体里的任何用户编号都不参与绑定，数据库层也会再校验一次。
    await rpc('app_bind_email', { p_actor_id: actor.user.id, p_user_id: actor.user.id, p_email: String(body.email ?? '').trim() })
    return ok(null)
  }

  if (action === 'update_email_notify') {
    requireRole(actor, 'admin')
    if (typeof body.enabled !== 'boolean') throw new HttpError('请选择是否启用邮件通知。')
    await rpc('app_update_email_notify', { p_actor_id: actor.user.id, p_enabled: body.enabled })
    return ok(null)
  }

  if (action === 'send_notifications') {
    // 管理员手动消费队列；定时任务走上面的 x-app-cron 入口，两个入口共用同一个 drainNotifications。
    requireRole(actor, 'admin')
    return await drainNotifications(actor.user.id)
  }

  if (action === 'reset_notifications') {
    // 配好邮件服务后，尝试次数用满的提醒可以由管理员重新排队（失败原因保留在队列里）。
    requireRole(actor, 'admin')
    const reset = await rpc('app_reset_failed_notifications', { p_actor_id: actor.user.id })
    return ok({ reset: Number(reset ?? 0) })
  }
  if (action === 'change_password') {
    await rpc('app_change_password', { p_user_id: actor.user.id, p_current_password: requiredString(body.current_password, '请输入当前密码。'), p_new_password: requiredString(body.new_password, '请输入新密码。') })
    return ok(null)
  }

  throw new HttpError('未知操作。', 404)
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (error) {
    if (error instanceof HttpError) return fail(error.message, error.status)
    console.error(error)
    return fail(error instanceof Error ? error.message : '服务暂时不可用。', 500)
  }
})
