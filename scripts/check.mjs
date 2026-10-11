// 检查当前工作树；只运行本机夹具和已保存证据，不读取模型凭据。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const experiment = '.scratch/helpr-first-release/experiments/';
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
}).split('\0'))].filter(file => /\.(?:mjs|cjs|js)$/.test(file)
  && !/(?:^|\/)(?:artifacts|private|node_modules)(?:\/|$)/.test(file)
  && existsSync(new URL(file, new URL('../', import.meta.url))));

try {
  for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
  }
  console.log(`语法检查通过：${files.length} 个源码文件（排除历史快照）。`);
  execFileSync(process.execPath, ['--test', experiment + 'model-api/client.test.mjs', experiment + 'ai-parallel-binding/control.test.mjs', experiment + 'result-recovery/record.test.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [experiment + 'ai-parallel-binding/verify.mjs', '--check'], { cwd: root, stdio: 'inherit' });
} catch (error) {
  if (error.stderr?.length) process.stderr.write(error.stderr);
  process.exitCode = 1;
}
