export const richTextValue = '第一行：中文 <标题> & 正文\n第二行：保留换行与标点。';
export const richTextRejectedValue = '另一份：正文改写反例';
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function richTextFixture(receipts, {paragraph = false} = {}) {
  const bodies = new Map([['A',''],['B','原有段落\n原有正文']]), writes = new Set();let calls=0;
  return (req,res,url) => {
    if(url.pathname === '/rich-edit' && req.method==='GET') {
      const item=url.searchParams.get('item');
      if(!bodies.has(item)){res.writeHead(404);res.end();return true;}
      const body=bodies.get(item);
      const markup=body?body.split('\n').map(v=>'<p>'+escape(v)+'</p>').join(''):paragraph?'<p><br></p>':'';
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>富文本核对</title><p>正文编辑</p><div role="textbox" aria-label="正文" aria-multiline="true" contenteditable="true" style="white-space:pre-wrap;border:1px solid #888;min-height:100px">${markup}</div><script>document.querySelector('[contenteditable]').oninput=e=>{const sent=e.target.innerText;if(${JSON.stringify(item)}==='B')e.target.textContent='网站改写正文';fetch('/rich-input?item=${item}',{method:'POST',body:JSON.stringify({sent,actual:e.target.innerText,html:e.target.innerHTML})})}</script>`);
      return true;
    }
    if(url.pathname==='/rich-input' && req.method==='POST') {
      const item=url.searchParams.get('item');let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
        if(!bodies.has(item)||writes.has(item)){res.writeHead(429);res.end();return;}
        try{const body=JSON.parse(raw);writes.add(item);bodies.set(item,body.actual);receipts.push({kind:'rich-input',item,...body,at:Date.now()});res.end('ok');}catch{res.writeHead(400);res.end();}
      });return true;
    }
    if(url.pathname==='/v1/chat/completions' && req.method==='POST') {
      let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{try{
        if(++calls>4)throw Error('MODEL_LIMIT');
        const input=JSON.parse(raw),plan=JSON.parse(input.messages.at(-1).content);
        const control=plan.controls?.find(c=>c.role==='textbox'&&c.name==='正文');
        if(!control?.richText || control.textValue===undefined){receipts.push({kind:'rich-observation-rejected',controls:plan.controls});throw Error('RICH_TEXT_MISSING');}
        // B 故意声称成功：产品必须自行核对全文，不能信任此声明。
        const step=plan.previous?{decision:'complete',summary:'声称正文已完成',evidence:['正文'],previous:{id:plan.previous.id,status:'confirmed',evidence:['正文']},action:null}:{decision:'act',summary:'填写纯文本正文',evidence:['正文'],previous:null,action:{kind:'fill',target:{role:'textbox',name:'正文',exact:true},value:new URL(control.frameUrl).searchParams.get('item')==='B'?richTextRejectedValue:richTextValue}};
        receipts.push({kind:'rich-planning',control,previous:plan.previous?.id??null,at:Date.now()});
        const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(chunk({content:JSON.stringify(step)},null)+chunk({},'stop')+'data: [DONE]\n\n');
      }catch(e){receipts.push({kind:'fixture-error',error:e.message});res.writeHead(400);res.end();}});return true;
    }
    return false;
  };
}
