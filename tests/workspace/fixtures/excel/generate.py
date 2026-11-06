"""确定性 OOXML 夹具；用标准库造文件，避免以被测解析库生成预期。"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo
root=Path(__file__).parent
ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
def book(name, sheet, date1904=False, extra=None):
    files={
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{int(date1904)}"/><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'xl/styles.xml': f'<styleSheet xmlns="{ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="10" applyNumberFormat="1"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{ns}">{sheet}</worksheet>'}
    files.update(extra or {})
    with ZipFile(root/name,'w') as z:
      for path,text in files.items():
        info=ZipInfo(path,(2026,1,1,0,0,0)); info.compress_type=ZIP_DEFLATED
        z.writestr(info,text)
def inline(ref,text): return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'
for name,first,second in [('report-a.xlsx',7,5),('report-b.xlsx',11,2)]:
    book(name, '<sheetData><row r="1">'+inline('A1','项目')+inline('B1','数量')+'</row><row r="2">'+inline('A2','甲')+f'<c r="B2"><v>{first}</v></c></row><row r="3">'+inline('A3','乙')+f'<c r="B3"><v>{second}</v></c></row><row r="4">'+inline('A4','合计')+'<c r="B4"><f>SUM(B2:B3)</f><v>999</v></c></row></sheetData>')
edge='''<cols><col min="8" max="8" hidden="1"/></cols><sheetData>
<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1"><v>0</v></c><c r="C1" t="b"><v>0</v></c><c r="D1" t="inlineStr"><is><t></t></is></c><c r="E1" t="e"><v>#DIV/0!</v></c><c r="F1" s="2"><v>0.125</v></c><c r="H1"><v>8</v></c></row>
<row r="2"><c r="A2" s="1"><v>60</v></c><c r="B2"><f>1+1</f></c><c r="C2"><f>1-1</f><v>0</v></c><c r="D2"><f t="shared" si="99"/><v>123</v></c><c r="E2"><f t="array" ref="E2:F2">A1:B1</f><v>1</v></c><c r="F2"><v>9</v></c></row>
<row r="3"><c r="A3" s="1"><v>45292</v></c><c r="B3" t="inlineStr"><is><t>合并标题</t></is></c><c r="D3"><f t="shared" si="1" ref="D3:E3">A1</f><v>1</v></c><c r="E3"><f t="shared" si="1"/><v>0</v></c></row>
<row r="4" hidden="1"><c r="A4"><v>4</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="B3:C3"/></mergeCells>'''
book('edges-1900.xlsx',edge)
book('edges-1904.xlsx',edge,True)
book('external.xlsx','<sheetData/>',extra={'xl/externalLinks/externalLink1.xml':'<externalLink/>'})
book('oversize-range.xlsx','<sheetData><row r="2001"><c r="A2001"><v>1</v></c></row></sheetData>')
book('inflated.xlsx','<sheetData/>',extra={'padding.txt':'x'*(16*1024*1024+1)})
