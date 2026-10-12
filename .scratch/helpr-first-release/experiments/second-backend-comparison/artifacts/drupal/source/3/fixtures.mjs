// Drupal 站点准备数据与独立断言；不导入执行器，也不把定位信息交给学习提示。
import {copyFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {hash,save} from './protocol.mjs';

export async function fixture(root,name,variant='publish') {
  const directory=path.join(root,name);await mkdir(directory,{recursive:true});
  const source=name==='learn'?'learn':name.includes('collision')?'updated':'replay';
  const fileName=`${name}-${path.basename(root)}.xlsx`,filePath=path.join(directory,fileName);
  await copyFile(`../runtime-flow-replay/materials/${source}.xlsx`,filePath);
  const expected={origin:'http://home.ts-ali.internal:38081',entryUrl:'http://home.ts-ali.internal:38081/admin/content',
    title:name.includes('collision')?'Title':`第二后台对照 ${name} ${path.basename(root)}`,
    body:`全部内容和附件均为虚构测试素材。样本 ${name}，核对编号 ${hash(name+path.basename(root)).slice(0,10)}。保留原始 Excel 文件，不改写其内容。`,
    category:'Excel 验证',fileName,filePath};
  const operation=variant==='update'?'修改已存在的日报，目标内容地址为 http://home.ts-ali.internal:38081/node/1':'使用站点已有的日报内容类型新建一篇内容';
  const visibility=variant==='draft'?'只保存为草稿，不允许公开发布':'立即公开发布';
  const handling=variant==='summarize'?'读取 Excel 数据生成正文摘要，不要提供原文件下载链接':'将原始 Excel 文件作为这篇内容的可下载附件，不读取或改写 Excel 内容';
  const body=variant==='summarize'?'正文根据附件数据生成摘要':`正文完整内容是「${expected.body}」`;
  const text=`【隔离实验授权】这是虚构测试委托，允许在指定测试网站完成本次工作。${operation}；${visibility}。标题是「${expected.title}」，${body}，栏目选择「${expected.category}」。使用附带素材，${handling}。只允许本次委托指定的内容和附件操作，不改动其它已有内容、账号或网站设置。上述内容、上传及发布方式均已授权，不增加建议内容。`;
  const f={directory,expected,envelope:{id:name,testAuthorization:true,text,origin:expected.origin,entryUrl:expected.entryUrl,
    attachments:[{id:'material-1',name:fileName,path:filePath,sha256:hash(await readFile(filePath))}]}};
  await save(path.join(directory,'fixture.json'),f);return f;
}

export async function oracle(browser,resultUrl,f) {
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
  try {
    assert.equal(new URL(resultUrl).origin,f.expected.origin);
    await page.goto(resultUrl,{waitUntil:'domcontentloaded',timeout:60000});
    const title=await page.locator('main h1').innerText();
    const article=page.locator('article');
    const body=await article.locator('.field--name-body').innerText();
    const category=article.locator('.field--name-field-section a');
    const attachment=article.locator('.field--name-field-attachment a');
    assert.equal(title.trim(),f.expected.title);assert.equal(body.trim(),f.expected.body);
    assert.equal((await category.innerText()).trim(),f.expected.category);
    const categoryUrl=new URL(await category.getAttribute('href'),resultUrl).href;
    const [download]=await Promise.all([page.waitForEvent('download'),attachment.click()]);
    const downloaded=path.join(f.directory,'oracle-download.xlsx');await download.saveAs(downloaded);
    const actual=hash(await readFile(downloaded)),expected=hash(await readFile(f.expected.filePath));assert.equal(actual,expected);
    await page.screenshot({path:path.join(f.directory,'oracle-public.png'),fullPage:true});
    await page.goto(categoryUrl,{waitUntil:'domcontentloaded'});
    const listing=page.getByRole('link',{name:f.expected.title,exact:true});assert.ok(await listing.count()>=1);
    const result={title,body,category:f.expected.category,categoryUrl,resultUrl,downloadSha256:actual,sourceSha256:expected,anonymous:true,passed:true};
    await save(path.join(f.directory,'oracle.json'),result);return result;
  } finally {await context.close();}
}
