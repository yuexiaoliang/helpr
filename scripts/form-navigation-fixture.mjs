import {randomUUID} from 'node:crypto';
export function formNavigationFixture(receipts) {
  const entries=new Map(), drafts=new Map();let calls=0, creates=0, fills=0;
  const render=(route,d)=>`<!doctype html><meta charset="utf-8"><title>草稿编辑</title><p>公告 已创建草稿</p><label>草稿标题<input value="${d.title}"></label><label>正文<textarea>${d.body??''}</textarea></label><a href="${route}">当前草稿</a><a href="/form-new?item=${d.item}">新建来源</a><script>document.querySelector('textarea').oninput=e=>fetch('/form-input?id=${route.split('/').at(-1)}',{method:'POST',body:e.target.value})</script>`;
  return (req,res,url)=>{
    if(url.pathname==='/v1/chat/completions'&&req.method==='POST'){
      let body='';req.on('data',b=>body+=b);req.on('end',()=>{try{
        if(++calls>8)throw Error('MODEL_LIMIT');
        const input=JSON.parse(body),plan=JSON.parse(input.messages.at(-1).content),observed=input.messages.at(-2).content;
        const title=plan.controls?.find(c=>c.name==='草稿标题')?.textValue, value=plan.controls?.find(c=>c.name==='正文')?.textValue;
        if(!title||!observed.includes('公告'))throw Error('FIELDS_MISSING');
        const arrived=observed.includes('已创建草稿');
        let step={decision:'act',summary:'创建草稿',evidence:['公告'],previous:null,effect:'draft',action:{kind:'click',target:{role:'button',name:'创建草稿',exact:true}},targetCreation:{rule:'same-site-editor-v1',fields:[{name:'草稿标题',value:title}],destination:'公告'}};
        if(arrived)step={decision:value==='自动续行正文'?'complete':'act',summary:'填写并核对正文',evidence:[value||'公告'],previous:plan.previous?{id:plan.previous.id,status:'confirmed',evidence:[value||'公告']}:null,action:value==='自动续行正文'?null:{kind:'fill',target:{role:'textbox',name:'正文',exact:true},value:'自动续行正文'}};
        receipts.push({kind:'form-planning',title,arrived,value,at:Date.now()});
        const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(chunk({content:JSON.stringify(step)},null)+chunk({},'stop')+'data: [DONE]\n\n');
      }catch(e){receipts.push({kind:'fixture-error',error:e.message});res.writeHead(400);res.end();}});return true;
    }
    if(url.pathname==='/form-new'){
      const item=url.searchParams.get('item');let route=entries.get(item);if(!route){route='/form-post/'+randomUUID();entries.set(item,route);}
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><title>新建</title><p>公告</p><form method="post" action="${route}"><label>草稿标题<input name="title" value="独立草稿${item}"></label><button>创建草稿</button></form>`);return true;
    }
    if(url.pathname.startsWith('/form-post/')&&req.method==='POST'){
      let body='';req.on('data',b=>body+=b);req.on('end',()=>{
        if(++creates>2||drafts.has(url.pathname)){res.writeHead(429);res.end();return;}
        const item=[...entries].find(([,r])=>r===url.pathname)?.[0],d={item,title:new URLSearchParams(body).get('title')};drafts.set(url.pathname,d);
        receipts.push({kind:'form-created',route:url.pathname,item,title:d.title,at:Date.now()});
        if(item==='B'){receipts.push({kind:'form-redirect',item,to:'/form-middle/'+url.pathname.split('/').at(-1)});res.writeHead(303,{Location:'/form-middle/'+url.pathname.split('/').at(-1)});res.end();}
        else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(render(url.pathname,d));}
      });return true;
    }
    if(url.pathname.startsWith('/form-middle/')){const route='/form-post/'+url.pathname.split('/').at(-1);receipts.push({kind:'form-redirect',item:'B',to:route});res.writeHead(302,{Location:route});res.end();return true;}
    if(drafts.has(url.pathname)){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(render(url.pathname,drafts.get(url.pathname)));return true;}
    if(url.pathname==='/form-input'&&req.method==='POST'){
      let body='';req.on('data',b=>body+=b);req.on('end',()=>{const d=drafts.get('/form-post/'+url.searchParams.get('id'));if(!d||++fills>1){res.writeHead(429);res.end();return;}d.body=body;receipts.push({kind:'form-filled',item:d.item,body,at:Date.now()});res.end('ok');});return true;
    }
    return false;
  };
}
