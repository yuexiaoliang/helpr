import './upload-ready-validation.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './workspace-fixture.mjs';

test('异步夹具上传先返回，回填前不可下载或保存；B保留双地址',async()=>{
  const site=await fixture({workflow:true,asyncUpload:true});
  try{
    for(const item of ['A','B']){
      const url=suffix=>site.base+suffix+'?item='+item;
      const initial=await(await fetch(url('/edit'))).text();assert(initial.includes('setTimeout(r,1800)'));
      assert.equal((await fetch(url('/upload'),{method:'POST',body:'bytes-'+item})).status,200);
      assert.equal((await fetch(url('/file'))).status,404);
      assert.equal((await fetch(url('/draft'),{method:'POST'})).status,409);
      await fetch(url('/attachment-ready'));
      assert.equal(await(await fetch(url('/file'))).text(),'bytes-'+item);
      const html=await(await fetch(url('/edit'))).text();
      assert.equal(html.includes('href="/other?item=B"'),item==='B');
      assert.equal((await fetch(url('/draft'),{method:'POST'})).status,200);
    }
    assert.equal(site.receipts.filter(r=>r.kind==='upload').length,2);
    assert.equal(site.receipts.filter(r=>r.kind==='attachment-ready').length,2);
  }finally{await site.close();}
});
