import pathlib,json,sqlite3,subprocess,datetime
base=pathlib.Path(__file__).resolve().parent
runs=[];allp=set();allg=set();counts={k:0 for k in ['rt-planning','rt-input','rt-upload','rt-draft','rt-published']}
for name in ['failed-main','main','blank','failed-srcdoc','srcdoc','replace']:
 path=base/name/('result.json' if name.startswith('failed-') else 'RUNTIME.json');r=json.load(open(path));d=r['richTextRebind'];pids={int(i) for p in r['processes'] for i in p['seen']};groups={i for p in r['processes'] for i in p['groups']};allp.update(pids);allg.update(groups)
 db=sqlite3.connect('file:'+d['profile']+'/workspace.sqlite?mode=ro',uri=True); attempts,sent=db.execute('select count(*),sum(dispatched) from model_calls').fetchone(); fills=sum(a['action']['kind']=='fill' for (body,) in db.execute('select body from task_executions') for a in json.loads(body)['actions']); db.close()
 c={k:sum(v['kind']==k for v in r['fixture']) for k in counts}
 for k,v in c.items():counts[k]+=v
 runs.append({'group':name,'profile':d['profile'],'starts':[s['number'] for s in r['samples']],'readyMs':[s['ms'] for s in r['samples']],'ms':r['ms'],'pids':len(pids),'groups':len(groups),'counts':c,'fieldFills':fills,'modelAttempts':attempts,'modelDispatched':sent,'passed':r['passed'],'error':r.get('error')})
rows=subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines();left=[r for r in rows if int(r.split()[0]) in allp or int(r.split()[2]) in allg];apps=[r for r in rows if '/helpr.app/' in r or '/helpr Workspace.app/' in r];lease=not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists();assert not left and not apps and lease
result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runs':runs,'fieldFills':sum(r['fieldFills'] for r in runs),'modelAttempts':sum(r['modelAttempts'] for r in runs),'modelDispatched':sum(r['modelDispatched'] for r in runs),'counts':counts,'pids':len(allp),'groups':len(allg),'remaining':left,'actualApps':apps,'leaseReleased':lease,'budgetUsed':json.load(open('.local/workspace-validation/budget.json'))['used'],'realBusinessConsumption':0}
(base/'TOTALS.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
