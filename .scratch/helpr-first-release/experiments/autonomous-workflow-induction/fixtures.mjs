// 独立测试夹具及断言；这里的站点与业务知识不输入执行器的代码或学习提示。
import { copyFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './runtime.mjs';
import { verifyPublication } from '../runtime-flow-replay/verify.mjs';

export async function fixture(root, name, variant = 'publish') {
  const directory = path.join(root, name); await mkdir(directory, { recursive: true });
  const source = name === 'learn' ? 'learn' : name.includes('collision') ? 'updated' : 'replay';
  const fileName = `${name}-${path.basename(root)}.xlsx`, filePath = path.join(directory, fileName);
  await copyFile(`../runtime-flow-replay/materials/${source}.xlsx`, filePath);
  const expected = {
    origin: 'http://home.ts-ali.internal:38080', entryUrl: 'http://home.ts-ali.internal:38080/wp-admin/',
    title: name.includes('collision') ? 'File' : `自主归纳 ${name} ${path.basename(root)}`,
    body: `本文与附件均为虚构实验素材。样本 ${name}，校验编号 ${hash(name + path.basename(root)).slice(0, 10)}。请保留原始文件，不改写表格内容。`,
    category: 'Excel 验证', fileName, filePath
  };
  const operation = variant === 'update' ? '修改已经存在的文章，目标文章地址为 http://home.ts-ali.internal:38080/?p=6' : '新建一篇文章';
  const visibility = variant === 'draft' ? '只保存为草稿，不允许公开发布' : '立即公开发布';
  const handling = variant === 'summarize' ? '读取 Excel 的数据生成正文摘要，不要放置原文件下载链接' : '把原始 Excel 文件作为可下载附件加入正文，不读取或改写 Excel 内容';
  const content = variant === 'summarize' ? '正文应根据附件数据生成摘要' : `正文完整内容是「${expected.body}」`;
  const scope = variant === 'update' ? '只允许修改本次指定的目标文章，不得改动其它文章或网站设置' : '除本次新建测试记录外，不得改动已有文章或网站设置';
  const text = `【隔离实验授权】这是一份虚构测试委托，允许在指定测试网站上完成本次任务。${operation}；${visibility}。标题是「${expected.title}」，${content}，只选择分类「${expected.category}」，不选默认分类。使用附带素材，${handling}。${scope}。本段中的内容、上传及上述发布方式均已作为实验要求授权；不要自行增加建议内容。`;
  return { directory, expected, envelope: { id: name, testAuthorization: true, text,
    origin: expected.origin, entryUrl: expected.entryUrl,
    attachments: [{ id: 'material-1', name: fileName, path: filePath, sha256: hash(await readFile(filePath)) }] } };
}

export const oracle = (browser, resultUrl, f) => verifyPublication(browser, resultUrl, f.expected, f.directory);

export function controlledChange(name, log) {
  let injected = false;
  return async (step, page, task) => {
    if (injected || step.action.op !== 'fill' || !step.action.value?.input || task.inputs[step.action.value.input]?.type !== 'string') return;
    injected = true;
    const { locate, bind } = await import('./runtime.mjs');
    const target = locate(page, bind(step.action.target, task.inputs));
    await target.waitFor({ state: 'visible' });
    // 仅改变本次页面的可访问名称，用作“不再适用时正确停止”的受控反例。
    await target.evaluate(el => { el.setAttribute('aria-label', '实验变更后的输入字段'); if (el.hasAttribute('placeholder')) el.setAttribute('placeholder', '实验变更后的输入字段'); });
    log.push({ type: 'fixture-mutation', name, step: step.id, injected: true });
  };
}
