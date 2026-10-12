"""独立用例断言：原 Excel -> 实际文章与下载。避免调用生成/版本模块自证。"""
import json, re, hashlib
from pathlib import Path
import openpyxl

root = Path(__file__).parent / 'artifacts/current'
checks = []
def require(name, ok, **detail):
    checks.append({'name': name, 'passed': bool(ok), **detail})
for task, version, total in [('A','v2',16),('B','v1',10),('C','v2',16)]:
    bundle = json.loads((root/f'bundle-{task}.json').read_text())
    out = root/f'publication-{task}'
    observation = json.loads((out/'public-observation.json').read_text())
    result = json.loads((out/'result.json').read_text())
    text = observation['text']
    original = (root.parent.parent/'fixtures'/f'{version}.xlsx').read_bytes()
    downloaded = (out/'download.xlsx').read_bytes()
    sheet = openpyxl.load_workbook(root.parent.parent/'fixtures'/f'{version}.xlsx',data_only=True)['虚构台账']
    actual_facts = []
    for row in [2,3,4]:
        identifier, quantity, unit = [sheet.cell(row,col).value for col in [1,2,3]]
        matches = re.findall(re.escape(identifier)+r'(?:[：:,，\s]|数量)*([0-9]+)\s*'+re.escape(unit), text)
        require(f'{task}-row-{row}-source-fact', matches == [str(quantity)], ref=f'虚构台账!A{row}:C{row}', expected=quantity, actual=matches)
        actual_facts.append(quantity)
    require(f'{task}-independent-sum', sum(actual_facts)==total and re.findall(r'合计[：:\s]*([0-9]+)份',text)==[str(total)], expected=total)
    require(f'{task}-preview-exact-body',bundle['content']['body'] in text and text.count(bundle['content']['body'])==1)
    require(f'{task}-preview-exact-title',observation['heading']==bundle['content']['title'])
    require(f'{task}-source-exact-attachment',original==downloaded,sourceHash=hashlib.sha256(original).hexdigest(),downloadHash=hashlib.sha256(downloaded).hexdigest())
    require(f'{task}-public-target', any(l['text'].strip()=='Excel 验证' and l['href'].endswith('/?cat=2') for l in observation['links']))
    require(f'{task}-public-fictitious-label','全部为虚构测试数据' in text)
    require(f'{task}-observed-publication', result['passed'] and observation['unauthenticated'] and observation['url']==result['resultUrl'])
    require(f'{task}-no-model-replay',result['modelCalls']==0 and len(result['steps'])==17)
require('three-distinct-results',len({json.loads((root/f'publication-{t}/result.json').read_text())['resultUrl'] for t in 'ABC'})==3)
require('A-edit-preserved','核对备注：按已选版本记录。' in (root/'publication-A/public-text.txt').read_text())
require('B-independent-old-version', '核对备注：' not in (root/'publication-B/public-text.txt').read_text())
report = {'passed':all(c['passed'] for c in checks),'checks':checks,'count':len(checks)}
(root/'independent-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':report['passed'],'checks':len(checks),'failures':[c for c in checks if not c['passed']]},ensure_ascii=False))
raise SystemExit(0 if report['passed'] else 1)
