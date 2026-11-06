import { eq, and, ne } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

// 调用方在同一事务中保存标签、当前选中项和业务决定。
export function hideTaskTab(
  db: BetterSQLite3Database<typeof schema>,
  taskId: string,
) {
  db.update(schema.tasks)
    .set({ hidden: true })
    .where(eq(schema.tasks.id, taskId))
    .run();
  const next = db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.hidden, false), ne(schema.tasks.id, taskId)))
    .get();
  db.update(schema.workspace)
    .set({ active: next?.id ?? null })
    .where(eq(schema.workspace.active, taskId))
    .run();
}
