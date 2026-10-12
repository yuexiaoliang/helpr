"""只读审计保存的版本链、调用用量、进程和源码，不触发网页或模型。"""
import json, hashlib
from pathlib import Path
root=Path(__file__).parent/'artifacts/current'
def read(name): return json.loads((root/name).read_text())
def digest(value): return hashlib.sha256(value if isinstance(value,bytes) else json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def intact(value): return value['id']==digest({k:v for k,v in value.items() if k!='id'})
checks=[]
def require(name,ok): checks.append({'name':name,'passed':bool(ok)})
ledger=read('preview-ledger.json')
source_count=0
for name,sha in read('sources.json').items():
    require('prepare-source-'+name,digest((root/'source'/name).read_bytes())==sha)
    source_count+=1
for label in ['A-v1','B-v1','A-v2','C-v2']:
    content=read(label+'-content.json')
    model=read('model/'+label+'.json')
    input=read('model/'+label+'-input.json')['input']
    require(label+'-content-id',intact(content))
    require(label+'-model-input',digest(input)==model['inputHash'])
    require(label+'-model-answer',digest(model['answer'])==content['model']['responseHash'] and json.loads(model['answer']['content'])==model['proposal'])
    parsed=input['parsed'];cells={c['ref']:c['value'] for c in parsed['cells']}
    require(label+'-parse-link',digest(parsed)==content['parseHash'] and parsed['sourceHash']==content['material']['sha256'])
    require(label+'-snapshot',digest(Path(content['material']['snapshot']).read_bytes())==content['material']['sha256'])
    provenance_ok=True
    for claim in content['provenance']:
        actual=cells[claim['refs'][0]] if claim['operation']=='cell' else sum(cells[r] for r in claim['refs'])
        provenance_ok &= actual==claim['value'] and claim['sourceHash']==parsed['sourceHash']
    require(label+'-cell-provenance',provenance_ok)
for task in 'ABC':
    bundle=read('bundle-'+task+'.json');c=bundle['content'];a=bundle['authority'];result=read('publication-'+task+'/result.json')
    require(task+'-frozen-bundle',intact(bundle) and intact(c) and intact(a))
    require(task+'-current-task',ledger['tasks'][task]['content']==c['id'] and ledger['tasks'][task]['active'])
    require(task+'-scope',all(a[k]==c[k] for k in ['task','execution','epoch']) and a['content']==c['id'])
    require(task+'-workflow',digest((root/'workflow.json').read_bytes())==bundle['workflowHash']==result['workflow'])
    require(task+'-published-bundle',result['bundle']==bundle['id'] and result['content']==c['id'] and result['authority']==a['id'])
    if a['kind']=='preview':
        request=ledger['requests'][a['request']]
        require(task+'-request-answer',request['status']=='answered' and request['content']==c['id'] and request['task']==task)
    else:
        agreement=ledger['agreements'][task]
        require(task+'-agreement',intact(agreement) and agreement['id']==a['agreement'] and agreement['active'] and agreement['rulesHash']==c['rulesHash'] and agreement['target']==c['target'])
    require(task+'-injected-confirmation',a['source']=='experiment-injected')
    events=[json.loads(line) for line in (root/f'publication-{task}/events.jsonl').read_text().splitlines()]
    ready=[e for e in events if e['kind']=='pre-submit-readiness']
    require(task+'-pre-submit-observations',len(ready)==2 and all(e['content']==c['id'] and e['actualHash']==c['material']['sha256'] and e['body']==c['body'] for e in ready))
    for f,sha in result['sourceHashes'].items():
        require(task+'-source-'+f,digest((root/f'publication-{task}/source'/Path(f).name).read_bytes())==sha);source_count+=1
require('independent-processes',len({read(f'publication-{task}/result.json')['pid'] for task in 'ABC'})==3)
usage=read('model-ledger.json')['requests'];budget=read('publication-budget.json')
require('bounded-model-usage',len(usage)==4 and all(r['status']=='settled' for r in usage) and sum(r['usage']['total_tokens'] for r in usage)<=40000)
require('bounded-publications',all(len(budget[k])==3<=budget['limits'][k] for k in ['preparations','uploads','submissions']))
report={'passed':all(c['passed'] for c in checks),'count':len(checks),'checks':checks,'sourceHashesVerified':source_count,
    'modelCalls':len(usage),'reportedTokens':sum(r['usage']['total_tokens'] for r in usage),
    'publicationAttempts':len(budget['submissions']),
    'semanticReview':{'reviewer':'agent','humanApproval':False,'scope':'已逐项阅读四份真实建议；数量、编号、单位和合计符合原表，不把空白说明推测成业务事实。仅本样本，不证明任意自由文字正确。'}}
(root/'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ['checks','semanticReview']},ensure_ascii=False))
raise SystemExit(0 if report['passed'] else 1)
