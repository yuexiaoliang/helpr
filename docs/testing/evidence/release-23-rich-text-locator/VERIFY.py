import json,hashlib,pathlib,sqlite3,subprocess,datetime,sys,shutil
from html.parser import HTMLParser
base=pathlib.Path('docs/testing/evidence/release-23-rich-text-locator');out=base/sys.argv[3];out.mkdir(exist_ok=True);raw=pathlib.Path(sys.argv[1]);r=json.load(open(raw/'result.json'));b=json.load(open(base/sys.argv[2]));d=r['richTextLines']
assert r['passed'] and r['automatedPassed'] and not r['remaining']
profile=pathlib.Path(d['profile']);db=sqlite3.connect('file:'+str(profile/'workspace.sqlite')+'?mode=ro',uri=True)
assert db.execute('pragma quick_check').fetchone()[0]=='ok'
assert db.execute('select schema_version from workspace').fetchone()[0]==33
cases=[]
class Body(HTMLParser):
 def __init__(self):super().__init__();self.depth=0;self.parts=[]
 def handle_starttag(self,tag,attrs):
  if self.depth:self.depth+=tag not in ['br','meta']
  elif 'contenteditable' in dict(attrs):self.depth=1
 def handle_endtag(self,tag):
  if self.depth:self.depth-=1
 def handle_data(self,data):
  if self.depth:self.parts.append(data)
for c in d['cases']:
 e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0]);a=e['actions'][0];expected=a['action']['value'];source=a['richTextSource'];loc=a['action']['target']
 assert e['actions']==c['result']['execution']['actions']==c['cold']['execution']['actions'] and len(e['actions'])==1
 assert source['richText']['rule']=='contenteditable-ax-v1' and source['readOnly'] is False and source['disabled'] is False and source['name']=='' and source['role']!='textbox'
 assert loc==source['richText']['locator'] and loc['richTextNodeId']==source['richText']['backendNodeId'] and loc['frameUrl']==source['frameUrl']
 dom=c['domBefore'];strings=dom['strings'];docs=[(i,v) for i,v in enumerate(dom['documents']) if strings[v['documentURL']]==source['frameUrl']];assert len(docs)==1;docidx,doc=docs[0];n=doc['nodes'];idx=n['backendNodeId'].index(loc['richTextNodeId']);attrs=dict(zip([strings[v] for v in n['attributes'][idx][::2]],[strings[v] for v in n['attributes'][idx][1::2]]));assert attrs['contenteditable']=='true' and 'role' not in attrs and 'aria-label' not in attrs
 # 独立重建普通DOM元素父链，防止把模型路径当独立依据。
 parts=[];i=idx
 while i>0:
  parent=n['parentIndex'][i];siblings=[j for j,p in enumerate(n['parentIndex']) if p==parent and n['nodeType'][j]==1];parts.insert(0,strings[n['nodeName'][i]].lower()+':nth-child('+str(siblings.index(i)+1)+')');i=parent
 assert ' > '.join(parts)==loc['path']
 ax=next(node for node in c['axBefore']['nodes'] if node.get('backendDOMNodeId')==loc['richTextNodeId'] and not node.get('ignored'));assert ax['role']['value']==source['role'] and ax.get('name',{}).get('value','')==''
 assert (ax.get('value',{}).get('value')==source['textValue'] if source['richText']['valueSource']=='ax' else source['richText']['valueSource']=='empty-dom' and source['textValue']=='' and 'value' not in ax)
 if d['mode']=='node-inline-success':
  assert docidx>0 and source['frameUrl']==('about:blank' if c['item']=='E' else 'about:srcdoc')
  tree=c['frameTreeBefore'];frame=tree['frameTree']['childFrames'][0]['frame'];assert frame['url']==source['frameUrl'] and strings[doc['frameId']]==frame['id']
  nf=tree['nativeOrigins']['frames'];childs=[f for f in nf if f['url']==source['frameUrl']];parents=[f for f in nf if f['url']==a['source']['url']];assert len(childs)==len(parents)==1;nc,np=childs[0],parents[0];assert nc['origin']==np['origin']==a['source']['url'].split('/rich-edit')[0] and nc['parentId']==np['id'] and not nc['detached'] and not np['detached']
  owners=[(di,ni) for di,v in enumerate(dom['documents']) for ni,child in zip(v['nodes'].get('contentDocumentIndex',{}).get('index',[]),v['nodes'].get('contentDocumentIndex',{}).get('value',[])) if child==docidx];assert len(owners)==1 and owners[0][0]==0
 else:assert docidx==0
 writes=[v for v in r['fixture'] if v['kind']=='rich-input' and v['item']==c['item']];assert writes
 parser=Body();parser.feed(c['html']);assert ''.join(parser.parts)==writes[-1]['actual'].replace('\n','')
 if d['mode'] in ['node-success','node-inline-success']:
  assert a['status']=='confirmed' and e['phase']=='complete' and a['richTextResult']['textValue']==expected and a['richTextResult']['richText']['backendNodeId']==loc['richTextNodeId']
  assert source['textValue']==('' if c['item']=='E' else '\n' if c['item']=='A' else '原有段落\n\n原有正文')
  lines=expected.split('\n');assert len(writes)==2*len(lines)-1
  for i in range(len(lines)):
   assert writes[i*2]['actual']=='\n'.join(lines[:i+1]) and writes[i*2]['active']=='正文'
   if i:assert writes[i*2-1]['inputType']=='insertLineBreak'
  assert writes[-1]['actual']==expected and '&lt;' in writes[-1]['html']
  after=next(v for v in c['axAfter']['nodes'] if v.get('backendDOMNodeId')==loc['richTextNodeId'] and not v.get('ignored'));assert after['value']['value']==expected
 else:
  assert a['status']=='unknown' and not a.get('richTextResult') and e['phase']=='paused' and len(writes)==1 and writes[0]['actual']==expected.split('\n')[0]
  if d['mode']=='node-replace':assert all(v.get('backendDOMNodeId')!=loc['richTextNodeId'] for v in c['axAfter']['nodes'])
  if d['mode']=='node-focus':
   assert writes[0]['active']=='其它字段';main=c['domAfter']['documents'][0];ss=c['domAfter']['strings'];indices=[i for i,v in enumerate(main['nodes']['nodeName']) if ss[v]=='INPUT'];assert len(indices)==1;empty=main['nodes']['inputValue'];assert empty['index']==indices and len(empty['value'])==1 and (empty['value'][0]==-1 or ss[empty['value'][0]]=='')
 assert not a.get('navigation')
 cases.append({'item':c['item'],'taskId':c['taskId'],'phase':e['phase'],'action':a,'receipts':writes})
db.close()
pids=sorted({int(k) for p in r['processes'] for k in p['seen']});groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines();pidrows=[line for line in rows if int(line.split()[0]) in pids];grouprows=[line for line in rows if int(line.split()[2]) in groups]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows));(out/'OS-GROUPS.txt').write_text('\n'.join(grouprows));assert not pidrows and not grouprows and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file():shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'build':b['build'],'sourceCommit':b['source']['commit'],'sourceDirty':b['source']['dirty'],'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':33,'mode':d['mode'],'quickCheck':'ok','sqliteSha256':hashlib.sha256((profile/'workspace.sqlite').read_bytes()).hexdigest(),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'leaseReleased':True,'starts':r['samples'],'modelPlans':d['plans'],'inputs':d['inputs'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['cases','pids','groups']},ensure_ascii=False))
