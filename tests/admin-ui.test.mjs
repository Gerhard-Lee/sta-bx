import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { transform } from 'esbuild';

const effects = [], states = [], requests = [];
globalThis.__adminHooks = {
  React,
  useState(initial) { const state = {value: typeof initial === 'function' ? initial() : initial}; states.push(state); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
  useRef(value) { return {current:value}; },
  useEffect(fn) { effects.push(fn); },
};
globalThis.__adminRequest = async (action,payload) => { requests.push({action,payload}); return {data:action === 'admin_members' ? {profiles:[],total:0,page:1} : {logs:[],total:0,page:1,snapshot:'123',scope:'limited'},error:null}; };
const source = readFileSync('src/admin.jsx','utf8')
  .replace(/import React, \{[^}]+\} from 'react';/, 'const {React,useState,useEffect,useRef} = globalThis.__adminHooks;')
  .replace(/import \{ apiRequest \} from '.\/api.js';/, 'const apiRequest = globalThis.__adminRequest;')
  .replace(/import \{[^}]+\} from '.\/reporting.js';/, "const ROLE_LABEL = {}; const formatDateTime = String, auditDetail = row => row.detail, auditFilterSummary = () => '', downloadExport = () => {};")
  // 邮件提醒改造给 admin.jsx 加了一条模块级依赖；它只在 AdminPanel 里使用，本文件只测两个目录组件，
  // 所以按同一手法换成占位常量，否则 data: 模块解析不了这个相对导入。
  .replace(/import \{[^}]+\} from '.\/notify-rules.js';/, "const NOTIFY_QUEUE = {}, NOTIFY_EVENTS = [], NOTIFY_DEFAULT_EVENTS = [], NOTIFY_EVENT_GROUPS = [], normalizeNotifyEvents = value => value;");
const {code} = await transform(source,{loader:'jsx',format:'esm'});
const {MemberDirectory,AuditDirectory} = await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
async function flushEffects() {
  const cleanup = effects.splice(0).map(fn => fn());
  await new Promise(resolve => setTimeout(resolve,20));
  cleanup.forEach(fn => fn?.());
}
test('成员列表请求完成后可正常更新，不引用日志组件的状态', async () => {
  states.length=0; requests.length=0;
  MemberDirectory({identity:{profile:{id:'manager'}},busy:false,revision:0,onSave:()=>{}});
  await flushEffects();
  assert.equal(requests[0].action,'admin_members');
  assert.equal(states.find(state => state.value?.profiles)?.value.total,0);
});
test('日志组件首次请求建立快照并交给导出状态', async () => {
  states.length=0; requests.length=0;
  let snapshot;
  AuditDirectory({identity:{profile:{username:'manager'}},revision:0,filters:{username:'',event:'',ip:'',start:'',end:''},onFiltersChange:()=>{},onSnapshotChange:value => {snapshot=value;}});
  await flushEffects();
  assert.equal(requests[0].action,'admin_audit');
  assert.equal(requests[0].payload.snapshot,null);
  assert.equal(snapshot,'123');
  assert.equal(states.find(state => state.value?.snapshot)?.value.scope,'limited');
});
