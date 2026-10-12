// 独立反例：只替换本地测试页面 DOM，不派发上传或提交，不用于生成流程。
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {openRun,capture,actionFrom} from './runtime.mjs';
import {save} from './protocol.mjs';
const task=JSON.parse(await readFile('artifacts/drupal/learn/task.json'));
const directory='artifacts/protocol-checks';await mkdir(directory,{recursive:true});
const r=await openRun(task,directory,Date.now()+60000);
try {
  await r.page.setContent('<label>Choice<select><option value="1">Visible choice</option><option value="2">Different choice</option></select></label><div contenteditable="true" role="textbox" aria-label="Editor: body"></div><input type="submit" value="Save">');
  const obs=await capture(r.page);await save(directory+'/observation.json',obs);
  assert.ok(obs.nodes.some(n=>n.role==='textbox'&&n.name==='Editor: body'&&n.editable));
  const select=obs.nodes.find(n=>n.tag==='select');assert.equal(select.editable,false);assert.equal(select.value,'1');assert.deepEqual(select.selectedLabels,['Visible choice']);
  assert.equal(obs.nodes.find(n=>n.type==='submit').editable,false);
  const rule={kind:'selected-label',target:select.target,expected:'Visible choice'};
  const positive=await r.checks([rule],0);
  await r.page.getByRole('combobox',{name:'Choice',exact:true}).selectOption('2');
  let negative;
  try {await r.checks([rule],0);}catch(e){negative={code:e.code,detail:e.detail};}
  assert.equal(negative?.code,'condition-unsatisfied');
  assert.throws(()=>actionFrom({op:'fill',target:select.id,valueInput:'',literal:'bad',nameInput:'',effect:'edit'},obs,task),/fill-target-type/);
  assert.equal(r.events.filter(e=>e.type==='mutation-request').length,0);
  await save(directory+'/results.json',{passed:true,checks:['quoted ARIA name visible','SELECT is not fillable','submit input is not fillable','selected label succeeds despite different internal value','changed selected label rejected','no server writes'],positive,negative});
  console.log('6 protocol checks passed; no server writes');
} finally {await r.close();}
