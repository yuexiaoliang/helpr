import json,hashlib,pathlib,sqlite3,subprocess,datetime,sys,shutil
from html.parser import HTMLParser
base=pathlib.Path('docs/testing/evidence/release-23-rich-text');out=base/(sys.argv[3] if len(sys.argv)>3 else '');out.mkdir(exist_ok=True);raw=pathlib.Path(sys.argv[1]);r=json.load(open(raw/'result.json'));b=json.load(open(base/sys.argv[2]))
assert r['passed'] and r['automatedPassed'] and not r['remaining']
profile=pathlib.Path(r['richText']['profile']);sha=lambda data:hashlib.sha256(data).hexdigest()
db=sqlite3.connect('file:'+str(profile/'workspace.sqlite')+'?mode=ro',uri=True)
assert db.execute('pragma quick_check').fetchone()[0]=='ok'
assert db.execute('select schema_version from workspace').fetchone()[0]==32
full='第一行：中文 <标题> & 正文\n第二行：保留换行与标点。';paragraph=r['richText'].get('paragraph',False)
cases=[]
class Body(HTMLParser):
 def __init__(self):super().__init__();self.depth=0;self.parts=[]
 def handle_starttag(self,tag,attrs):
  if self.depth:self.depth+=tag not in ['br','meta']
  elif dict(attrs).get('role')=='textbox':self.depth=1
 def handle_endtag(self,tag):
  if self.depth:self.depth-=1
 def handle_data(self,data):
  if self.depth:self.parts.append(data)
for c in r['richText']['cases']:
 expected='另一份：正文改写反例' if c['item']=='B' else full
 e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0]);a=e['actions'][0]
 assert e['actions']==c['result']['execution']['actions']==c['cold']['execution']['actions'] and len(e['actions'])==1
 assert a['action']['kind']=='fill' and a['action']['value']==expected
 source=a['richTextSource'];assert source['richText']['rule']=='contenteditable-ax-v1' and source['readOnly'] is False and source['disabled'] is False
 dom=c['domBefore'];n=dom['documents'][0]['nodes'];strings=dom['strings'];idx=n['backendNodeId'].index(source['richText']['backendNodeId']);attrs=dict(zip([strings[v] for v in n['attributes'][idx][::2]],[strings[v] for v in n['attributes'][idx][1::2]]));assert attrs['contenteditable']=='true' and attrs['role']=='textbox' and attrs['aria-label']=='正文'
 ax=next(node for node in c['axBefore']['nodes'] if node.get('backendDOMNodeId')==source['richText']['backendNodeId'] and not node.get('ignored'))
 if source['richText']['valueSource']=='ax':assert ax['value']['value']==source['textValue']
 else:
  assert source['textValue']=='' and 'value' not in ax
  descendants={idx}
  for i,parent in enumerate(n['parentIndex']):
   if parent in descendants:descendants.add(i)
  assert all(n['nodeValue'][i]==-1 or strings[n['nodeValue'][i]]=='' for i in descendants)
 writes=[v for v in r['fixture'] if v['kind']=='rich-input' and v['item']==c['item']];assert len(writes)==1 and writes[0]['sent']==(expected.replace('\n','\n\n') if paragraph else expected)
 parser=Body();parser.feed(c['html']);body=''.join(parser.parts)
 if c['item']=='A' and not paragraph:
  assert a['status']=='confirmed' and e['phase']=='complete' and a['richTextResult']['textValue']==expected and writes[0]['actual']==expected
  after=next(v for v in c['axAfter']['nodes'] if v.get('backendDOMNodeId')==a['richTextResult']['richText']['backendNodeId'] and not v.get('ignored'))
  assert after['value']['value']==expected and body==expected.replace('\n','') and '&lt;标题&gt;' in writes[0]['html']
 else:
  actual=expected.replace('\n','\n\n') if paragraph else '网站改写正文'
  assert a['status']=='unknown' and e['phase']=='paused' and not a.get('richTextResult') and writes[0]['actual']==actual and body==actual.replace('\n','')
  assert source['textValue'].replace('\n','')==('' if paragraph else '原有段落原有正文')
  assert any(v.get('role',{}).get('value')=='textbox' and v.get('value',{}).get('value')==actual for v in c['axAfter']['nodes'])
 assert not a.get('navigation')
 cases.append({'item':c['item'],'taskId':c['taskId'],'phase':e['phase'],'action':a,'receipts':writes})
db.close()
pids=sorted({int(k) for p in r['processes'] for k in p['seen']});groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines();pidrows=[line for line in rows if int(line.split()[0]) in pids];grouprows=[line for line in rows if int(line.split()[2]) in groups]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows));(out/'OS-GROUPS.txt').write_text('\n'.join(grouprows));assert not pidrows and not grouprows and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file():shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'build':b['build'],'sourceCommit':b['source']['commit'],'sourceDirty':b['source']['dirty'],'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':32,'paragraph':paragraph,'quickCheck':'ok','sqliteSha256':sha((profile/'workspace.sqlite').read_bytes()),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'leaseReleased':True,'starts':r['samples'],'modelPlans':r['richText']['plans'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['cases','pids','groups']},ensure_ascii=False))
