export const richTextValue = '第一行：中文 <标题> & 正文\n第二行：保留换行与标点。';
export const richTextRejectedValue = '另一份：正文改写反例';
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export const richLineValues = {E:richTextValue,A:richTextValue,C:'已有段落替换\n第二行 <中文> & 文本\n第三行结束',B:richTextRejectedValue,F:richTextValue,R:richTextValue,S:Array.from({length:24},(_,i)=>'停止测试第'+(i+1)+'行').join('\n')};
export function richTextLinesFixture(receipts, {frame=false,inline=false}={}) {
  const bodies = new Map([['E',''],['A',''],['C','原有段落\n原有正文'],['B','原有段落\n原有正文'],['F',''],['S',''],['R','']]), counts = new Map();let calls=0;
  const childHTML = item => {
    const body=bodies.get(item),markup=body?body.split('\n').map(v=>'<p>'+escape(v)+'</p>').join(''):'';
    const attrs='role="textbox" aria-label="正文" aria-multiline="true" contenteditable="true" style="white-space:pre-wrap;min-height:100px"';
    return `<!doctype html><html><head><meta charset="utf-8"><title>正文子文档</title><script>const install=()=>{document.querySelector('[contenteditable]').oninput=e=>{const sent=e.target.innerText;if(${JSON.stringify(item)}==='F')parent.document.querySelector('input').focus();parent.fetch('/rich-input?item=${item}',{method:'POST',body:JSON.stringify({sent,actual:e.target.innerText,html:e.target.innerHTML,inputType:e.inputType,active:parent.document.activeElement.tagName==='INPUT'?'外层字段':document.activeElement.getAttribute('aria-label')})});if(${JSON.stringify(item)}==='R'){const owner=frameElement;owner.replaceWith(owner.cloneNode(true));}}};if(document.readyState==='loading')addEventListener('DOMContentLoaded',install,{once:true});else install();</script></head>${item==='C'?'<body '+attrs+'>'+markup+'</body>':'<body><div '+attrs+'>'+markup+'</div></body>'}</html>`;
  };
  return (req,res,url) => {
    if(url.pathname === '/rich-edit' && req.method==='GET') {
      const item=url.searchParams.get('item');
      if(!bodies.has(item)){res.writeHead(404);res.end();return true;}
      const body=bodies.get(item);
      if(inline){
        const child=childHTML(item),srcdoc=['C','R'].includes(item);
        const content=srcdoc?'srcdoc="'+escape(child).replaceAll('"','&quot;')+'"':'src="about:blank"';
        const setup=srcdoc?'':'<script>const child=document.querySelector("iframe").contentDocument;child.documentElement.innerHTML='+JSON.stringify(child).replaceAll('<','\\u003c')+';const script=child.createElement("script");script.textContent=child.querySelector("script").textContent;child.head.append(script);</script>';
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><title>内联子frame编辑</title><iframe title="正文编辑器" ${content} style="width:600px;height:300px"></iframe><input aria-label="外层字段">${setup}`);return true;
      }
      if(frame){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><title>子frame编辑</title><iframe title="正文编辑器" src="/rich-frame?item=${item}" style="width:600px;height:300px"></iframe><input aria-label="外层字段">`);return true;}

      const markup=body?body.split('\n').map(v=>'<p>'+escape(v)+'</p>').join(''):item==='E'?'':'<p><br></p>';
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>富文本核对</title><p>正文编辑</p><div role="textbox" aria-label="正文" aria-multiline="true" contenteditable="true" style="white-space:pre-wrap;border:1px solid #888;min-height:100px">${markup}</div><input aria-label="其它字段"><script>document.querySelector('[contenteditable]').oninput=e=>{const sent=e.target.innerText;if(${JSON.stringify(item)}==='B')e.target.textContent='网站改写正文';if(${JSON.stringify(item)}==='F')document.querySelector('input').focus();fetch('/rich-input?item=${item}',{method:'POST',body:JSON.stringify({sent,actual:e.target.innerText,html:e.target.innerHTML,inputType:e.inputType,active:document.activeElement.getAttribute('aria-label')})})}</script>`);
      return true;
    }
    if(frame && url.pathname==='/rich-frame' && req.method==='GET') {
      const item=url.searchParams.get('item');if(!bodies.has(item)){res.writeHead(404);res.end();return true;}
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(childHTML(item));return true;
    }
    if(url.pathname==='/rich-input' && req.method==='POST') {
      const item=url.searchParams.get('item');let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
        if(!bodies.has(item)||(counts.get(item)||0)>=64){res.writeHead(429);res.end();return;}
        try{const body=JSON.parse(raw);counts.set(item,(counts.get(item)||0)+1);bodies.set(item,body.actual);receipts.push({kind:'rich-input',item,...body,at:Date.now()});res.end('ok');}catch{res.writeHead(400);res.end();}
      });return true;
    }
    if(url.pathname==='/v1/chat/completions' && req.method==='POST') {
      let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{try{
        if(++calls>6)throw Error('MODEL_LIMIT');
        const input=JSON.parse(raw),plan=JSON.parse(input.messages.at(-1).content);
        const control=plan.controls?.find(c=>c.role==='textbox'&&c.name==='正文');
        if(!control?.richText || control.textValue===undefined){receipts.push({kind:'rich-observation-rejected',controls:plan.controls});throw Error('RICH_TEXT_MISSING');}
        // B 故意声称成功：产品必须自行核对全文，不能信任此声明。
        const step=plan.previous?{decision:'complete',summary:'声称正文已完成',evidence:['正文'],previous:{id:plan.previous.id,status:'confirmed',evidence:['正文']},action:null}:{decision:'act',summary:'填写纯文本正文',evidence:['正文'],previous:null,action:{kind:'fill',target:{role:'textbox',name:'正文',exact:true,...(frame?{frameUrl:control.frameUrl}:{})},value:richLineValues[new URL(inline?plan.goal.match(/https?:\/\/[^ ]+/)[0]:control.frameUrl).searchParams.get('item')]}};
        receipts.push({kind:'rich-planning',control,previous:plan.previous?.id??null,at:Date.now()});
        const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(chunk({content:JSON.stringify(step)},null)+chunk({},'stop')+'data: [DONE]\n\n');
      }catch(e){receipts.push({kind:'fixture-error',error:e.message});res.writeHead(400);res.end();}});return true;
    }
    return false;
  };
}
