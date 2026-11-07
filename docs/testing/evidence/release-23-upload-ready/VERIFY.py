import json,hashlib,pathlib,sqlite3,subprocess,datetime,sys,shutil,base64
out=pathlib.Path('docs/testing/evidence/release-23-upload-ready');raw=pathlib.Path(sys.argv[1]);r=json.load(open(raw/'result.json'));b=json.load(open(out/'BUILD-91.json'))
assert r['passed'] and r['automatedPassed'] and not r['remaining']
profile=pathlib.Path(r['uploadReady']['cases'][0]['result']['execution']['materials'][0]['source']).parent
sha=lambda data:hashlib.sha256(data).hexdigest()
db=sqlite3.connect('file:'+str(profile/'workspace.sqlite')+'?mode=ro',uri=True)
assert db.execute('pragma quick_check').fetchone()[0]=='ok'
assert db.execute('select schema_version from workspace').fetchone()[0]==28
cases=[]
for c in r['uploadReady']['cases']:
 e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0]);a=e['actions'][0]
 assert e['actions']==c['result']['execution']['actions']==c['cold']['execution']['actions']
 receipts=[x for x in r['fixture'] if x.get('item')==c['item']]
 upload=[x for x in receipts if x['kind']=='upload'];ready=[x for x in receipts if x['kind']=='attachment-ready'];assert len(upload)==len(ready)==1
 assert ready[0]['at']-upload[0]['at']>=1700
 assert not any(x['kind']=='planning' and upload[0]['at']<x['at']<ready[0]['at'] for x in receipts)
 assert 'uploadCheck' not in c['waiting']['execution']['actions'][0]
 if c['item']=='A':
  check=a['uploadCheck'];assert check['rule']=='unique-new-link-v1';assert a['resultSource']['observedAt']>=ready[0]['at'];assert check['download']['checkedAt']>=a['resultSource']['observedAt']
  assert len([l for l in a['resultLinks'] if l['url']==check['download']['url']])==1
  assert check['download']['url'] not in a['observedUrls']
  assert any(f['id']==check['targetFactId'] and f['kind']=='target' and f['url']==c['target'] for f in e['preparation'])
  assert any(f['id']==check['uploadFactId'] and f['kind']=='upload' and f['actionId']==a['id'] and f['url']==check['download']['url'] for f in e['preparation'])
  draft=[x for x in receipts if x['kind']=='draft'];assert len(draft)==1 and draft[0]['at']>=check['download']['checkedAt']
  material=e['materials'][0];local=pathlib.Path(material['source']).read_bytes();download=base64.b64decode(c['independent']['base64']);assert local==download
  assert sha(local)==material['sha256']==check['download']['sha256']==c['independent']['sha256'];assert len(local)==c['independent']['bytes']
  assert '异步附件A' in c['independent']['html'] and '公告' in c['independent']['html']
  assert e['phase']=='complete' and a['status']=='confirmed' and len([x for x in receipts if x['kind']=='published'])==1
 else:
  assert e['phase']=='unknown' and a['status']=='unknown' and 'uploadCheck' not in a and 'result' not in e
  assert not any(x['kind'] in ['download','draft','published'] for x in receipts)
 cases.append({'item':c['item'],'taskId':c['taskId'],'phase':e['phase'],'upload':a,'readyDelayMs':ready[0]['at']-upload[0]['at']})
db.close()
pids=sorted({int(k) for p in r['processes'] for k in p['seen']});groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines()
pidrows=[line for line in rows if int(line.split()[0]) in pids];grouprows=[line for line in rows if int(line.split()[2]) in groups]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows));(out/'OS-GROUPS.txt').write_text('\n'.join(grouprows))
assert not pidrows and not grouprows and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file(): shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'build':b['build'],'sourceCommit':b['source']['commit'],'sourceDirty':b['source']['dirty'],'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':28,'quickCheck':'ok','sqliteSha256':sha((profile/'workspace.sqlite').read_bytes()),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'leaseReleased':True,'starts':r['samples'],'modelPlans':r['uploadReady']['plansBeforeCold'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['cases','pids','groups']},ensure_ascii=False))
