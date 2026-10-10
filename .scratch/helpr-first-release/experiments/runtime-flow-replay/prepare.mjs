import { execFileSync } from 'node:child_process';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { chromium } from 'playwright';

// 独立测试后台的登录准备，明确排除在流程学习/重放证据之外。
// 口令只从远端读入内存，不出现在 argv、日志和模型输入中。
const env = parseEnv(execFileSync('ssh', ['-o', 'BatchMode=yes', 'essh-home', "awk '/^WP_TEST_(USER|PASSWORD)=/' /home/yuexiaoliang/services/helpr-validation-wordpress/.env"], { encoding: 'utf8' }));
await mkdir('private', { recursive: true, mode: 0o700 });
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://home.ts-ali.internal:38080/wp-login.php');
  await page.getByRole('textbox', { name: 'Username or Email Address' }).fill(env.WP_TEST_USER);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(env.WP_TEST_PASSWORD);
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.waitForURL('**/wp-admin/');
  await writeFile('private/auth.json', JSON.stringify(await context.storageState()), { mode: 0o600 });
  await chmod('private/auth.json', 0o600);
  console.log(JSON.stringify({ prepared: true, user: env.WP_TEST_USER, url: page.url() }));
} finally { await browser.close(); }
