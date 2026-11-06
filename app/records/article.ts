import { createHash, randomUUID } from 'node:crypto';
import type { TaskExecution } from '../shared/execution';
import type { Publication } from '../shared/publication';
import {
  ARTICLE_PROMPT_VERSION,
  articleDraftSchema,
  contentRequestText,
  articleText,
  type ArticleDraft,
  type ContentSource,
  type ArticleVersion,
} from '../shared/article';

export function contentSourceHash(
  source: Omit<ContentSource, 'sha256'> | ContentSource,
) {
  const { sha256: _hash, ...body } = source as ContentSource;
  void _hash;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export function contentRequirements(e: TaskExecution) {
  return {
    goal: e.goal,
    answers: (e.answers ?? [])
      .filter((a) => a.goalVersion === e.goalVersion)
      .map((a) => ({ questionId: a.id, text: a.answer })),
  };
}
export function currentArticle(e: TaskExecution) {
  return e.articles?.findLast((a) => a.goalVersion === e.goalVersion);
}
export function contentCallHash(taskId: string, source: ContentSource) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        taskId,
        contentRequestText(source),
        null,
        'execution',
        'material-content',
      ]),
    )
    .digest('hex');
}
export function validArticleModelCalls(
  taskId: string,
  e: TaskExecution,
  calls: {
    call: { id: string; taskId: string; phase: string; usageKind?: string };
    hash: string;
    output: string;
  }[],
) {
  return (e.articles ?? [])
    .filter((a) => a.author === 'model')
    .every((a) => {
      const source = e.contentSources?.find((s) => s.id === a.sourceId);
      const saved = calls.find((c) => c.call.id === a.modelCallId);
      if (
        !source ||
        !saved ||
        saved.call.taskId !== taskId ||
        saved.call.phase !== 'complete' ||
        saved.call.usageKind !== 'material-content' ||
        saved.hash !== contentCallHash(taskId, source)
      )
        return false;
      try {
        return (
          JSON.stringify(
            articleDraftSchema.parse(
              (JSON.parse(saved.output) as { article: unknown }).article,
            ),
          ) === JSON.stringify({ destination: a.destination, blocks: a.blocks })
        );
      } catch {
        return false;
      }
    });
}
export function checkArticleDraft(source: ContentSource, draft: ArticleDraft) {
  for (const block of draft.blocks) {
    if (block.kind === 'fact' && !block.citations.length)
      throw Error('ARTICLE_FACT_INVALID');
    if (
      block.kind === 'suggestion' &&
      (block.citations.length || /\d/u.test(block.text))
    )
      throw Error('ARTICLE_FACT_INVALID');
    const values: string[] = [];
    for (const citation of block.citations) {
      const cell = source.sheets
        .find((s) => s.name === citation.sheet)
        ?.cells.find((c) => c.address === citation.address);
      if (
        !cell ||
        cell.status !== 'value' ||
        ![cell.display, String(cell.raw ?? '')].includes(citation.quote)
      )
        throw Error('ARTICLE_FACT_INVALID');
      values.push(citation.quote);
    }
    // 只允许引用已观察到的数值，不让模型用未经执行核验的心算充当源表事实。
    const numbers = (text: string) =>
      text.match(/[+-]?\d+(?:[.,]\d+)*/gu) ?? [];
    const allowed = values.flatMap(numbers);
    if (numbers(block.text).some((n) => !allowed.includes(n)))
      throw Error('ARTICLE_FACT_INVALID');
  }
  if (articleText(draft).length > 4000) throw Error('ARTICLE_FACT_INVALID');
}
export function generatedArticle(
  e: TaskExecution,
  source: ContentSource,
  draft: ArticleDraft,
  callId: string,
): ArticleVersion {
  checkArticleDraft(source, draft);
  const requirements = [
    source.requirements.goal,
    ...source.requirements.answers.map((a) => a.text),
  ];
  if (!requirements.some((t) => t.includes(draft.destination)))
    throw Error('ARTICLE_FACT_INVALID');
  return {
    ...draft,
    id: randomUUID(),
    parentId: currentArticle(e)?.id ?? null,
    sourceId: source.id,
    goalVersion: e.goalVersion,
    content: articleText(draft),
    author: 'model',
    modelCallId: callId,
    promptVersion: ARTICLE_PROMPT_VERSION,
    createdAt: Date.now(),
  };
}
export function publicationArticle(
  e: TaskExecution,
  p: Publication,
  historical = false,
) {
  const article = e.articles?.find((a) => a.id === p.articleId);
  if (
    !p.articleId &&
    !currentArticle(e) &&
    !e.contentSources?.some((s) => s.goalVersion === e.goalVersion)
  )
    return;
  if (
    !article ||
    (!historical && currentArticle(e)?.id !== article.id) ||
    article.content !== p.content ||
    article.destination !== p.destination ||
    (!historical && article.goalVersion !== e.goalVersion) ||
    !e.contentSources?.some(
      (s) =>
        s.id === article.sourceId && s.materialId === p.attachment?.materialId,
    )
  )
    throw Error('ARTICLE_BINDING_MISMATCH');
}
export function editArticle(e: TaskExecution, content: string) {
  const p = e.publication!;
  if (!p.articleId) return;
  publicationArticle(e, p);
  const parent = currentArticle(e)!;
  if ((e.articles?.length ?? 0) >= 60) throw Error('EXECUTION_LIMIT');
  const article: ArticleVersion = {
    ...parent,
    id: randomUUID(),
    parentId: parent.id,
    content,
    author: 'user',
    modelCallId: null,
    createdAt: Date.now(),
    blocks: parent.blocks.filter((b) => content.includes(b.text)),
  };
  e.articles!.push(article);
  p.articleId = article.id;
}
export function validArticleReferences(e: TaskExecution) {
  try {
    const sources = e.contentSources ?? [],
      articles = e.articles ?? [];
    if (
      new Set(sources.map((s) => s.id)).size !== sources.length ||
      new Set(articles.map((a) => a.id)).size !== articles.length
    )
      return false;
    if (
      sources.some(
        (s) =>
          contentSourceHash(s) !== s.sha256 ||
          !e.materials?.some(
            (m) =>
              m.id === s.materialId &&
              m.sha256 === s.materialSha256 &&
              m.goalVersion === s.goalVersion,
          ),
      )
    )
      return false;
    for (const [index, a] of articles.entries()) {
      const source = sources.find(
        (s) => s.id === a.sourceId && s.goalVersion === a.goalVersion,
      );
      if (
        !source ||
        (a.parentId &&
          !articles
            .slice(0, index)
            .some(
              (p) =>
                p.id === a.parentId &&
                p.goalVersion === a.goalVersion &&
                (a.author === 'model' || p.sourceId === a.sourceId),
            )) ||
        (a.author === 'model' &&
          (!a.modelCallId || a.content !== articleText(a)))
      )
        return false;
      checkArticleDraft(source, a);
    }
    if (e.publication) publicationArticle(e, e.publication);
    for (const a of e.actions)
      if (a.submission?.publication.articleId)
        publicationArticle(e, a.submission.publication, true);
    return true;
  } catch {
    return false;
  }
}
