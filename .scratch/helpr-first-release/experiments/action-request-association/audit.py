"""只读独立核对原始实体与收件结果；不导入 JS 夹具或其 multipart 解析器。"""
import hashlib
import json
from collections import Counter
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / 'artifacts'
RUN = ARTIFACTS / 'run-1'
checks = []

def read(path):
    return json.loads(path.read_text())

def digest(data):
    return hashlib.sha256(data).hexdigest()

def check(name, condition):
    checks.append({'name': name, 'ok': bool(condition)})

def parts(body):
    boundary = body.split(b'\r\n', 1)[0][2:].decode('ascii')
    header = f'MIME-Version: 1.0\r\nContent-Type: multipart/form-data; boundary="{boundary}"\r\n\r\n'.encode()
    message = BytesParser(policy=policy.default).parsebytes(header + body)
    assert message.is_multipart() and not message.defects
    return [(p.get_param('name', header='content-disposition'), p.get_filename(), p.get_payload(decode=True)) for p in message.iter_parts()]

# 独立列出语义期望，不能只相信 result.json 中的绿色状态。
expected = {
    'baseline-same-click': 2, 'baseline-late': 0, 'baseline-late-next': 1,
    'baseline-disk-upload': 1, 'baseline-replaced-upload': 1, 'baseline-get': 1,
    'baseline-redirect': 2, 'page-route-service-worker': 1, 'context-route-service-worker': 0,
    'page-route-worker': 0, 'strict-same-click': 1, 'strict-extra-first': 1, 'strict-xhr': 1,
    'strict-disk-upload': 1, 'strict-replaced-upload': 0, 'strict-late': 0,
    'strict-matching-timer': 1, 'strict-frame-form': 1, 'strict-redirect': 1,
    'strict-get': 0, 'strict-worker-unknown': 0, 'strict-service-worker-unknown': 0,
    'strict-beacon-late': 0, 'strict-held-revoke': 0, 'strict-forward-stop': 1,
}
ledger = read(ARTIFACTS / 'budget.json')
check('25 attempts two browsers no unreported reruns', ledger['cases'] == 25 and ledger['launches'] == 2 and len(ledger['attempts']) == 25)
check('zero model and remote operations', all(ledger[k] == 0 for k in ('modelCalls','remotePreparations','remoteUploads','remotePublications')))
case_folders = {p.parent.name:p.parent for p in ARTIFACTS.glob('run-*/*/result.json')}
check('case inventory', set(case_folders) == set(expected))
for run in sorted(ARTIFACTS.glob('run-*')):
    source_hashes = read(run / 'source-hashes.json')
    check(f'{run.name}: source snapshot hashes', all(digest((run / 'source' / name).read_bytes()) == value for name, value in source_hashes.items()))
all_receipts = []
all_results = []
negative_sends = 0
for name, count in expected.items():
    folder = case_folders[name]
    result = read(folder / 'result.json')
    server = read(folder / 'server.json')
    all_results.append(result)
    all_receipts.extend(server)
    check(f'{name}: server count', len(server) == count)
    check(f'{name}: attempted browser request exists', bool(read(folder / 'browser-requests.json')))
    for row in server:
        raw = (folder / f'server-body-{row["id"]}.bin').read_bytes()
        check(f'{name}: entity {row["id"]}', len(raw) == row['bytes'] and digest(raw) == row['sha256'])
        if row.get('file'):
            parsed = parts(raw)
            check(f'{name}: multipart case', parsed[0] == ('case', None, name.encode()))
            check(f'{name}: multipart file', len(parsed) == 2 and parsed[1][:2] == ('file','sample.bin'))
            uploaded = parsed[1][2]
            source = (folder / 'sample.bin').read_bytes()
            check(f'{name}: server extracted bytes', uploaded == (folder / f'server-file-{row["id"]}.bin').read_bytes())
            check(f'{name}: downloaded bytes', digest(uploaded) == result['download']['sha256'])
            check(f'{name}: intended file relation', uploaded != source if name == 'baseline-replaced-upload' else uploaded == source)
            if name == 'baseline-replaced-upload':
                check('same name and size can conceal different data', len(uploaded) == len(source) == 8192 and uploaded == bytes([255]) * 8192 and result['selection']['sha256'] == digest(source))
        elif row['contentType'].startswith('application/json'):
            data = json.loads(raw)
            check(f'{name}: body case identity {row["id"]}', data['case'] == name and data['record'] == 'fictional')
            expected_value = 999 if name == 'baseline-same-click' and row['id'] == 2 else 1
            check(f'{name}: stored value {row["id"]}', data['value'] == expected_value)
        elif name == 'strict-frame-form':
            check('frame form fields', parse_qs(raw.decode()) == {'case':[name], 'value':['1']})
        elif name == 'baseline-get':
            check('GET produced server record', row['method'] == 'GET' and row['path'].endswith('?value=999') and raw == b'')
    proxy_path = folder / 'proxy.json'
    if proxy_path.exists():
        proxy = read(proxy_path)
        network = [row for row in proxy if row['path'].startswith(('/sink/','/redirect/'))]
        forwarded = [row for row in network if row['decision'] == 'forwarded']
        blocked = [row for row in network if row['decision'] == 'blocked']
        negative_sends += len(blocked)
        actual = Counter((r['method'],r['path'],r['sha256']) for r in server)
        predicted = Counter((r['method'],r['path'],r['sha256']) for r in forwarded)
        check(f'{name}: all forwards and only forwards reached server', actual == predicted)
        for row in network:
            raw = (folder / f'proxy-{row["id"]}.bin').read_bytes() if row['bytes'] else b''
            check(f'{name}: proxy entity {row["id"]}', len(raw) == row['bytes'] and digest(raw) == row['sha256'])
        if name == 'strict-replaced-upload':
            wrong = parts((folder / f'proxy-{network[0]["id"]}.bin').read_bytes())[1][2]
            check('proxy saw wrong bytes before refusing upload', wrong == bytes([255]) * 8192 and blocked[0]['reason'] == 'multipart-mismatch' and len(server) == 0)
        if name == 'strict-extra-first':
            check('body comparison rejects first wrong request without consuming permit', network[0]['decision'] == 'blocked' and network[0]['reason'] == 'body-mismatch' and network[1]['decision'] == 'forwarded' and json.loads(server[0]['body'])['value'] == 1)
        if name == 'strict-matching-timer':
            click = next(a['at'] for a in result['actors'] if a['source'] == 'new-click')
            timer = next(a['at'] for a in result['actors'] if a['source'] == 'old-action-timer')
            check('wrong causal source won permit before new click', result['actionStart'] < timer <= server[0]['receivedAt'] < click and len(blocked) == 1 and blocked[0]['reason'] == 'contract-consumed')
            check('matching request bytes do not identify causal action', network[0]['sha256'] == network[1]['sha256'])
        if name == 'strict-held-revoke':
            check('revoke before forward left no result', len(server) == 0 and len(blocked) == 1 and blocked[0]['heldAt'] <= result['revokedAt'] and blocked[0]['reason'] == 'revoked-before-forward')
        if name == 'strict-forward-stop':
            check('request received before stop response after stop', forwarded[0]['forwardedAt'] <= server[0]['receivedAt'] <= result['revokedAt'] < forwarded[0]['responseAt'])

base = RUN / 'baseline-same-click'
cdp = read(base / 'cdp.json')
check('same synchronous initiator for expected and extra write', cdp[0]['initiator']['stack']['callFrames'] == cdp[1]['initiator']['stack']['callFrames'])
check('trusted click did not prevent extra write', any(d['type'] == 'click' and d['trusted'] for d in read(base / 'dom-events.json')))
base = RUN / 'baseline-disk-upload'
cdp = read(base / 'cdp.json')[0]
receipt = read(base / 'server.json')[0]
pw = read(base / 'browser-requests.json')[0]
check('disk bytes omitted from CDP and routed Playwright body', receipt['bytes'] - cdp['getPostData']['bytes'] == 8192 and pw['postData']['bytes'] == cdp['getPostData']['bytes'] and cdp.get('entries') is None)
base = RUN / 'baseline-redirect'
check('redirect escaped second page route', len(read(base / 'server.json')) == 2 and len(read(base / 'routes.json')) == 1)
base = RUN / 'page-route-service-worker'
check('page route missed service worker write', len(read(base / 'server.json')) == 1 and read(base / 'routes.json') == [] and read(base / 'browser-requests.json')[0]['serviceWorker'])
base = RUN / 'context-route-service-worker'
req = read(base / 'browser-requests.json')[0]
check('context route blocked service worker and frame unavailable', read(base / 'server.json') == [] and len(read(base / 'routes.json')) == 1 and req['serviceWorker'] and bool(req['frameError']))
base = RUN / 'strict-frame-form'
check('native form had no script initiator', read(base / 'cdp.json')[0]['initiator']['type'] == 'other' and read(base / 'browser-requests.json')[0]['navigation'])
check('ledger equals all received entities including redirects', ledger['writes'] == len(all_receipts) == 17)
check('ledger equals file receptions', ledger['uploads'] == sum('file' in r for r in all_receipts) == 3)
check('all browser cases within 60 minutes', max(r['finishedAt'] for r in all_results) - ledger['startedAt'] <= 60 * 60 * 1000)
report = {'status':'passed' if all(c['ok'] for c in checks) else 'failed', 'checks':checks,
          'caseCount':len(expected),'serverReceipts':len(all_receipts),'storedRecords':sum(r['effect']=='stored' for r in all_receipts),
          'proxyRefusals':negative_sends,'scriptSha256':digest(Path(__file__).read_bytes())}
(ARTIFACTS / 'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k != 'checks'}))
failed = [c['name'] for c in checks if not c['ok']]
if failed:
    print(json.dumps(failed,ensure_ascii=False))
    raise SystemExit(1)
