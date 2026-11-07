import json,hashlib,pathlib,sqlite3,subprocess,datetime,re,sys,shutil
out=pathlib.Path('docs/testing/evidence/release-23-management-result');raw=pathlib.Path(sys.argv[1]);r=json.load(open(raw/'result.json'));b=json.load(open('.local/workspace-validation/build-89.json'))
assert r['passed'] and r['automatedPassed'] and not r['remaining']
profile=pathlib.Path(r['dynamicResult']['cases'][0]['result']['execution']['materials'][0]['source']).parent
sha=lambda data:hashlib.sha256(data).hexdigest()
db=sqlite3.connect('file:'+str(profile/'workspace.sqlite')+'?mode=ro',uri=True)
assert db.execute('pragma quick_check').fetchone()[0]=='ok'
assert db.execute('select schema_version from workspace').fetchone()[0]==27
cases=[]
for c in r['dynamicResult']['cases']:
 e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0]);a=e['actions'][-1]
 assert e['actions']==c['result']['execution']['actions']==c['cold']['execution']['actions']
 assert a['navigation']['association']=='during-action' and 'navigationResolution' not in a
 assert 'recovery' not in a['submission']
 assert len([x for x in r['fixture'] if x.get('kind')=='published' and x.get('item')==c['item']])==1
 html=c['managementPage']['html'];assert sha(html.encode())==c['managementPage']['sha256']
 title='动态结果标题'+c['item'];assert html.count('>'+title+'</a>')==(1 if c['item']=='A' else 2)
 if c['item']=='A':
  d=a['discoveredRecovery'];rule=d['recovery'];assert d['entry']['name']==title and d['entry']['rule']=='confirmed-content-link-v1'
  assert d['source']['url']==c['result']['url'] and rule['url']!=d['source']['url']
  assert d['links'].count({'name':title,'url':rule['url']})==1
  assert len([x for x in d['links'] if x['url']==rule['url']])==1
  for field,kind,url in [('targetFactId','target',rule['targetUrl']),('uploadFactId','upload',rule['attachmentUrl'])]:
   assert any(x['id']==rule[field] and x['kind']==kind and x['url']==url for x in e['preparation'])
  public=c['independentPublicRead'];assert public['url']==rule['url'];assert sha(public['html'].encode())==public['pageSha256']
  assert public['html'].count('rel="canonical" href="'+rule['url'].split(rule['url'].split('/dynamic/')[0])[1]+'"')==1
  assert public['html'].count('href="/edit?item=A"')==1
  material=e['materials'][0];original=pathlib.Path(material['source']).read_bytes();assert sha(original)==public['sha256']==material['sha256']==e['publicationChecks'][0]['download']['sha256'];assert len(original)==public['bytes']
  assert e['phase']=='complete' and a['status']=='confirmed' and e['publicationChecks'][0]['localMaterial']=='verified'
 else:
  assert e['phase']=='paused' and e['pauseReason']=='page-change' and a['status']=='unknown' and 'discoveredRecovery' not in a and 'result' not in e
 cases.append({'item':c['item'],'taskId':c['taskId'],'phase':e['phase'],'action':a})
db.close()
pids=sorted({int(k) for p in r['processes'] for k in p['seen']});groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines()
pidrows=[line for line in rows if int(line.split()[0]) in pids];grouprows=[line for line in rows if int(line.split()[2]) in groups]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows));(out/'OS-GROUPS.txt').write_text('\n'.join(grouprows))
assert not pidrows and not grouprows and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file(): shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'build':b['build'],'sourceCommit':b['source']['commit'],'sourceDirty':b['source']['dirty'],'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':27,'quickCheck':'ok','sqliteSha256':sha((profile/'workspace.sqlite').read_bytes()),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'leaseReleased':True,'starts':r['samples'],'modelPlans':r['dynamicResult']['plansBeforeCold'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['cases','pids','groups']},ensure_ascii=False))
