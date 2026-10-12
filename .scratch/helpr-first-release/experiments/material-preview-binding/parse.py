"""只读解析实验素材；不把业务列含义写进解析器。"""
import sys, json, hashlib, openpyxl
from datetime import date, datetime

file = sys.argv[1]
raw = open(file, 'rb').read()
formulas = openpyxl.load_workbook(file, data_only=False)
cached = openpyxl.load_workbook(file, data_only=True)
def scalar(value):
    return value.isoformat() if isinstance(value, (date, datetime)) else value
cells = []
for sheet in formulas:
    for row in sheet:
        for cell in row:
            value = cached[sheet.title][cell.coordinate].value if cell.data_type == 'f' else cell.value
            cells.append({'ref': sheet.title + '!' + cell.coordinate, 'sheet': sheet.title,
                'address': cell.coordinate, 'value': scalar(value),
                'type': 'blank' if value is None else 'boolean' if isinstance(value, bool) else 'number' if isinstance(value, (int, float)) else 'string',
                'formula': cell.value if cell.data_type == 'f' else None,
                'numberFormat': cell.number_format})
print(json.dumps({'sourceHash': hashlib.sha256(raw).hexdigest(), 'sourceBytes': len(raw),
    'parser': {'name': 'openpyxl', 'version': openpyxl.__version__, 'mode': 'formula-and-cached-values; no recalculation'},
    'cells': cells}, ensure_ascii=False, indent=2))
