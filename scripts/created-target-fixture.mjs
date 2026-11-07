import { randomUUID } from 'node:crypto';
// 结果地址仅在POST接收后生成；模型只读取当前观察，不获知服务端新身份。
export function createdTargetFixture(receipts) {
  const drafts = new Map(); let calls = 0, creates = 0;
  return (req, res, url) => {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body=''; req.on('data', b => {body+=b;}); req.on('end', () => {
        try {
          if (++calls > 8) throw Error('FIXTURE_MODEL_LIMIT');
          const input=JSON.parse(body), plan=JSON.parse(input.messages.at(-1).content);
          const observed=input.messages.at(-2).content;
          const title=plan.controls?.find(c=>c.name==='草稿标题')?.textValue;
          if(!title || !observed.includes('公告')) throw Error('MISSING_CREATION_FIELDS');
          const step={decision:'act',summary:'创建当前草稿',evidence:['公告'],previous:null,effect:'draft',action:{kind:'click',target:{role:'button',name:'创建草稿',exact:true}},targetCreation:{rule:'same-site-editor-v1',fields:[{name:'草稿标题',value:title}],destination:'公告'}};
          receipts.push({kind:'target-planning',title,at:Date.now()});
          const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';
          res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(chunk({content:JSON.stringify(step)},null)+chunk({},'stop')+'data: [DONE]\n\n');
        } catch(e) {receipts.push({kind:'fixture-error',error:e.message});res.writeHead(400);res.end();}
      });return true;
    }
    const item=url.searchParams.get('item');
    if(url.pathname==='/create-draft' && req.method==='POST') {
      let body='';req.on('data',b=>{body+=b;});req.on('end',()=>{
        if(++creates>1){res.writeHead(429);res.end();return;}
        const title=new URLSearchParams(body).get('title'), route='/created/'+randomUUID();
        drafts.set(route,{item,title});receipts.push({kind:'target-created',item,title,route,at:Date.now()});
        res.writeHead(303,{Location:route});res.end();
      });return true;
    }
    if(url.pathname==='/new-draft') {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>新建草稿</title><p>公告</p><form method="post" action="/create-draft?item=${item}"><label>草稿标题<input name="title" value="独立草稿${item}"></label><button>创建草稿</button></form>`);return true;
    }
    if(drafts.has(url.pathname)) {
      const d=drafts.get(url.pathname);
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>已创建草稿</title><p>公告 草稿已保存</p><label>草稿标题<input value="${d.item==='B'?'错误目标':d.title}"></label><label>正文<textarea></textarea></label><a href="${url.pathname}">当前草稿</a><a href="/new-draft?item=${d.item}">新建来源</a>`);return true;
    }
    return false;
  };
}
