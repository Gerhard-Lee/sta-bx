import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
const secretKey = secretKeys
  ? JSON.parse(secretKeys).default
  : (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
const admin = createClient(supabaseUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

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

async function issueSession(userId: string) {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await admin.from('app_sessions').insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt })
  if (error) throw new Error('登录会话创建失败。')
  return { token, expiresAt }
}

async function actorFromRequest(req: Request) {
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

function requireRole(actor: Awaited<ReturnType<typeof actorFromRequest>>, role: string) {
  if (!actor.roles.includes(role)) throw new HttpError('没有对应操作权限。', 403)
}

async function rpc(name: string, args: Record<string, unknown>) {
  const result = await admin.rpc(name, args)
  if (result.error) throw new Error(result.error.message)
  return result.data
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

  if (action === 'register') {
    const result = await rpc('app_create_user', {
      p_username: requiredString(body.username, '请输入用户名。'),
      p_password: requiredString(body.password, '请输入密码。'),
      p_full_name: String(body.full_name ?? '').trim(),
      p_department: String(body.department ?? '').trim(),
    })
    const session = await issueSession(result.id)
    return ok({ user: result, roles: result.roles ?? [], session })
  }

  if (action === 'login') {
    const result = await rpc('app_login', {
      p_username: requiredString(body.username, '请输入用户名。'),
      p_password: requiredString(body.password, '请输入密码。'),
    })
    if (!result) throw new HttpError('用户名或密码不正确。', 401)
    const session = await issueSession(result.id)
    return ok({ user: result, roles: result.roles ?? [], session })
  }

  if (action === 'logout') {
    const token = getSessionToken(req)
    if (token) await admin.from('app_sessions').delete().eq('token_hash', await sha256Hex(token))
    return ok(null)
  }

  const actor = await actorFromRequest(req)

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
    const { data, error } = await admin.from('applications').update(payload).eq('id', id).eq('owner_id', actor.user.id).in('status', ['draft', 'changes_requested']).select().single()
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
      admin.from('application_files').select('*').eq('application_id', id).order('created_at'),
      admin.from('approval_actions').select('*').eq('application_id', id).order('created_at', { ascending: false }),
      admin.from('payments').select('*').eq('application_id', id).maybeSingle(),
    ])
    if (fileResult.error || actionResult.error || paymentResult.error) throw new Error('申请详情读取失败。')
    return ok({ application, ownerName: profileResult.data?.full_name ?? '成员', files: fileResult.data ?? [], actions: actionResult.data ?? [], payment: paymentResult.data ?? null })
  }

  if (['submit_application', 'approve_application', 'return_application', 'reject_application', 'cancel_application'].includes(action)) {
    const functionName = `app_${action}`
    await rpc(functionName, { p_application_id: requiredString(body.application_id, '缺少申请编号。'), p_actor_id: actor.user.id, p_note: String(body.note ?? '').trim() })
    return ok(null)
  }

  if (action === 'upload_file') {
    const file = body.file
    if (!(file instanceof File)) throw new HttpError('请选择文件。')
    if (file.size > 5 * 1024 * 1024) throw new HttpError('文件不能超过 5 MB。')
    const applicationId = requiredString(body.application_id, '缺少申请编号。')
    const kind = requiredString(body.kind, '缺少文件类型。')
    if (!['attachment', 'qr', 'receipt'].includes(kind)) throw new HttpError('文件类型不支持。')
    const { data: application, error: applicationError } = await admin.from('applications').select('id,owner_id,status').eq('id', applicationId).maybeSingle()
    if (applicationError || !application) throw new HttpError('申请不存在。', 404)
    if (application.owner_id !== actor.user.id && actor.roles.length === 0) throw new HttpError('没有权限。', 403)
    if (kind === 'receipt' && !actor.roles.includes('cashier') && !actor.roles.includes('admin')) throw new HttpError('没有付款登记权限。', 403)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file'
    const storagePath = `${application.owner_id}/${applicationId}/${kind}-${crypto.randomUUID()}-${safeName}`
    const upload = await admin.storage.from(bucket).upload(storagePath, new Uint8Array(await file.arrayBuffer()), { upsert: false, contentType: file.type || 'application/octet-stream' })
    if (upload.error) throw new Error(upload.error.message)
    try {
      if (kind === 'attachment') await rpc('app_add_application_file', { p_application_id: applicationId, p_actor_id: actor.user.id, p_kind: kind, p_storage_path: storagePath, p_name: file.name, p_mime: file.type || 'application/octet-stream' })
      if (kind === 'qr') await rpc('app_submit_payment_info', { p_application_id: applicationId, p_actor_id: actor.user.id, p_recipient: requiredString(body.recipient, '请输入收款人姓名。'), p_storage_path: storagePath, p_name: file.name, p_mime: file.type || 'application/octet-stream' })
      if (kind === 'receipt') await rpc('app_record_payment', { p_application_id: applicationId, p_actor_id: actor.user.id, p_reference: requiredString(body.reference, '请输入支付宝流水号。'), p_storage_path: storagePath, p_name: file.name, p_mime: file.type || 'application/octet-stream' })
    } catch (error) {
      await admin.storage.from(bucket).remove([storagePath])
      throw error
    }
    return ok({ path: storagePath })
  }

  if (action === 'file_url') {
    const path = requiredString(body.path, '缺少文件地址。')
    const { data: file, error: fileError } = await admin.from('application_files').select('application_id,owner_id').eq('storage_path', path).maybeSingle()
    if (fileError || !file) throw new HttpError('文件不存在。', 404)
    if (file.owner_id !== actor.user.id && actor.roles.length === 0) throw new HttpError('没有权限。', 403)
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, 300)
    if (error) throw new Error(error.message)
    return ok({ signedUrl: data.signedUrl })
  }

  if (action === 'admin_data') {
    requireRole(actor, 'admin')
    const [usersResult, rolesResult, settingResult, auditResult] = await Promise.all([
      admin.from('app_users').select('id,username,full_name,department,active').order('full_name'),
      admin.from('user_roles').select('user_id,role'),
      admin.from('settings').select('threshold').eq('id', 1).single(),
      admin.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(50),
    ])
    if (usersResult.error || rolesResult.error || settingResult.error || auditResult.error) throw new Error('管理数据读取失败。')
    return ok({ profiles: usersResult.data ?? [], roles: rolesResult.data ?? [], threshold: settingResult.data.threshold, audit: auditResult.data ?? [] })
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
