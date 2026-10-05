import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
const secretKey = secretKeys
  ? JSON.parse(secretKeys).default
  : (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
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
    .select('id,username,full_name,department,active')
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

const AUDIT_PAGE_SIZES = [10, 20, 50, 100]
const AUDIT_TEXT_LIMITS: Record<string, number> = { username: 80, event: 80, ip: 64 }
const BEIJING_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The single definition of what an audit-log filter means. The paged table and the
 * export both read it, so the export can never disagree with what the operator saw.
 */
export function readAuditFilters(body: Record<string, unknown>, withPage: boolean) {
  const filters: Record<string, string> = {}
  for (const [key, limit] of Object.entries(AUDIT_TEXT_LIMITS)) {
    const value = String(body[key] ?? '').trim()
    if (value.length > limit) throw new HttpError('搜索条件过长。')
    filters[key] = value
  }
  const validDay = (value: string) => BEIJING_DAY.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  const start = String(body.start ?? '').trim(), end = String(body.end ?? '').trim()
  if ((start && !validDay(start)) || (end && !validDay(end)) || (start && end && start > end)) throw new HttpError('请选择有效的日期范围。')
  filters.start = start
  filters.end = end
  if (!withPage) return { filters, page: 1, pageSize: 0 }
  const rawPage = body.page === undefined || body.page === '' ? 1 : Number(body.page)
  const rawPageSize = body.page_size === undefined || body.page_size === '' ? 20 : Number(body.page_size)
  if (!Number.isInteger(rawPage) || rawPage < 1 || !AUDIT_PAGE_SIZES.includes(rawPageSize)) throw new HttpError('分页参数无效。')
  return { filters, page: rawPage, pageSize: rawPageSize }
}

/** The same predicate the RPC applies, so an export selects exactly the filtered rows. */
export function applyAuditFilters<T extends { ilike: Function; or: Function; gte: Function; lt: Function }>(
  query: T, filters: Record<string, string>, actorIds: string[],
): T {
  const escape = (value: string) => value.replace(/[%_\\]/g, '\\$&')
  let next = query
  if (filters.username) {
    // audit_logs.username is filled on write; the actor fallback keeps rows written
    // before that column existed searchable. Both branches are escaped values only.
    next = actorIds.length
      ? next.or(`username.ilike.%${escape(filters.username)}%,actor_id.in.(${actorIds.join(',')})`)
      : next.ilike('username', `%${escape(filters.username)}%`)
  }
  if (filters.event) next = next.ilike('event', `%${escape(filters.event)}%`)
  if (filters.ip) next = next.ilike('ip_address', `%${escape(filters.ip)}%`)
  if (filters.start) next = next.gte('created_at', filters.start + 'T00:00:00+08:00')
  if (filters.end) next = next.lt('created_at', new Date(Date.parse(filters.end + 'T00:00:00+08:00') + 86400000).toISOString())
  return next
}

/** Operator-facing description of the active filters, reused in the export header row. */
export function auditFilterSummary(filters: Record<string, string>) {
  const parts: string[] = []
  if (filters.username) parts.push(`用户名 含「${filters.username}」`)
  if (filters.event) parts.push(`操作 含「${filters.event}」`)
  if (filters.ip) parts.push(`IP 含「${filters.ip}」`)
  if (filters.start || filters.end) parts.push(`${filters.start || '最早'} 至 ${filters.end || '现在'}`)
  return parts.join(' · ')
}

/** Resolve a username filter to actor ids so rows written before the column existed still match. */
async function auditActorIds(admin: AdminClient, username: string) {
  if (!username) return []
  const { data, error } = await admin.from('app_users').select('id').ilike('username', `%${username.replace(/[%_\\]/g, '\\$&')}%`).limit(200)
  if (error) throw new Error('用户信息读取失败。')
  return (data ?? []).map((row) => row.id as string)
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
  const audit = async (actorId: string, event: string, detail: string, metadata: Record<string, unknown> = {}) => {
    const { error } = await admin.from('audit_logs').insert({ actor_id: actorId, event, detail, metadata })
    if (error) throw new Error('操作日志保存失败。')
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
    return ok({ signedUrl: data.signedUrl })
  }

  if (action === 'admin_data') {
    requireRole(actor, 'admin')
    const [settingResult, auditResult] = await Promise.all([
      admin.from('settings').select('threshold,registration_enabled').eq('id', 1).single(),
      admin.from('audit_logs').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50),
    ])
    if (settingResult.error || auditResult.error) throw new Error('管理数据读取失败。')
    const missingNames = [...new Set((auditResult.data ?? []).filter((row) => !row.username && row.actor_id).map((row) => row.actor_id))]
    const usersResult = missingNames.length ? await admin.from('app_users').select('id,username').in('id', missingNames) : { data: [], error: null }
    if (usersResult.error) throw new Error('用户信息读取失败。')
    const names = new Map((usersResult.data ?? []).map((u) => [u.id, u.username]))
    const logs = (auditResult.data ?? []).map((row) => ({ ...row, username: row.username || names.get(row.actor_id) || '系统' }))
    return ok({ threshold: settingResult.data.threshold, registration_enabled: settingResult.data.registration_enabled, audit: logs })
  }

  if (action === 'admin_members') {
    requireRole(actor, 'admin')
    return ok(await rpc('app_list_members', {
      p_actor_id: actor.user.id, p_query: String(body.query ?? '').trim(),
      p_role: String(body.role ?? ''), p_active: String(body.active ?? ''),
      p_page: Number(body.page ?? 1), p_page_size: Number(body.page_size ?? 10),
    }))
  }

  // Issue #7: search, filter and page the audit log on the server instead of
  // shipping every row to the browser.
  if (action === 'admin_audit') {
    requireRole(actor, 'admin')
    const { filters, page, pageSize } = readAuditFilters(body, true)
    const [paged, events] = await Promise.all([
      rpc('app_list_audit_logs', {
        p_actor_id: actor.user.id, p_username: filters.username, p_event: filters.event,
        p_ip: filters.ip, p_start: filters.start, p_end: filters.end,
        p_page: page, p_page_size: pageSize,
      }),
      rpc('app_audit_log_events', { p_actor_id: actor.user.id }),
    ])
    return ok({ ...(paged as Record<string, unknown>), events: Array.isArray(events) ? events : [], filters })
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
    })
    return ok(result)
  }

  if (action === 'export_financial' || action === 'export_audit') {
    requireRole(actor, 'admin')
    // Issue #7 acceptance: the export reads the same filter object as the log table.
    const auditExport = action === 'export_audit'
    const { filters } = readAuditFilters(body, false)
    const start = auditExport ? filters.start : String(body.start ?? '').trim()
    const end = auditExport ? filters.end : String(body.end ?? '').trim()
    const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
    if ((start && !validDate(start)) || (end && !validDate(end)) || (start && end && start > end)) throw new HttpError('请选择有效的日期范围。')
    const table = action === 'export_financial' ? 'payments' : 'audit_logs'
    const actorIds = auditExport ? await auditActorIds(admin, filters.username) : []
    const rows: Record<string, any>[] = []
    for (let offset = 0; ; offset += 1000) {
      let query = admin.from(table).select(action === 'export_financial' ? '*,applications(*)' : '*').order('created_at').order(action === 'export_financial' ? 'application_id' : 'id').range(offset, offset + 999)
      if (auditExport) query = applyAuditFilters(query, filters, actorIds) as typeof query
      else {
        if (start) query = query.gte('created_at', start + 'T00:00:00+08:00')
        if (end) query = query.lt('created_at', new Date(Date.parse(end + 'T00:00:00+08:00') + 86400000).toISOString())
      }
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
    delete filters.actor_ids
    const scope = auditFilterSummary(filters)
    await audit(actor.user.id, action === 'export_financial' ? '导出财报' : '导出操作日志', `${start || '全部'} 至 ${end || '现在'}${scope ? ' · ' + scope : ''} · ${result.length} 条`, { start, end, count: result.length, filters: auditExport ? filters : undefined })
    return ok({ rows: result, start, end, filters, generated_at: new Date().toISOString() })
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
