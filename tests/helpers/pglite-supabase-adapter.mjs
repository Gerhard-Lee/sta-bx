// PGlite 上的"假 Supabase 客户端"：把 handler 用到的 PostgREST 路径翻译成真实 SQL。
// 只实现 supabase/functions/app-api/index.ts 真正会走到的接口：
//   from(table).select(cols, { count: 'exact', head: true }).eq().in().is().order().limit().range().single()/maybeSingle()
//   from(table).update(fields).eq().eq()      → settle 依赖它返回 { error }
//   from(table).insert(row)                   → audit_logs
//   rpc(name, args)                           → 按 pg_proc 里的声明类型做命名参数调用
// 查询失败一律解析成 { error: { message } }，不抛异常（与真实 PostgREST/supabase-js 行为一致）。

// `id,title` / `*` / `*,applications(*)` → select 列表
function selectColumns(columns) {
  if (columns === '*') return ['*'];
  const list = String(columns).split(',').map((part) => part.trim()).filter((part) => part && !part.includes('('));
  return list.length ? list : ['*'];
}
const selectList = (columns) => selectColumns(columns).join(', ');
const isNullish = (value) => value === null || value === undefined;

class QueryBuilder {
  constructor(client, table, verb) {
    this.client = client;
    this.table = table;
    this.verb = verb;
    this.params = [];
    this.filters = [];
    this.orderings = [];
    this.rowLimit = null;
    this.offset = null;
    this.singleMode = null;
    this.columns = null;
    this.head = false;
    this.rows = null;
    this.fields = null;
  }

  select(columns = '*', options = {}) {
    this.columns = columns;
    this.head = options.head === true;
    return this;
  }
  insert(rows) { this.verb = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(fields) { this.verb = 'update'; this.fields = fields; return this; }
  delete() { this.verb = 'delete'; return this; }

  eq(column, value) { this.filters.push({ type: 'eq', column, value }); return this; }
  in(column, values) { this.filters.push({ type: 'in', column, values: values ?? [] }); return this; }
  is(column, value) { this.filters.push({ type: 'is', column, value }); return this; }
  gte(column, value) { this.filters.push({ type: 'gte', column, value }); return this; }
  lt(column, value) { this.filters.push({ type: 'lt', column, value }); return this; }
  order(column, options = {}) { this.orderings.push({ column, ascending: options.ascending !== false }); return this; }
  limit(count) { this.rowLimit = count; return this; }
  range(from) { this.offset = from; return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }

  // 参数占位符与 this.params 一一对应，调用顺序决定编号。
  param(value) { this.params.push(value); return this.params.length; }

  whereSql() {
    const parts = this.filters.map((filter) => {
      if (filter.type === 'in') {
        const values = filter.values;
        if (!values.length) return 'false';
        const hasNull = values.some(isNullish);
        const bound = values.filter((value) => !isNullish(value));
        const list = bound.length ? `${filter.column} in (${bound.map((value) => `$${this.param(value)}`).join(', ')})` : 'false';
        return hasNull ? `(${list} or ${filter.column} is null)` : list;
      }
      if (filter.type === 'is') {
        if (filter.value === true) return `${filter.column} is true`;
        if (filter.value === false) return `${filter.column} is false`;
        return `${filter.column} is null`;
      }
      // Supabase 把 `eq(col, null)` 翻译成 `col=is.null`。
      if (filter.type === 'eq' && filter.value === null) return `${filter.column} is null`;
      const operator = filter.type === 'eq' ? '=' : filter.type;
      return `${filter.column} ${operator} $${this.param(filter.value)}`;
    });
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }

  orderSql() {
    if (!this.orderings.length) return '';
    return ` order by ${this.orderings.map((item) => `${item.column} ${item.ascending ? 'asc' : 'desc'}`).join(', ')}`;
  }

  async run() {
    if (this.verb === 'select') return await this.runSelect();
    if (this.verb === 'insert') return await this.runInsert();
    if (this.verb === 'update') return await this.runUpdate();
    if (this.verb === 'delete') return await this.runDelete();
    return { data: null, error: { message: `adapter 未实现的动词：${this.verb}` } };
  }

  async query(sql) { return await this.client.db.query(sql, this.params); }

  async runSelect() {
    let sql = `select ${this.head ? 'count(*)::int as count' : selectList(this.columns)} from public.${this.table}`;
    sql += this.whereSql() + this.orderSql();
    if (this.rowLimit !== null) sql += ` limit ${Number(this.rowLimit)}`;
    if (this.offset !== null) sql += ` offset ${Number(this.offset)}`;
    const result = await this.query(sql);
    if (this.head) return { data: null, error: null, count: Number(result.rows[0]?.count ?? 0) };
    return { data: this.singleMode ? (result.rows[0] ?? null) : result.rows, error: null, count: null };
  }

  async runInsert() {
    const rows = this.rows;
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const tuples = rows.map((row) => `(${keys.map((key) => `$${this.param(row[key] ?? null)}`).join(', ')})`);
    let sql = `insert into public.${this.table} (${keys.join(', ')}) values ${tuples.join(', ')}`;
    if (this.columns) sql += ` returning ${selectList(this.columns)}`;
    const result = await this.query(sql);
    if (this.columns) return { data: this.singleMode ? (result.rows[0] ?? null) : result.rows, error: null };
    return { data: null, error: null };
  }

  async runUpdate() {
    const entries = Object.entries(this.fields);
    let sql = `update public.${this.table} set ${entries.map(([key, value]) => `${key} = $${this.param(value)}`).join(', ')}`;
    sql += this.whereSql();
    const result = await this.query(sql);
    return { data: null, error: null, count: result.affectedRows ?? 0 };
  }

  async runDelete() {
    const result = await this.query(`delete from public.${this.table}${this.whereSql()}`);
    return { data: null, error: null, count: result.affectedRows ?? 0 };
  }

  // 链式 builder 被 await 时执行。
  then(resolve, reject) { return this.execute().then(resolve, reject); }

  async execute() {
    // 更新/删除没有过滤条件时 PostgREST 会拒绝；这里同样拒绝，免得测试里误伤全表。
    if ((this.verb === 'update' || this.verb === 'delete') && !this.filters.length) {
      return { data: null, error: { message: `adapter 拒绝没有过滤条件的 ${this.verb}` } };
    }
    // 空的 in 列表在 PostgREST 里返回空集（SQL 里的 `in ()` 是语法错误）。
    if (this.verb === 'select' && !this.head && this.filters.some((filter) => filter.type === 'in' && !filter.values.length)) {
      return { data: this.singleMode ? null : [], error: null, count: null };
    }
    try {
      return await this.run();
    } catch (error) {
      return {
        data: null,
        error: { message: error.message, code: error.code, details: error.detail ?? null, hint: error.hint ?? null },
      };
    }
  }
}

export function createSqlClient(db) {
  // PostgREST 按函数声明的参数类型解析请求：命名参数写进 URL，参数值按声明类型绑定。
  // 这里从 pg_proc 读出同名函数的"参数名 → 声明类型"，再按位置用 `$n::声明类型` 调用，
  // 这样 bigint[]（app_notify_blocked_rows）与 text[]/integer/uuid 都能落在正确的重载上。
  let signaturesCache;
  const signatures = (name) => {
    signaturesCache ??= new Map();
    if (!signaturesCache.has(name)) {
      signaturesCache.set(name, db.query(`
        select p.proname,
               (select coalesce(jsonb_agg(t.name order by t.ord), '[]'::jsonb)
                  from unnest(p.proargnames, p.proargtypes) with ordinality as t(name, type_oid, ord)
                 where t.name is not null) as declared_names,
               (select coalesce(jsonb_agg(format_type(t.type_oid, null) order by t.ord), '[]'::jsonb)
                  from unnest(p.proargnames, p.proargtypes) with ordinality as t(name, type_oid, ord)) as declared_types
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1
      `, [name]).then((result) => result.rows));
    }
    return signaturesCache.get(name);
  };
  const rpcError = (message) => ({ data: null, error: { message, code: null, details: null, hint: null } });

  return {
    db,
    from(table) { return new QueryBuilder({ db }, table, 'select'); },
    async rpc(name, args = {}) {
      const entries = Object.entries(args ?? {});
      try {
        if (!entries.length) {
          const result = await db.query(`select public.${name}() as result`);
          return { data: rpcValue(result.rows[0]), error: null };
        }
        const candidates = (await signatures(name)).filter((row) => {
          const names = row.declared_names ?? [];
          const types = row.declared_types ?? [];
          if (types.length < entries.length) return false;
          return entries.every(([key], index) => names[index] === key || names[index] === undefined);
        });
        const signature = candidates.find((row) => row.declared_names?.length === entries.length) ?? candidates[0];
        if (!signature) throw new Error(`找不到与命名参数匹配的 public.${name} 重载`);
        const types = signature.declared_types.slice(0, entries.length);
        const call = `public.${name}(${types.map((type, index) => `$${index + 1}::${type}`).join(', ')})`;
        const result = await db.query(`select ${call} as result, pg_typeof(${call})::text as result_type`, entries.map(([, value]) => value));
        return { data: rpcValue(result.rows[0]), error: null };
      } catch (error) {
        return rpcError(error.message);
      }
    },
    storage: {
      from() {
        return {
          upload: async () => ({ data: null, error: { message: 'adapter 未实现 storage.upload' } }),
          remove: async () => ({ data: null, error: null }),
          createSignedUrl: async () => ({ data: null, error: { message: 'adapter 未实现 storage.createSignedUrl' } }),
        };
      },
    },
  };
}

// PostgREST 把 jsonb 列原样解析成 JS 值；PGlite 也一样，只有 void 返回的函数会拿到空串，
// 这里还原成 null（与 supabase-js 把 SQL NULL 收成 null 一致）。
function rpcValue(row) {
  if (!row || row.result === undefined || row.result === null) return null;
  if (row.result_type === 'void' || row.result === '') return null;
  return row.result;
}
