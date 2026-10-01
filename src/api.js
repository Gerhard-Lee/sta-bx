const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const apiUrl = supabaseUrl ? `${supabaseUrl}/functions/v1/app-api` : '';
const SESSION_KEY = 'yuxing_app_session';

export async function apiRequest(action, payload = {}) {
  if (!apiUrl || !supabaseKey) return { data: null, error: { message: '站点尚未配置数据服务。' } };
  const headers = { apikey: supabaseKey, 'Content-Type': 'application/json' };
  const token = localStorage.getItem(SESSION_KEY);
  if (token) headers['x-app-session'] = token;
  try {
    const response = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) });
    const result = await response.json().catch(() => ({ data: null, error: { message: '服务返回了无法识别的结果。' } }));
    return result?.error ? result : { data: result?.data ?? result, error: null };
  } catch (error) { return { data: null, error: { message: error.message || '网络连接失败。' } }; }
}

export async function apiUpload(fields) {
  if (!apiUrl || !supabaseKey) return { data: null, error: { message: '站点尚未配置数据服务。' } };
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => { if (value !== undefined && value !== null) form.append(key, value); });
  form.set('action', 'upload_file');
  const headers = { apikey: supabaseKey };
  const token = localStorage.getItem(SESSION_KEY);
  if (token) headers['x-app-session'] = token;
  try {
    const response = await fetch(apiUrl, { method: 'POST', headers, body: form });
    const result = await response.json().catch(() => ({ data: null, error: { message: '服务返回了无法识别的结果。' } }));
    return result?.error ? result : { data: result?.data ?? result, error: null };
  } catch (error) { return { data: null, error: { message: error.message || '网络连接失败。' } }; }
}
