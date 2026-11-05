import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/workspace/**/*.test.{ts,tsx}'],
    // macOS 的宿主身份测试要启动真实子进程，与其它测试文件抢占资源时曾触及截止。
    fileParallelism: process.platform !== 'darwin',
    testTimeout: 10000,
  },
});
