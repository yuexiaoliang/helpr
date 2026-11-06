import type { TaskExecution } from '../shared/execution';
import type { ExcelData } from '../shared/article';
import styles from './Workspace.module.css';

const status: Record<
  ExcelData['sheets'][number]['cells'][number]['status'],
  string
> = {
  value: '可引用',
  blank: '空白',
  'formula-unverified': '公式未重算',
  error: '错误值',
  'date-invalid': '日期无法确定',
  hidden: '隐藏内容',
  merged: '合并从属格',
};
export function ArticleSources({ execution }: { execution: TaskExecution }) {
  const article = execution.articles?.find(
    (a) => a.id === execution.publication?.articleId,
  );
  const source = execution.contentSources?.find(
    (s) => s.id === article?.sourceId,
  );
  if (!article || !source) return null;
  const material = execution.materials?.find((m) => m.id === source.materialId);
  return (
    <details className={styles.articleSources}>
      <summary>查看表格来源与不确定项</summary>
      <p>
        固定素材：{material?.name} · 选取于{' '}
        {new Date(material?.selectedAt ?? source.createdAt).toLocaleString()}
        。来源后来变化不会改动本版。
      </p>
      <p>
        处理要求：{source.requirements.goal}
        {source.requirements.answers.map((a) => '\n' + a.text).join('')}
      </p>
      <p>
        已核对引用位置和原值；段落含义仍请与原表核对。标为“建议”的文字不属于源表事实。
      </p>
      {article.author === 'user' && (
        <p>
          本版由你修改；保留仍完整匹配的原段落引用。新增或改写的文字未自动取得表格来源。
        </p>
      )}
      <ul>
        {source.notices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
      {article.blocks
        .filter((b) => b.citations.length)
        .map((block, index) => (
          <div key={index}>
            <p>{block.text}</p>
            <ul>
              {block.citations.map((c, i) => (
                <li key={i}>
                  {c.sheet}!{c.address}：{c.quote}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {source.sheets.map((sheet) => (
        <details key={sheet.name}>
          <summary>
            {sheet.name}
            {sheet.hidden ? '（隐藏）' : ''} · {sheet.cells.length} 个位置
          </summary>
          <div className={styles.sourceTable}>
            <table>
              <thead>
                <tr>
                  <th>位置</th>
                  <th>显示值</th>
                  <th>原值</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {sheet.cells.map((cell) => (
                  <tr key={cell.address}>
                    <td>{cell.address}</td>
                    <td>{cell.display || '（空）'}</td>
                    <td>
                      {cell.raw === null ? '无确定值' : String(cell.raw)}
                      {cell.formula && <div>公式：{cell.formula}</div>}
                    </td>
                    <td>
                      {status[cell.status]}
                      {cell.master && ` → ${cell.master}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </details>
  );
}
