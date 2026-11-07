import json,hashlib,pathlib,sqlite3,subprocess,datetime,sys,shutil
from html.parser import HTMLParser
base=pathlib.Path('docs/testing/evidence/release-23-rich-text-frame');out=base/sys.argv[3];out.mkdir(exist_ok=True);raw=pathlib.Path(sys.argv[1]);r=json.load(open(raw/'result.json'));b=json.load(open(base/sys.argv[2]));d=r['richTextLines']
assert r['passed'] and r['automatedPassed'] and not r['remaining']
profile=pathlib.Path(d['profile']);db=sqlite3.connect('file:'+str(profile/'workspace.sqlite')+'?mode=ro',uri=True)
assert db.execute('pragma quick_check').fetchone()[0]=='ok'
assert db.execute('select schema_version from workspace').fetchone()[0]==32
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
for c in d['cases']:
 e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0]);a=e['actions'][0];expected=a['action']['value']
 assert e['actions']==c['result']['execution']['actions']==c['cold']['execution']['actions'] and len(e['actions'])==1
 source=a['richTextSource'];assert source['richText']['rule']=='contenteditable-ax-v1' and source['readOnly'] is False and source['disabled'] is False
 dom=c['domBefore'];strings=dom['strings'];docs=[(i,v) for i,v in enumerate(dom['documents']) if strings[v['documentURL']]==source['frameUrl']];assert len(docs)==1;docidx,doc=docs[0];assert docidx>0;frameid=strings[doc['frameId']];root=next(v for v in c['axBefore']['nodes'] if v.get('role',{}).get('value')=='RootWebArea');assert root['frameId']==frameid;n=doc['nodes'];idx=n['backendNodeId'].index(source['richText']['backendNodeId']);attrs=dict(zip([strings[v] for v in n['attributes'][idx][::2]],[strings[v] for v in n['attributes'][idx][1::2]]));assert attrs['contenteditable']=='true' and attrs['role']=='textbox' and attrs['aria-label']=='正文'
 owners=[(di,ni) for di,v in enumerate(dom['documents']) for ni,child in zip(v['nodes'].get('contentDocumentIndex',{}).get('index',[]),v['nodes'].get('contentDocumentIndex',{}).get('value',[])) if child==docidx];assert len(owners)==1 and owners[0][0]==0;owner=owners[0][1];assert strings[dom['documents'][0]['nodes']['nodeName'][owner]]=='IFRAME' and owner in dom['documents'][0]['layout']['nodeIndex']
 ax=next(node for node in c['axBefore']['nodes'] if node.get('backendDOMNodeId')==source['richText']['backendNodeId'] and not node.get('ignored'));assert (ax.get('value',{}).get('value')==source['textValue'] if source['richText']['valueSource']=='ax' else source['richText']['valueSource']=='empty-dom' and source['textValue']=='' and 'value' not in ax)
 writes=[v for v in r['fixture'] if v['kind']=='rich-input' and v['item']==c['item']];assert writes
 parser=Body();parser.feed(c['html']);body=''.join(parser.parts);assert body==writes[-1]['actual'].replace('\n','')
 if d['mode']=='frame-success':
  assert a['status']=='confirmed' and e['phase']=='complete' and a['richTextResult']['textValue']==expected
  assert source['textValue']== ('' if c['item']=='E' else '\n' if c['item']=='A' else '原有段落\n\n原有正文')
  lines=expected.split('\n');assert len(writes)==2*len(lines)-1
  for i in range(len(lines)):
   assert writes[i*2]['actual']=='\n'.join(lines[:i+1]) and writes[i*2]['active']=='正文'
   if i:assert writes[i*2-1]['inputType']=='insertLineBreak'
  assert writes[-1]['actual']==expected and '&lt;' in writes[-1]['html']
  after=next(v for v in c['axAfter']['nodes'] if v.get('backendDOMNodeId')==a['richTextResult']['richText']['backendNodeId'] and not v.get('ignored'));assert after['value']['value']==expected
 else:
  assert a['status']=='unknown' and not a.get('richTextResult')
  if d['mode']=='rewrite':assert len(writes)==1 and writes[0]['actual']=='网站改写正文' and e['phase']=='paused'
  if d['mode']=='frame-focus':
   assert len(writes)==1 and writes[0]['actual']==expected.split('\n')[0] and writes[0]['active']=='外层字段' and e['phase']=='paused'
   main=c['domAfter']['documents'][0];stringsAfter=c['domAfter']['strings'];indices=[i for i,v in enumerate(main['nodes']['nodeName']) if stringsAfter[v]=='INPUT'];assert len(indices)==1;empty=main['nodes']['inputValue'];assert empty['index']==indices and len(empty['value'])==1;assert empty['value'][0]==-1 or stringsAfter[empty['value'][0]]==''
  if d['mode']=='frame-replace':assert len(writes)==1 and writes[0]['actual']==expected.split('\n')[0] and e['phase']=='paused';assert c['axAfter']['nodes'][0]['frameId']!=frameid
  if d['mode']=='stop':assert e['intent']=='stopped' and len(writes)==c['receiptsAtStop'] and writes[-1]['actual']!=expected and all(v['at']<=c['stopReturnedAt'] for v in writes)
 if d['mode']=='frame-replace':
  nav=a['navigation'];assert nav['association']=='during-action' and nav['mainFrame'] is False and nav['url']==a['action']['target']['frameUrl'] and nav['targetId']==a['binding']['targetId'] and nav['sourceGeneration']==a['binding']['generation'] and nav['generation']==nav['sourceGeneration']+1 and e['pauseReason']=='page-change'
 else:assert not a.get('navigation')
 cases.append({'item':c['item'],'taskId':c['taskId'],'phase':e['phase'],'action':a,'receipts':writes})
db.close()
pids=sorted({int(k) for p in r['processes'] for k in p['seen']});groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines();pidrows=[line for line in rows if int(line.split()[0]) in pids];grouprows=[line for line in rows if int(line.split()[2]) in groups]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows));(out/'OS-GROUPS.txt').write_text('\n'.join(grouprows));assert not pidrows and not grouprows and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file():shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'build':b['build'],'sourceCommit':b['source']['commit'],'sourceDirty':b['source']['dirty'],'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':32,'mode':d['mode'],'quickCheck':'ok','sqliteSha256':hashlib.sha256((profile/'workspace.sqlite').read_bytes()).hexdigest(),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'leaseReleased':True,'starts':r['samples'],'modelPlans':d['plans'],'inputs':d['inputs'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['cases','pids','groups']},ensure_ascii=False))
