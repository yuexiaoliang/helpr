// Independent WordPress-specific fixture; candidate must never import this file.
import fs from 'node:fs';import path from 'node:path';
import {here,load,save,ensure,reserve,hash} from './common.mjs';
const [command='public',taskId='L']=process.argv.slice(2),task=load(path.join(here,'tasks.json')).find(t=>t.id===taskId);
ensure(!load(path.join(here,'ledger.json')).closedAt,'STUDY_CLOSED_USE_OFFLINE_VERIFY');
const origin=task.origin,dir=path.join(here,'artifacts/oracle');fs.mkdirSync(dir,{recursive:true});
const read=async(url,options={})=>{reserve('oracleReads',{taskId,url});const r=await fetch(url,options);ensure(r.ok,'oracle-http-'+r.status);return r;};
async function authorization(id){
 const auth=load(path.join(here,'private/auth.json')),cookie=auth.cookies.filter(c=>c.domain===new URL(origin).hostname).map(c=>c.name+'='+c.value).join('; ');
 const html=await (await read(origin+'/wp-admin/post.php?post='+id+'&action=edit',{headers:{cookie}})).text();
 const match=/var wpApiSettings\s*=\s*(\{[^;]+\});/.exec(html);ensure(match,'oracle-nonce-container');const nonce=JSON.parse(match[1]).nonce;ensure(nonce,'oracle-nonce');return {cookie,'X-WP-Nonce':nonce};
}
if(command==='draft'){
 const runs=fs.readdirSync(path.join(here,'artifacts')).filter(f=>f.endsWith('-'+taskId+'-prepare'));
 const replies=runs.flatMap(run=>fs.readFileSync(path.join(here,'artifacts',run,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)).filter(r=>r.kind==='fixture-upstream-response'&&r.record?.status==='draft');
 ensure(replies.length>0,'oracle-no-saved-draft-response');const id=replies.at(-1).record.id,headers=await authorization(id);
 const actual=await (await read(origin+'/?rest_route=/wp/v2/posts/'+id+'&context=edit',{headers})).json();
 const urls=[...actual.content.raw.matchAll(/href="([^"]+)"/g)].map(m=>m[1]).filter(u=>u.endsWith('.xlsx'));const downloads=[];
 for(const url of [...new Set(urls)]){const bytes=Buffer.from(await (await read(url)).arrayBuffer());fs.writeFileSync(path.join(dir,taskId+'-draft-download.xlsx'),bytes);downloads.push({url,sha256:hash(bytes),bytes:bytes.length});}
 const result={at:new Date().toISOString(),taskId,id,status:actual.status,titleMatches:actual.title.raw===task.inputs.post_title.value,bodyMatches:actual.content.raw.includes(task.inputs.post_content.value),categories:actual.categories,downloads,materialMatches:downloads.some(d=>d.sha256===task.inputs.attachment_excel.sha256)};save(path.join(dir,'draft-'+taskId+'.json'),result);console.log(JSON.stringify(result));process.exit(0);
}
const posts=await (await read(origin+'/?rest_route=/wp/v2/posts&per_page=100&search='+encodeURIComponent(task.inputs.post_title.value))).json();
const candidates=posts.filter(p=>p.title.rendered===task.inputs.post_title.value),results=[];
for(const post of candidates){
  const page=await (await read(post.link)).text();fs.writeFileSync(path.join(dir,taskId+'-'+post.id+'.html'),page);
  const urls=[...post.content.rendered.matchAll(/href="([^"]+)"/g)].map(m=>m[1].replaceAll('&amp;','&')).filter(u=>u.endsWith('.xlsx'));const downloads=[];
  for(const url of [...new Set(urls)]){const bytes=Buffer.from(await (await read(url)).arrayBuffer());const sha256=hash(bytes);fs.writeFileSync(path.join(dir,taskId+'-'+post.id+'-'+sha256.slice(0,10)+'.xlsx'),bytes);downloads.push({url,sha256,bytes:bytes.length});}
  results.push({id:post.id,status:post.status,url:post.link,title:post.title.rendered,bodyMatches:post.content.rendered.includes(task.inputs.post_content.value),materialMatches:downloads.some(d=>d.sha256===task.inputs.attachment_excel.sha256),categories:post.categories,downloads});
}
const own=results.filter(r=>r.bodyMatches&&r.materialMatches);
if(command==='external-edit'){
 ensure(own.length===1,'oracle-target-not-unique');reserve('externalEdit',{taskId,id:own[0].id});
 const headers=await authorization(own[0].id);
 const response=await fetch(origin+'/?rest_route=/wp/v2/posts/'+own[0].id,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({content:'外部修改夹具：原正文已替换，本条不再满足原委托。'})});ensure(response.ok,'oracle-edit-failed');save(path.join(dir,'external-edit.json'),{at:new Date().toISOString(),taskId,id:own[0].id,status:response.status,source:'explicit-fault-fixture',changed:'content'});console.log('External edit fixture completed.');
}else{const result={at:new Date().toISOString(),taskId,candidates:results,ownMatches:own.length};save(path.join(dir,taskId+'-'+Date.now()+'.json'),result);console.log(JSON.stringify(result));}
