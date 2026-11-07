# 独立核验器：不用产品发布/富文本判定函数或夹具期望常量。
import json, hashlib, pathlib, sqlite3, subprocess, datetime, sys, shutil
from html.parser import HTMLParser
base = pathlib.Path(__file__).resolve().parent
raw = pathlib.Path(sys.argv[1]); out = base / sys.argv[2]; out.mkdir(exist_ok=True)
r = json.load(open(raw / 'result.json')); d = r['richTextPublication']
assert r['passed'] and r['automatedPassed'] and not r['remaining']
assert d['beforeCold'] == d['afterCold']
profile = pathlib.Path(d['profile']); db = sqlite3.connect('file:' + str(profile / 'workspace.sqlite') + '?mode=ro', uri=True)
assert db.execute('pragma quick_check').fetchone()[0] == 'ok'
assert db.execute('select schema_version from workspace').fetchone()[0] == 34
expected = {
 'A': ('主文档公告 A', '第一行 <中文> & 正文\n第二行精确结束', 'main'),
 'B': ('内联空白公告 B', 'blank 第一行 <标签>\nblank 第二行 & 完成', 'about:blank'),
 'C': ('内联段落公告 C', 'srcdoc 第一行\n第二行 <中文> & 文本\n第三行结束', 'about:srcdoc'),
 'N': ('节点替换反例 N', '不应写入替换节点\n第二行不发送', 'main'),
 'P': ('页面替换反例 P', '不应沿用旧页预览\n第二行不发送', 'about:srcdoc'),
}
class HTML(HTMLParser):
 def __init__(self): super().__init__(); self.text=[]; self.links=[]; self.canonical=[]
 def handle_data(self, data): self.text.append(data)
 def handle_starttag(self, tag, attrs):
  a=dict(attrs)
  if tag=='a': self.links.append(a.get('href'))
  if tag=='link' and a.get('rel')=='canonical': self.canonical.append(a.get('href'))
cases=[]
for c in d['cases']:
 item=c['item']; heading, body, frame=expected[item]; e=json.loads(db.execute('select body from task_executions where task_id=?',(c['taskId'],)).fetchone()[0])
 assert [m['call'] for m in c['result']['messages'] if m.get('call')]==[m['call'] for m in c['cold']['messages'] if m.get('call')]
 for key in ['actions','publication','publicationChecks','materialProcessing','workflowDecisions']:
  assert e.get(key)==c['result']['execution'].get(key)==c['cold']['execution'].get(key)
 review=c['review']['publication']; proof=review['richTextReview']; source=proof['controls'][0]; field=review['fields'][1]; loc=field['richText']
 assert review['content']==heading+'\n\n'+body and [f['value'] for f in review['fields']]==[heading,body] and review['destination']=='通知'
 assert review['approvalId'] is None and proof['source']['url']==c['entry'] and proof['binding']['targetId'] and proof['binding']['generation']>=1
 assert source['role']=='generic' and source['name']=='' and source['readOnly'] is False and source['disabled'] is False
 assert loc==source['richText']['locator'] and loc['richTextNodeId']==source['richText']['backendNodeId'] and loc['frameUrl']==field['frameUrl']==source['frameUrl']==(c['entry'] if frame=='main' else frame)
 assert proof['binding']=={k:c['before']['tree']['nativeOrigins'][k] for k in ['targetId','generation']}
 dom=c['before']['dom']; strings=dom['strings']; docs=[(i,v) for i,v in enumerate(dom['documents']) if strings[v['documentURL']]==loc['frameUrl']]; assert len(docs)==1
 di,doc=docs[0]; nodes=doc['nodes']; idx=nodes['backendNodeId'].index(loc['richTextNodeId']); attrs=dict(zip([strings[v] for v in nodes['attributes'][idx][::2]],[strings[v] for v in nodes['attributes'][idx][1::2]]))
 assert attrs['contenteditable']=='true' and 'role' not in attrs and 'aria-label' not in attrs
 parts=[]; i=idx
 while i>0:
  parent=nodes['parentIndex'][i]; siblings=[j for j,p in enumerate(nodes['parentIndex']) if p==parent and nodes['nodeType'][j]==1]
  parts.insert(0,strings[nodes['nodeName'][i]].lower()+':nth-child('+str(siblings.index(i)+1)+')'); i=parent
 assert ' > '.join(parts)==loc['path']
 ax=next(n for n in c['before']['ax']['nodes'] if n.get('backendDOMNodeId')==loc['richTextNodeId'] and not n.get('ignored'))
 assert ax['role']['value']=='generic' and ax.get('name',{}).get('value','')==''
 assert source['textValue']==('原有段落\n\n原有正文' if item=='C' else '')
 assert ax.get('value',{}).get('value','')==source['textValue']
 if frame!='main':
  tree=c['before']['tree']; child=tree['frameTree']['childFrames'][0]['frame']; assert child['url']==frame and strings[doc['frameId']]==child['id']
  native=tree['nativeOrigins']['frames']; nc=next(f for f in native if f['url']==frame); np=next(f for f in native if f['url']==c['entry'])
  assert nc['origin']==np['origin']==c['entry'].split('/rt-edit')[0] and nc['parentId']==np['id'] and not nc['detached']
  owners=[(oi,ni) for oi,v in enumerate(dom['documents']) for ni,ci in zip(v['nodes'].get('contentDocumentIndex',{}).get('index',[]),v['nodes'].get('contentDocumentIndex',{}).get('value',[])) if ci==di]; assert len(owners)==1 and owners[0][0]==0
 else: assert di==0
 receipts=[v for v in r['fixture'] if v.get('item')==item]; inputs=[v for v in receipts if v['kind']=='rt-input']; pubs=[v for v in receipts if v['kind']=='rt-published']
 assert len([v for v in receipts if v['kind']=='rt-upload'])==len([v for v in receipts if v['kind']=='rt-draft'])==1
 assert not any(a['action']['kind']=='fill' for a in c['review']['actions'])
 data=bytes([0,255,ord(item),128,13,10]); digest=hashlib.sha256(data).hexdigest(); assert hashlib.sha256(pathlib.Path(c['file']).read_bytes()).hexdigest()==digest==c['sha256']
 assert next(v for v in receipts if v['kind']=='rt-upload')['sha256']==digest
 if item in ['N','P']:
  assert e['phase']=='paused' and not inputs and not pubs and not e.get('publicationChecks') and not any(a['action']['kind']=='fill' for a in e['actions'])
  assert not any(n.get('backendDOMNodeId')==loc['richTextNodeId'] for n in c['changed']['ax']['nodes'])
  if item=='P':
   before=c['before']['tree']['nativeOrigins']; after=c['changed']['tree']['nativeOrigins']; assert before['targetId']==after['targetId'] and after['generation']>before['generation']; assert c['approvalError']=='PARTICIPATION_EXPIRED' and e['pauseReason']=='page-change'
   assert len([v for v in receipts if v['kind']=='rt-page'])in [2,3] # 初开和替换必需；冷开可从网站缓存读取
  else:
   assert c['before']['tree']['nativeOrigins']==c['changed']['tree']['nativeOrigins']
   assert len([v for v in receipts if v['kind']=='rt-page']) in [1,2]
 else:
  assert e['phase']=='complete' and len(pubs)==1 and pubs[0]['heading']==heading and pubs[0]['body']==body and pubs[0]['destination']=='通知'
  assert pubs[0]['at']>=c['approveAt'] and all(v['at']>=c['approveAt'] for v in inputs)
  assert bytes.fromhex(c['downloadHex'])==data and e['publicationChecks'][0]['download']['sha256']==digest
  parser=HTML(); parser.feed(c['publicHtml']); assert heading in parser.text and body in parser.text and '通知' in parser.text
  assert parser.canonical==['/rt-result?item='+item] and '/rt-file?item='+item in parser.links and '/rt-edit?item='+item in parser.links
  fills=[a for a in e['actions'] if a['action']['kind']=='fill']; assert len(fills)==2
  rich=next(a for a in fills if a.get('richTextSource')); assert rich['action']['target']==loc and rich['status']=='confirmed' and rich['richTextResult']['textValue']==body
  submit=e['actions'][-1]; assert submit['effect']=='publication' and submit['status']=='confirmed' and [f['textValue'] for f in submit['fieldResults']]==[heading,body]
  assert submit['fieldResults'][1]['richText']['backendNodeId']==loc['richTextNodeId']
  lines=body.split('\n'); assert len(inputs)==2*len(lines)-1
  for j in range(len(lines)):
   assert inputs[j*2]['value']=='\n'.join(lines[:j+1])
   if j: assert inputs[j*2-1]['inputType']=='insertLineBreak'
  assert next(n for n in c['after']['ax']['nodes'] if n.get('backendDOMNodeId')==loc['richTextNodeId'])['value']['value']==body
  assert e['materialProcessing'][0]['status']=='complete' and any(w['status']=='unusable' for w in e['workflowDecisions']) and all(not w.get('replay') for w in e['learnedWorkflows'])
 cases.append({'item':item,'taskId':c['taskId'],'phase':e['phase'],'inputs':len(inputs),'publications':len(pubs),'attachmentSha256':digest,'frame':frame})
assert not any(v['kind']=='fixture-error' for v in r['fixture'])
db.close(); pids=sorted({int(k) for p in r['processes'] for k in p['seen']}); groups=sorted({g for p in r['processes'] for g in p['groups']})
rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,comm='],text=True).splitlines(); pidrows=[l for l in rows if int(l.split()[0]) in pids]; grouprows=[l for l in rows if int(l.split()[2]) in groups]
(out/'OS-PIDS.txt').write_text('\n'.join(pidrows)); (out/'OS-GROUPS.txt').write_text('\n'.join(grouprows)); assert not pidrows and not grouprows and not pathlib.Path('.local/workspace-validation/workspace-run.lock').exists()
for f in raw.iterdir():
 if f.is_file(): shutil.copy2(f,out/('RUNTIME.json' if f.name=='result.json' else f.name))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rawRun':str(raw.resolve()),'profile':str(profile),'dataFormat':34,'mode':d['mode'],'quickCheck':'ok','sqliteSha256':hashlib.sha256((profile/'workspace.sqlite').read_bytes()).hexdigest(),'cases':cases,'pids':pids,'groups':groups,'remainingPids':pidrows,'remainingGroups':grouprows,'leaseReleased':True,'starts':r['samples'],'counts':d['afterCold'],'milliseconds':r['ms']}
(out/'INDEPENDENT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n'); print(json.dumps(report,ensure_ascii=False))
