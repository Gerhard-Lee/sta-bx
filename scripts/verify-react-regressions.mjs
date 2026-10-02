// Component regression tests with a simulated DOM and an in-memory API; no production writes.
// JSDOM_MODULE points to an isolated installation of jsdom@26.1.0.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const { JSDOM } = await import(pathToFileURL(process.env.JSDOM_MODULE).href);
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ApplicationDetail,ApplicationForm} from './src/workflow.jsx'; import {MemberDirectory} from './src/admin.jsx'; window.testUI={React,createRoot,ApplicationDetail,ApplicationForm,MemberDirectory};`, resolveDir: process.cwd(), loader:'jsx' }, bundle:true, write:false, format:'iife', define:{ 'import.meta.env.VITE_SUPABASE_URL':'"https://fixture.invalid"','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'"fixture"','process.env.NODE_ENV':'"development"' } });
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window; w.IS_REACT_ACT_ENVIRONMENT=true; w.confirm=()=>true; w.TextEncoder=TextEncoder; w.TextDecoder=TextDecoder;
w.MessageChannel=class { constructor(){this.port1={onmessage:null};this.port2={postMessage:()=>setImmediate(()=>this.port1.onmessage?.())};} };
const calls=[]; let fixture;
const members=Array.from({length:23},(_,i)=>({id:`u${i}`,username:i===0?'admin':`member${i}`,full_name:`成员${i}`,department:i%2?'活动部':'技术部',active:i!==22,roles:i===0?['admin']:i%2?['finance']:[]}));
w.fetch=async(_url,options)=>{
  const b=options.body instanceof w.FormData?Object.fromEntries(options.body):JSON.parse(options.body);calls.push(b);let data=null,error=null;
  if(b.action==='get_application') data=structuredClone(fixture);
  if(['create_application','update_application'].includes(b.action)){fixture.application={...fixture.application,...b};data=fixture.application;}
  if(b.action==='submit_application'){fixture.application.status='finance_pending';fixture.application.version++;}
  if(b.action==='upload_file'){
    fixture.files=fixture.files.filter(f=>!(f.pending&&f.kind===b.kind));const id=`file${calls.length}`;
    fixture.files.push({id,name:b.file.name,storage_path:id,kind:b.kind,pending:b.kind!=='attachment',draft_value:b.value});data={file_id:id,path:id};
  }
  if(b.action==='save_file_draft'){const f=fixture.files.find(f=>f.id===b.file_id);if(!f?.pending)error={message:'已提交的文件不能作为草稿保存'};else f.draft_value=b.value;}
  if(b.action==='submit_file_draft'){
    const f=fixture.files.find(f=>f.id===b.file_id);if(!f?.pending)error={message:'草稿不存在'};
    else{f.pending=false;fixture.files=fixture.files.filter(x=>x===f||x.kind!==f.kind);fixture.application.status=b.kind==='qr'?'payment_pending':f.kind==='qr'?'payment_pending':'paid';if(f.kind==='receipt')fixture.payment={amount:19,reference:b.value};}
  }
  if(b.action==='admin_members'){
    let rows=members.filter(u=>(!b.query||`${u.username} ${u.full_name} ${u.department}`.includes(b.query))&&(!b.role||(b.role==='ordinary'?!u.roles.length:u.roles.includes(b.role)))&&(!b.active||u.active===(b.active==='active')));
    const page=Math.min(b.page,Math.max(1,Math.ceil(rows.length/b.page_size)));data={total:rows.length,page,profiles:rows.slice((page-1)*b.page_size,page*b.page_size)};
  }
  return {json:async()=>({data,error})};
};
w.eval(bundle.outputFiles[0].text);const {React,createRoot,ApplicationDetail,ApplicationForm,MemberDirectory}=w.testUI;
const tick=()=>new Promise(r=>setTimeout(r,10)); const act=async(fn)=>React.act(async()=>{await fn();await tick();});
const root=createRoot(w.document.querySelector('#root'));const text=()=>w.document.body.textContent;
const click=async(label)=>{const b=[...w.document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(b,`missing ${label}`);await act(()=>b.click());await act(tick);};
const input=async(selector,value)=>{const el=w.document.querySelector(selector);assert.ok(el,selector);await act(()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new w.Event('input',{bubbles:true}));});};
const select=async(selector,value)=>{const el=w.document.querySelector(selector);await act(()=>{el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));});await act(tick);};
const choose=async(name)=>{const el=w.document.querySelector('input[type=file]');const file=new w.File(['fixture'],name,{type:'application/pdf'});await act(()=>{Object.defineProperty(el,'files',{configurable:true,value:[file]});el.dispatchEvent(new w.Event('change',{bubbles:true}));});};
const owner={profile:{id:'owner',department:'活动部'},roles:[]};const admin={profile:{id:'manager'},roles:['admin']};
fixture={application:{id:'fixture-app',owner_id:'owner',title:'回归申请',purpose:'测试',amount:19,category:'物资',department:'活动部',use_date:'2026-10-02',status:'paid',version:1,recipient:'小林'},files:[],actions:[],payment:{amount:19,reference:'PAY-0'},ownerName:'小林'};
await act(()=>root.render(React.createElement(ApplicationDetail,{id:'fixture-app',identity:admin,onBack:()=>{},onRefresh:()=>{}})));
for(let i=1;i<=3;i++){
  await choose(`receipt${i}.pdf`);await input('.action-block input:not([type])',`PAY-${i}`);
  await act(()=>w.document.querySelector('.action-block input[type=checkbox]').click());
  await click('提交更正');assert.ok(text().includes('付款凭证已更新'));assert.ok(!w.document.querySelector('[role=alert]'));assert.equal(fixture.payment.reference,`PAY-${i}`);assert.equal(w.document.querySelectorAll('.selected-file').length,0);
}
console.log('PASS: same-status paid receipt correction submitted three times without stale drafts');
await act(()=>root.unmount()); const directoryRoot=createRoot(w.document.querySelector('#root'));
await act(()=>directoryRoot.render(React.createElement(MemberDirectory,{identity:admin,busy:false,revision:1,onSave:()=>{}})));
await act(tick);
assert.equal(w.document.querySelectorAll('.member-row').length,10,text());assert.ok(text().includes('23 位用户'));
const protectedRow=[...w.document.querySelectorAll('.member-row')].find(row=>row.textContent.includes('@admin'));
assert.ok(protectedRow.textContent.includes('权限已锁定'));assert.equal(protectedRow.querySelectorAll('input,button').length,0);
await click('下一页');assert.equal(w.document.querySelectorAll('.member-row').length,10);assert.ok(text().includes('2 / 3'));
await click('下一页');assert.equal(w.document.querySelectorAll('.member-row').length,3);
await select('[aria-label="用户角色筛选"]','finance');assert.ok(text().includes('11 位用户'));assert.ok(text().includes('1 / 2'));
await select('[aria-label="账号状态筛选"]','inactive');assert.ok(text().includes('没有符合条件的用户'));
await click('重置');await input('[aria-label="搜索用户"]','技术部');await act(()=>new Promise(r=>setTimeout(r,270)));assert.ok(text().includes('12 位用户'));
console.log('PASS: member search, combined filters, page reset, 23-user pagination and locked admin');
await act(()=>directoryRoot.unmount()); const formRoot=createRoot(w.document.querySelector('#root'));
fixture.application.status='cancelled';
await act(()=>formRoot.render(React.createElement(ApplicationForm,{identity:owner,initial:fixture.application,onDone:()=>{},onCancel:()=>{}})));
await click('正式提交');assert.equal(fixture.application.status,'finance_pending');
console.log('PASS: withdrawn application form resubmits explicitly');
await act(()=>formRoot.unmount());dom.window.close();
