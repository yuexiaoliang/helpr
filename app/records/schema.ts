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
  callId: text('model_call_id'),
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

export const modelSettings = sqliteTable('model_settings', {
  version: integer('version').primaryKey({ autoIncrement: true }),
  requestId: text('request_id').notNull().unique(),
  hash: text('hash').notNull(),
  endpoint: text('endpoint').notNull(),
  model: text('model').notNull(),
  ciphertext: text('ciphertext').notNull(),
});
export const modelCalls = sqliteTable('model_calls', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  hash: text('hash').notNull(),
  configurationVersion: integer('configuration_version')
    .notNull()
    .references(() => modelSettings.version),
  model: text('model').notNull(),
  phase: text('phase').notNull(),
  source: text('source', { mode: 'json' }),
  output: text('output').notNull().default(''),
  error: text('error'),
  pageChanged: integer('page_changed', { mode: 'boolean' })
    .notNull()
    .default(false),
  dispatched: integer('dispatched', { mode: 'boolean' })
    .notNull()
    .default(false),
  reservedTokens: integer('reserved_tokens').notNull().default(0),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalTokens: integer('total_tokens'),
});
