import json,hashlib,pathlib,sqlite3,subprocess,datetime,sys,shutil
from html.parser import HTMLParser
from urllib.parse import urljoin
base=pathlib.Path(__file__).resolve().parent
out=base/sys.argv[2];out.mkdir(exist_ok=True)
raw=pathlib.Path(sys.argv[1]); r=json.load(open(raw/'result.json')); b=json.load(open(base/'BUILD-107.json'))
sha=lambda x:hashlib.sha256(x).hexdigest()
assert r['passed'] and r['automatedPassed'] and not r['remaining']
assert r['dynamicResult']['summary'] and r['dynamicResult']['scriptedContinuation'] is False
profile=pathlib.Path(r['dynamicResult']['cases'][0]['result']['execution']['materials'][0]['source']).parent
class Page(HTMLParser):
 def __init__(self,html,base):
  super().__init__(); self.base=base;self.links=[];self.canonical=[];self.heading='';self.body='';self.text='';self.tag='';self.link=None;self.feed(html)
 def handle_starttag(self,tag,attrs):
  a=dict(attrs); self.tag=tag
  if tag=='link' and a.get('rel')=='canonical':self.canonical.append(urljoin(self.base,a['href']))
  if tag=='a':self.link=[urljoin(self.base,a['href']),'']
 def handle_data(self,data):
  self.text+=data
  if self.tag=='h1':self.heading+=data
  if self.tag=='section':self.body+=data
  if self.link is not None:self.link[1]+=data
 def handle_endtag(self,tag):
  if tag=='a' and self.link is not None:self.links.append(self.link);self.link=None
  self.tag=''
db=sqlite3.connect('file:'+str(profile/'workspace.sqlite')+'?mode=ro',uri=True)
assert db.execute('pragma quick_check').fetchone()[0]=='ok'
assert db.execute('select schema_version from workspace').fetchone()[0]==36
cases=[]
for c in r['dynamicResult']['cases']:
 item=c['item'];e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0]);a=e['actions'][-1];p=a['submission']['publication'];attachment=p['attachment']
 assert e['actions']==c['result']['execution']['actions']==c['cold']['execution']['actions']
 assert a['navigation']['association']=='during-action' and 'navigationResolution' not in a
 assert 'recovery' not in a['submission'] and a['source']['url']==attachment['targetUrl']==c['target']
 effects=[x for x in r['fixture'] if x.get('item')==item and x['kind'] in ['upload','draft','published']]
 assert [x['kind'] for x in effects]==['upload','draft','published']
 assert [effects[-1]['heading'],effects[-1]['body']]==[f['value'] for f in p['fields']]
 assert '\n\n'.join(f['value'] for f in p['fields'])==p['content']
 manager=c['managementPage'];assert sha(manager['html'].encode())==manager['sha256'];m=Page(manager['html'],manager['url'])
 assert p['fields'][1]['value'] not in m.text and p['destination'] not in m.text
 assert not any(link[0] in [attachment['targetUrl'],attachment['url']] for link in m.links)
 matches=[l for l in m.links if l[1]==p['fields'][0]['value']];assert len(matches)==(2 if item=='B' else 1)
 if item=='B':
  assert e['phase']=='paused' and a['status']=='unknown' and 'discoveredRecovery' not in a and 'result' not in e
  assert not [x for x in r['fixture'] if x['kind']=='public-read' and x.get('item')==item]
 else:
  d=a['discoveredRecovery'];rule=d['recovery'];assert d['entry']=={'rule':'confirmed-content-candidate-v1','name':p['fields'][0]['value']}
  assert d['source']['url']==manager['url'] and d['binding']['targetId']==a['navigation']['targetId']
  assert d['source']['generation']==d['binding']['generation'] and not d['source']['truncated']
  assert matches==[[rule['url'],d['entry']['name']]] and len([l for l in d['links'] if l['url']==rule['url']])==1
  for field,kind,url in [('targetFactId','target',rule['targetUrl']),('uploadFactId','upload',rule['attachmentUrl'])]:
   assert any(x['id']==rule[field] and x['kind']==kind and x['url']==url for x in e['preparation'])
  pub=c['independentPublicRead'];assert pub['url']==rule['url'] and sha(pub['html'].encode())==pub['pageSha256'];page=Page(pub['html'],pub['url'])
  assert page.canonical==[rule['url']] and page.heading==p['fields'][0]['value']
  assert (page.body==p['fields'][1]['value'])==(item!='D')
  assert p['destination'] in page.text
  assert len([l for l in page.links if l[0]==attachment['targetUrl']])==(0 if item=='C' else 1)
  assert len([l for l in page.links if l[0]==attachment['url']])==1
  material=e['materials'][0];original=pathlib.Path(material['source']).read_bytes()
  assert sha(original)==pub['sha256']==material['sha256'] and len(original)==pub['bytes']
  duplicate_log=len(sys.argv)>3 and sys.argv[3]=='duplicate-read-log'
  assert c['productPublicReads']==(2 if duplicate_log else 1)
  logs=[x for x in r['fixture'] if x['kind']=='public-read' and x.get('item')==item]
  if duplicate_log:
   assert len(logs)==4 and ['url' in x for x in logs]==[True,False,True,False]
   assert logs[0]['url']==logs[2]['url']
  else:assert len(logs)==2
  check=e['publicationChecks'][0];assert check['actionId']==a['id'] and check['approvalId']==a['publicationApprovalId'] and check['materialId']==material['id']
  if item=='A':
   assert e['phase']=='complete' and a['status']=='confirmed' and check['status']=='verified' and check['localMaterial']=='verified'
   assert check['download']['sha256']==sha(original) and all(check['checks'].values())
  else:
   assert e['phase']=='paused' and a['status']=='unknown' and check['status']=='unknown' and 'result' not in e
   assert not check['checks']['target' if item=='C' else 'content']
 cases.append({'item':item,'phase':e['phase'],'taskId':c['taskId'],'confirmedFields':p['fields'],'resultCheck':e.get('publicationChecks',[]),'checkpoint':a.get('discoveredRecovery')})
db.close()
pids=sorted({int(k) for p in r['processes'] for k in p['seen']});groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines()
pidrows=[x for x in rows if int(x.split()[0]) in pids];grouprows=[x for x in rows if int(x.split()[2]) in groups]
apps=[x for x in rows if '/helpr.app/Contents/' in x or '/helpr Workspace.app/Contents/' in x]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows));(out/'OS-GROUPS.txt').write_text('\n'.join(grouprows))
assert not pidrows and not grouprows and not apps and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file():shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'build':b['build'],'sourceCommit':b['source']['commit'],'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':36,'quickCheck':'ok','sqliteSha256':sha((profile/'workspace.sqlite').read_bytes()),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'actualApps':apps,'leaseReleased':True,'starts':r['samples'],'duplicateReceiptInstrumentation':len(sys.argv)>3,'modelPlans':r['dynamicResult']['plansBeforeCold'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
counts={k:len([x for x in r['fixture'] if x['kind']==k]) for k in ['planning','upload','draft','published','public-read']}
totals={'checkedAt':report['checkedAt'],'stage':{'builds':0,'starts':len(r['samples']),'counts':counts,'pids':len(pids),'groups':len(groups)},'budgetUsed':json.load(open('.local/workspace-validation/budget.json'))['used'],'remaining':[],'leaseReleased':True,'realBusinessConsumption':0}
(out/'TOTALS.json').write_text(json.dumps(totals,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(totals,ensure_ascii=False))
