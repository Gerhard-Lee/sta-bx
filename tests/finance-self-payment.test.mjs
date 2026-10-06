import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { createSqlStack, rootPath, SQL_STACK_TIMEOUT } from './helpers/sql-stack.mjs';
import { createSqlClient } from './helpers/pglite-supabase-adapter.mjs';

test('财委本人申请须由他人审批，通过后可上传、查看、修改、提交本人付款凭证', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await createSqlStack();
  const buildDir = rootPath('tests', '.tmp', 'finance-self-payment');
  const savedDeno = globalThis.Deno;
  const savedClient = globalThis.__SELF_PAYMENT_CLIENT__;
  try {
    const client = createSqlClient(db);
    // 单次调用有副作用的流程 RPC；通用 adapter 的 pg_typeof(call) 会重复执行 void RPC。
    const originalRpc = client.rpc.bind(client);
    const workflowTypes = {
      app_approve_application: ['uuid', 'uuid', 'text'],
      app_return_application: ['uuid', 'uuid', 'text'],
      app_reject_application: ['uuid', 'uuid', 'text'],
      app_save_workflow_file: ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'text'],
      app_update_workflow_draft: ['uuid', 'uuid', 'uuid', 'text'],
      app_remove_application_file: ['uuid', 'uuid', 'uuid'],
      app_submit_workflow_file: ['uuid', 'uuid', 'uuid', 'text', 'boolean'],
    };
    client.rpc = async (name, args) => {
      if (!workflowTypes[name]) return originalRpc(name, args);
      try {
        const result = await db.query(`select public.${name}(${workflowTypes[name].map((type, i) => `$${i + 1}::${type}`).join(',')}) as result`, Object.values(args));
        return { data: result.rows[0].result, error: null };
      } catch (error) { return { data: null, error: { message: error.message } }; }
    };
    const uploaded = new Map();
    client.storage.from = () => ({
      upload: async (path, bytes) => { uploaded.set(path, bytes); return { error: null }; },
      remove: async (paths) => { paths.forEach((path) => uploaded.delete(path)); return { error: null }; },
      createSignedUrl: async (path) => ({ data: { signedUrl: `https://storage.invalid/${path}` }, error: null }),
    });
    globalThis.__SELF_PAYMENT_CLIENT__ = client;
    let handler;
    globalThis.Deno = {
      env: { get: (key) => ({ SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test-key' })[key] ?? '' },
      serve: (fn) => { handler = fn; },
    };
    await mkdir(buildDir, { recursive: true });
    const stub = `${buildDir}/client.mjs`;
    await writeFile(stub, 'export function createClient() { return globalThis.__SELF_PAYMENT_CLIENT__; }');
    const source = (await readFile(rootPath('supabase/functions/app-api/index.ts'), 'utf8')).replace("from 'npm:@supabase/supabase-js@2'", `from ${JSON.stringify(pathToFileURL(stub).href)}`);
    await writeFile(`${buildDir}/api.mjs`, (await transform(source, { loader: 'ts', format: 'esm' })).code);
    await import(pathToFileURL(`${buildDir}/api.mjs`).href);
    const call = async (token, action, args = {}) => {
      const form = args instanceof FormData;
      if (form) args.set('action', action);
      const response = await handler(new Request('http://localhost/functions/v1/app-api', {
        method: 'POST', headers: { 'x-app-session': token, ...(form ? {} : { 'content-type': 'application/json' }) },
        body: form ? args : JSON.stringify({ action, ...args }),
      }));
      return { status: response.status, ...(await response.json()) };
    };
    const user = async (name, role) => {
      const { rows } = await db.query("select (private.app_insert_user($1, 'Test-only-1369666', $1, '测试')->>'id')::uuid as id", [name]);
      const id = rows[0].id;
      if (role) await db.query('insert into public.user_roles(user_id,role) values ($1,$2)', [id, role]);
      const login = await call('', 'login', { username: name, password: 'Test-only-1369666' });
      assert.equal(login.status, 200);
      return { id, token: login.data.session.token };
    };
    const owner = await user('self_payment_finance', 'finance');
    const reviewer = await user('self_payment_reviewer', 'finance');
    const member = await user('self_payment_member');
    const { rows } = await db.query("insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,rule_threshold) values ($1,'本人申请','测试',20,'物资','测试',current_date,'finance_pending',100) returning id", [owner.id]);
    const id = rows[0].id;
    await db.query("select public.app_bind_email($1,$1,'finance-self@example.com')", [owner.id]);
    await db.query("update public.settings set email_notify_enabled=true where id=1");
    const upload = async (actor, kind, value = '') => {
      const form = new FormData();
      form.set('application_id', id); form.set('kind', kind); form.set('value', value);
      form.set('file', new File(['test-image'], `${kind}.png`, { type: 'image/png' }));
      return call(actor.token, 'upload_file', form);
    };
    for (const action of ['approve_application', 'return_application', 'reject_application']) {
      assert.notEqual((await call(owner.token, action, { application_id: id, note: '不能自审' })).status, 200);
    }
    assert.equal((await upload(owner, 'receipt')).status, 403);
    assert.equal((await call(reviewer.token, 'approve_application', { application_id: id, note: '他人审核通过' })).status, 200);
    assert.equal((await upload(owner, 'receipt')).status, 403, '补收款信息前不能登记付款');
    const qr = await upload(owner, 'qr', '财委本人');
    assert.equal(qr.status, 200, JSON.stringify(qr));
    assert.equal((await call(owner.token, 'submit_file_draft', { application_id: id, file_id: qr.data.file_id, value: '财委本人' })).status, 200);
    assert.equal((await upload(member, 'receipt')).status, 403);
    assert.equal((await db.query("select count(*)::int as n from public.notifications where application_id=$1 and recipient_user_id=$2 and event='待付款登记'", [id, owner.id])).rows[0].n, 1);
    for (const signature of ['app_save_workflow_file(uuid,uuid,text,text,text,text,text)', 'app_update_workflow_draft(uuid,uuid,uuid,text)', 'app_remove_application_file(uuid,uuid,uuid)', 'app_submit_workflow_file(uuid,uuid,uuid,text,boolean)', 'app_record_payment(uuid,uuid,text,text,text,text)']) {
      const { rows } = await db.query("select has_function_privilege('anon',$1,'execute') as anon, has_function_privilege('authenticated',$1,'execute') as authenticated, has_function_privilege('service_role',$1,'execute') as service", [`public.${signature}`]);
      assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true });
    }
    const discarded = await upload(owner, 'receipt');
    assert.equal(discarded.status, 200);
    assert.equal((await call(owner.token, 'remove_file', { application_id: id, file_id: discarded.data.file_id })).status, 200);
    const receipt = await upload(owner, 'receipt', 'PAY-SELF');
    assert.equal(receipt.status, 200, JSON.stringify(receipt));
    assert.equal((await call(owner.token, 'get_application', { id })).data.files.some((f) => f.id === receipt.data.file_id), true);
    assert.equal((await call(owner.token, 'file_url', { path: receipt.data.path })).status, 200);
    assert.equal((await call(member.token, 'file_url', { path: receipt.data.path })).status, 403);
    assert.equal((await call(owner.token, 'save_file_draft', { application_id: id, file_id: receipt.data.file_id, value: 'PAY-SELF-EDITED' })).status, 200);
    const submit = (confirmed) => call(owner.token, 'submit_file_draft', { application_id: id, file_id: receipt.data.file_id, value: 'PAY-SELF-EDITED', confirmed });
    assert.notEqual((await submit(false)).status, 200);
    assert.equal((await submit(true)).status, 200);
    assert.notEqual((await submit(true)).status, 200, '已提交草稿不能重复提交');
    const payment = await db.query('select actor_id,amount,reference from public.payments where application_id=$1', [id]);
    assert.deepEqual(payment.rows, [{ actor_id: owner.id, amount: '20.00', reference: 'PAY-SELF-EDITED' }]);
    const correction = await upload(owner, 'receipt', 'PAY-CORRECTED');
    assert.equal(correction.status, 200);
    assert.equal((await call(owner.token, 'submit_file_draft', { application_id: id, file_id: correction.data.file_id, value: 'PAY-CORRECTED', confirmed: true })).status, 200);
    assert.equal((await db.query('select count(*)::int as n from public.payments where application_id=$1', [id])).rows[0].n, 1);
    assert.equal((await db.query('select status from public.applications where id=$1', [id])).rows[0].status, 'paid');
    // 旧 RPC 同样允许有付款身份的本人，且不能借此提前登记。
    const legacy = await db.query("insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status) values ($1,'旧 RPC','测试',10,'物资','测试',current_date,'finance_pending') returning id", [owner.id]);
    const legacyId = legacy.rows[0].id;
    const legacyArgs = [legacyId, owner.id, 'PAY-LEGACY', `${owner.id}/${legacyId}/receipt.png`, 'receipt.png', 'image/png'];
    await assert.rejects(db.query('select public.app_record_payment($1,$2,$3,$4,$5,$6)', legacyArgs), /当前不能登记付款/);
    await db.query("update public.applications set status='payment_pending' where id=$1", [legacyId]);
    await db.query('select public.app_record_payment($1,$2,$3,$4,$5,$6)', legacyArgs);
    assert.equal((await db.query('select actor_id from public.payments where application_id=$1', [legacyId])).rows[0].actor_id, owner.id);
    await db.query('update public.app_users set active=false where id=$1', [owner.id]);
    assert.notEqual((await upload(owner, 'receipt')).status, 200);
  } finally {
    globalThis.Deno = savedDeno;
    globalThis.__SELF_PAYMENT_CLIENT__ = savedClient;
    await db.close();
    await rm(buildDir, { recursive: true, force: true });
  }
});
