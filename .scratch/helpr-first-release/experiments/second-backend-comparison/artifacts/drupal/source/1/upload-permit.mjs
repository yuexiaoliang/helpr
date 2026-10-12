// 通用、单次文件选择凭据。请求元数据是关联证据，最终文件字节仍须独立核对。
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ensure,hash} from './protocol.mjs';

export async function armUpload({page,target,task,key,execution}) {
  const file=task.inputs[key];ensure(file?.type==='file','upload-input-required');
  const source=await readFile(file.path);ensure(hash(source)===file.sha256,'material-changed');
  const handle=await target.elementHandle(),frame=await handle.ownerFrame();
  const ancestors=[];for(let f=frame;f;f=f.parentFrame())ancestors.push(f);
  const topUrl=page.url(),taskDigest=hash(task);let stale=false,used=false,closed=false;
  const navigation=f=>{if(ancestors.includes(f))stale=true;};page.on('framenavigated',navigation);
  const selection=await handle.evaluateHandle(el=>{
    const state={el,document:el.ownerDocument,url:el.ownerDocument.URL,events:0,files:[],pending:null};
    state.listener=()=>{
      state.events++;
      state.connectedAtSelection=el.isConnected;state.documentAtSelection=el.ownerDocument;
      state.pending=Promise.all([...el.files].map(async f=>({name:f.name,size:f.size,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))}))).then(files=>state.files=files);
    };
    el.addEventListener('input',state.listener,{capture:true});return state;
  });
  const receipt={id:randomUUID(),execution,taskDigest,key,sourceHash:file.sha256,sourceBytes:source.length,topUrl,controlFrame:frame.name()||'main'};
  async function verify() {
    ensure(!closed&&!stale&&page.url()===topUrl&&hash(task)===taskDigest,'upload-permit-stale');
    ensure(hash(await readFile(file.path))===file.sha256,'material-changed');
    const state=await selection.evaluate(async s=>{
      await s.pending;return {events:s.events,connected:s.connectedAtSelection,stillAttached:s.el.isConnected,sameDocument:s.documentAtSelection===s.document&&s.document===document,url:s.document.URL,files:s.files};
    });
    ensure(state.connected&&state.sameDocument&&state.url===await selection.evaluate(s=>s.url),'upload-control-changed',{events:state.events,connectedAtSelection:state.connected,stillAttached:state.stillAttached,sameDocument:state.sameDocument});
    ensure(state.events===1&&state.files.length===1,'upload-selection-changed');
    const f=state.files[0];ensure(f.name===file.name&&f.size===source.length&&hash(Buffer.from(f.bytes))===file.sha256,'upload-selection-mismatch');
    return {events:state.events,connectedAtSelection:state.connected,stillAttached:state.stillAttached,name:f.name,bytes:f.size,sha256:file.sha256};
  }
  async function consume(request) {
    ensure(!used,'upload-permit-consumed');
    ensure(request.headers()['content-type']?.startsWith('multipart/form-data'),'upload-request-type');
    const body=request.postDataBuffer();ensure(body,'upload-request-metadata-missing');
    const filenames=[...body.toString().matchAll(/Content-Disposition:\s*form-data;\s*name="[^"]+";\s*filename="([^"]*)"/gi)].map(m=>m[1]);
    ensure(filenames.length===1&&filenames[0]===file.name,'upload-request-metadata-mismatch');
    ensure(new URL(request.url()).origin===task.origin&&ancestors.includes(request.frame()),'upload-request-frame-mismatch');
    used=true;const selected=await verify();
    return {...receipt,selected,requestFrame:request.frame().name()||'main',exposedBodyBytes:body.length,association:'one active typed upload + exact selected bytes + ancestor frame + exact single filename'};
  }
  return {receipt,verify,consume,close:async()=>{
    closed=true;page.off('framenavigated',navigation);
    await selection.evaluate(s=>s.el.removeEventListener('input',s.listener,{capture:true})).catch(()=>{});
    await selection.dispose();await handle.dispose();
  }};
}
