import type { TaskExecution } from './execution';
import type { LearnedWorkflow } from './workflow';

type Entry = { execution?: TaskExecution | null };
/** 采用事实只有记录进程能写；这里仅投影。旧资料若已有分叉，保留而不擅选。 */
export function workflowCatalog(entries: Entry[]) {
  const candidates = entries.flatMap(
    (e) => e.execution?.learnedWorkflows ?? [],
  );
  const byVersion = new Map(candidates.map((w) => [w.version, w]));
  const adopted = new Set(
    entries.flatMap(({ execution: e }) => [
      ...(e?.workflowDecisions ?? [])
        .filter((d) => d.status === 'adopted')
        .map((d) => d.version),
      ...(e?.workflowAdoption ? [e.workflowAdoption.version] : []),
    ]),
  );
  const root = (w: LearnedWorkflow) => {
    const seen = new Set<string>();
    while (w.parentVersion) {
      if (seen.has(w.version)) throw Error('WORKFLOW_LINEAGE_INVALID');
      seen.add(w.version);
      const parent = byVersion.get(w.parentVersion);
      if (!parent) return w.parentVersion;
      w = parent;
    }
    return w.version;
  };
  const superseded = new Set(
    candidates
      .filter((w) => adopted.has(w.version))
      .map((w) => w.parentVersion),
  );
  const heads = candidates.filter(
    (w) => adopted.has(w.version) && !superseded.has(w.version),
  );
  return { candidates, root, heads };
}

export function availableWorkflows(entries: Entry[]) {
  const { heads, root } = workflowCatalog(entries);
  return heads.filter(
    (w) => w.replay && heads.filter((h) => root(h) === root(w)).length === 1,
  );
}
