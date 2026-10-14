import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: 'app/records/schema.ts',
  out: 'app/records/migrations',
});
