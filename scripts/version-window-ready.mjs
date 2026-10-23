// 验证入口的只读窗口准备。保留原绝对截止，不重启应用。
export async function showInspectableWindow({ request, ready, deadline, observe, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const remaining = () => {
    const left = deadline - now();
    if (left <= 0) throw Error('READY_DEADLINE');
    return left;
  };
  for (let attempt = 1; attempt <= 20; attempt++) {
    let inspection;
    try {
      inspection = await request({ kind: 'inspect' }, remaining());
    } catch (error) {
      // 宿主在窗口创建前的TypeError会被固定错误映射为此码。
      // 只在尚未ready的有限准备阶段重查，完整保留错误，不据此推定记录健康。
      observe({ attempt, error: error.message, at: now() });
      if (error.message !== 'RECORDS_UNAVAILABLE' || ready() || attempt === 20) throw error;
      await wait(Math.min(100, remaining()));
      continue;
    }
    observe({ attempt, inspection, at: now() });
    await request({ kind: 'show' }, remaining());
    return inspection;
  }
}
