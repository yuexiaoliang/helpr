// Test oracle / fault fixture only. Never imported by the execution candidate.
import http from 'node:http';import {log,reserve,hash} from './common.mjs';
export async function openProxy({origin,out,readonly=false,loseReceipt=false,onHeld}){
  const sockets=new Set();let held=false;
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,origin);if(url.origin!==origin){res.writeHead(403).end();return;}
      const read=['GET','HEAD','OPTIONS'].includes(req.method),chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks);let data;try{data=JSON.parse(body);}catch{}
      const api=url.searchParams.get('rest_route')||url.pathname,kind=!read&&data?.status==='publish'?'publication':!read&&(api.includes('/media')||api.endsWith('/async-upload.php'))?'upload':'other';
      if(readonly&&!read){log(out,{kind:'fixture-blocked-write',method:req.method,api});res.writeHead(403).end('{}');return;}
      if(kind!=='other')reserve(kind,{api});
      const headers={...req.headers,host:url.host};delete headers['proxy-connection'];
      const upstream=http.request(url,{method:req.method,headers},async response=>{
        if(read){res.writeHead(response.statusCode,response.headers);response.pipe(res);return;}
        const buffers=[];for await(const b of response)buffers.push(b);const bytes=Buffer.concat(buffers);let result;try{result=JSON.parse(bytes);}catch{}
        log(out,{kind:'fixture-upstream-response',method:req.method,api,effect:kind,status:response.statusCode,responseBytes:bytes.length,responseHash:hash(bytes),record:result&&{id:result.id,status:result.status,link:result.link,sourceUrl:result.source_url,title:result.title,content:result.content}});
        if(kind==='publication'&&loseReceipt&&!held){held=true;log(out,{kind:'fixture-receipt-withheld',status:response.statusCode});await onHeld?.();return;}
        res.writeHead(response.statusCode,response.headers);res.end(bytes);
      });upstream.on('error',e=>{log(out,{kind:'fixture-upstream-error',code:e.code});if(!res.headersSent)res.writeHead(502);res.end();});upstream.end(body);
    }catch(e){log(out,{kind:'fixture-error',message:e.message});if(!res.headersSent)res.writeHead(503);res.end();}
  });
  server.on('connect',(req,socket,head)=>{if(req.url!==new URL(origin).host){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)socket.unshift(head);server.emit('connection',socket);});
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}`,close:async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
