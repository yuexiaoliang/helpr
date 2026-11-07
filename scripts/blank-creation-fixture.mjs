import {randomUUID} from 'node:crypto';
export function blankCreationFixture(receipts) {
  const identities=new Map(),drafts=new Map(),submitted=new Set();let calls=0,fills=0;
  const render=(entry,identity,route,body='')=>`<!doctype html><meta charset="utf-8"><title>空白草稿</title><p>公告 ${route?'已创建草稿':''}</p><form method="post" action="${entry}"><label>创建编号<input readonly value="${identity}"></label><label>正文<textarea name="body">${body}</textarea></label>${route?`<a href="${route}">当前草稿</a><a href="${entry}">新建来源</a>`:'<button>创建草稿</button>'}</form>${route?`<script>document.querySelector('textarea').oninput=e=>fetch('/form-input?id=${route.split('/').at(-1)}',{method:'POST',body:e.target.value})</script>`:''}`;
  return (req,res,url)=>{
    if(url.pathname==='/v1/chat/completions'&&req.method==='POST'){
      let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{try{
        if(++calls>4)throw Error('MODEL_LIMIT');
        const input=JSON.parse(raw),plan=JSON.parse(input.messages.at(-1).content),text=input.messages.at(-2).content;
        const identity=plan.controls?.find(c=>c.name==='创建编号'),field=plan.controls?.find(c=>c.name==='正文'),arrived=text.includes('已创建草稿');
        if(identity?.readOnly!==true||!identity.textValue||field?.textValue===undefined){receipts.push({kind:'blank-observation-rejected',identity:identity??null,field:field??null,controls:plan.controls});throw Error('IDENTITY_MISSING');}
        let step={decision:'act',summary:'创建空白草稿',evidence:['公告'],previous:null,effect:'draft',action:{kind:'click',target:{role:'button',name:'创建草稿',exact:true}},targetCreation:{rule:'readonly-identity-editor-v1',identity:{name:identity.name,value:identity.textValue},fields:[{name:'正文',value:''}],destination:'公告'}};
        if(arrived)step={decision:field.textValue==='自动续行正文'?'complete':'act',summary:'填写并核对正文',evidence:[field.textValue||'公告'],previous:plan.previous?{id:plan.previous.id,status:'confirmed',evidence:[field.textValue||'公告']}:null,action:field.textValue==='自动续行正文'?null:{kind:'fill',target:{role:'textbox',name:'正文',exact:true},value:'自动续行正文'}};
        receipts.push({kind:'form-planning',identity:identity.textValue,arrived,value:field.textValue,at:Date.now()});
        const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(chunk({content:JSON.stringify(step)},null)+chunk({},'stop')+'data: [DONE]\n\n');
      }catch(e){receipts.push({kind:'fixture-error',error:e.message});res.writeHead(400);res.end();}});return true;
    }
    if(url.pathname==='/form-new'){
      const item=url.searchParams.get('item'),entry=url.pathname+url.search;
      if(req.method==='GET'){
        if(!identities.has(item))identities.set(item,'request-'+randomUUID());
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(render(entry,identities.get(item)));return true;
      }
      if(req.method==='POST'){
        let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
          if(!identities.has(item)||submitted.has(item)||submitted.size>=2){res.writeHead(429);res.end();return;}
          submitted.add(item);const route='/form-post/'+randomUUID(),identity=identities.get(item),body=new URLSearchParams(raw).get('body');
          drafts.set(route,{item,entry,identity:item==='B'?'request-'+randomUUID():identity,body});
          receipts.push({kind:'form-created',route,request:entry,item,identity,body,at:Date.now()});
          receipts.push({kind:'form-redirect',item,to:'/form-middle/'+route.split('/').at(-1)});res.writeHead(303,{Location:'/form-middle/'+route.split('/').at(-1)});res.end();
        });return true;
      }
    }
    if(url.pathname.startsWith('/form-middle/')){const route='/form-post/'+url.pathname.split('/').at(-1);receipts.push({kind:'form-redirect',item:drafts.get(route)?.item,to:route});res.writeHead(302,{Location:route});res.end();return true;}
    if(drafts.has(url.pathname)){const d=drafts.get(url.pathname);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(render(d.entry,d.identity,url.pathname,d.body));return true;}
    if(url.pathname==='/form-input'&&req.method==='POST'){
      let body='';req.on('data',b=>body+=b);req.on('end',()=>{const d=drafts.get('/form-post/'+url.searchParams.get('id'));if(!d||d.item!=='A'||++fills>1){res.writeHead(429);res.end();return;}d.body=body;receipts.push({kind:'form-filled',item:d.item,body,at:Date.now()});res.end('ok');});return true;
    }
    return false;
  };
}
