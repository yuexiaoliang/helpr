import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  goal: text('goal').notNull(),
  created: integer('created').notNull(),
  url: text('url').notNull(),
  draft: text('draft').notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull(),
  minimized: integer('minimized', { mode: 'boolean' }).notNull(),
  phase: text('phase').notNull(),
  error: text('error').notNull(),
  version: integer('version').notNull(),
});
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  role: text('role').notNull(),
  text: text('text').notNull(),
});
export const requests = sqliteTable('requests', {
  id: text('id').primaryKey(),
  hash: text('hash').notNull(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
});
export const workspace = sqliteTable('workspace', {
  id: integer('id').primaryKey(),
  active: text('active').references(() => tasks.id),
  revision: integer('revision').notNull(),
  schemaVersion: integer('schema_version').notNull(),
});
