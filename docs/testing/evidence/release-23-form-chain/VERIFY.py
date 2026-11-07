import json,hashlib,pathlib,sqlite3,subprocess,datetime,sys,shutil
out=pathlib.Path('docs/testing/evidence/release-23-form-chain');raw=pathlib.Path(sys.argv[1]);r=json.load(open(raw/'result.json'));b=json.load(open(out/'BUILD-93.json'))
assert r['passed'] and r['automatedPassed'] and not r['remaining']
profile=pathlib.Path(r['formNavigation']['profile']);sha=lambda data:hashlib.sha256(data).hexdigest()
db=sqlite3.connect('file:'+str(profile/'workspace.sqlite')+'?mode=ro',uri=True)
assert db.execute('pragma quick_check').fetchone()[0]=='ok'
assert db.execute('select schema_version from workspace').fetchone()[0]==30
cases=[]
for c in r['formNavigation']['cases']:
 e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0]);a=e['actions'][0];d=a.get('discoveredTarget');n=a['navigation']
 assert e['actions']==c['result']['execution']['actions']==c['cold']['execution']['actions']
 writes=[x for x in r['fixture'] if x.get('item')==c['item'] and x['kind']=='form-created'];assert len(writes)==1
 assert c['result']['url'].endswith(writes[0]['route'])
 if d:
  assert a['status']=='confirmed' and a['effect']=='draft' and a['targetCreation']['fields']==[{'name':'草稿标题','value':writes[0]['title']}]
  assert len([l for l in d['links'] if l['url']==a['source']['url']])==len([l for l in d['links'] if l['url']==d['source']['url']])==1
  assert any(f['kind']=='target' and f['id']==d['targetFactId'] and f['actionId']==a['id'] and f['url']==d['source']['url'] for f in e['preparation'])
  assert any(f['kind']=='draft' and f['id']==d['draftFactId'] and f['actionId']==a['id'] for f in e['preparation'])
 assert all(claim['targetUrl'] is None for claim in e.get('resourceClaims',[]))
 fills=[x for x in r['fixture'] if x.get('item')==c['item'] and x['kind']=='form-filled']
 if c['item']!='C':
  p=a['formNavigationResolution'];assert p['proof']['reason']=='formSubmissionPost' and p['proof']['url']==n['url']
  chain=p['proof']['chain'];host=p['chain']['host'];control=p['chain']['control']
  assert chain['finalUrl']==d['source']['url'] and chain['requests'][0]=={'url':n['url'],'method':'POST'}
  assert host['navigationId']==n['id'] and host['targetId']==n['targetId'] and host['generation']==n['generation']
  assert [h['url'] for h in host['events']]==[q['url'] for q in chain['requests']]
  assert [h['kind'] for h in host['events']]==['start']+['redirect']*(len(chain['requests'])-1)
  assert len(chain['requests'])==(1 if c['item']=='A' else 3)
  if c['item']=='B':
   assert chain['requests'][0]['url']==a['source']['url']
   assert [q.get('redirectStatus') for q in chain['requests']]==[None,303,302]
   assert [q['method'] for q in chain['requests']]==['POST','GET','GET']
  assert chain['status']==200 and all(chain[k] for k in ['requestId','loaderId','frameId','sessionId'])
  assert len({h['requestId'] for h in host['events']})==len(host['events'])
  assert len({q['requestId'] for q in control})==len(control)
  assert set(q['requestId'] for q in control).issubset(set(h['requestId'] for h in host['events']))
  epoch=n['inputEpoch']
  for block in sorted(host['events']+control,key=lambda b:b['before']):
   assert block['before']==epoch and block['after']==epoch+1;epoch+=1
  assert p['pausedInputEpoch']==epoch and p['source']['generation']==n['generation']==n['sourceGeneration']+1
  assert p['source']['fingerprint']==d['source']['fingerprint'];assert p['source']['observedAt']>=d['source']['observedAt']
  assert len(e['actions'])==2 and e['actions'][1]['action']['kind']=='fill' and e['actions'][1]['status']=='confirmed'
  assert len(fills)==1 and fills[0]['body']=='自动续行正文' and fills[0]['at']>=p['source']['observedAt']
  assert '<textarea>自动续行正文</textarea>' in c['html'] and e['phase']=='complete'
 else:
  assert 'formNavigationResolution' not in a and len(e['actions'])==1 and not fills
  assert a['status'] in ['unknown','confirmed']
  assert e['phase']=='paused' and e['pauseReason']=='page-change' and '<textarea></textarea>' in c['html']
  redirects=[x for x in r['fixture'] if x.get('item')=='C' and x['kind']=='form-redirect'];assert len(redirects)==2 and redirects[-1]['to']==writes[0]['route']
  assert len([x for x in r['fixture'] if x['kind']=='form-extra-navigation' and x.get('item')=='C'])==1
 assert not c['nativeTrace']['overflow']
 assert not [row for row in c['nativeTrace']['rows'] if row['stage']=='identified']
 cases.append({'nativeTraceRows':len(c['nativeTrace']['rows']),'item':c['item'],'taskId':c['taskId'],'phase':e['phase'],'action':a,'fills':fills,'resourceClaims':e.get('resourceClaims')})
db.close()
pids=sorted({int(k) for p in r['processes'] for k in p['seen']});groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines();pidrows=[line for line in rows if int(line.split()[0]) in pids];grouprows=[line for line in rows if int(line.split()[2]) in groups]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows));(out/'OS-GROUPS.txt').write_text('\n'.join(grouprows));assert not pidrows and not grouprows and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file(): shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'build':b['build'],'sourceCommit':b['source']['commit'],'sourceDirty':b['source']['dirty'],'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':30,'quickCheck':'ok','sqliteSha256':sha((profile/'workspace.sqlite').read_bytes()),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'leaseReleased':True,'starts':r['samples'],'modelPlans':r['formNavigation']['plans'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['cases','pids','groups']},ensure_ascii=False))
