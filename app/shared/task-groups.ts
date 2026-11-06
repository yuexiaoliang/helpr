import { explicitWebsite } from './url-policy';
import type { TaskExecution } from './execution';

export function endedExecution(execution?: TaskExecution | null) {
  return (
    !!execution && ['complete', 'failed', 'stopped'].includes(execution.phase)
  );
}

// 只拆分明确并列的目的地。保留共同要求；有先后关系或条件从句时按完整委托保存。
type Member = { goal: string; url: string; destination?: string };

export function splitDelegation(goal: string, keepTogether = false): Member[] {
  const single = [{ goal, url: explicitWebsite(goal) }];
  if (keepTogether || /然后|随后|再把|再将|如果|完成后|之后|[；;]/u.test(goal))
    return single;
  const after =
    /^(?<lead>.*?)(?:分别|各自)?(?<verb>(?:发送|发布|提交|上传|同步|投递|发|放|转发|分享)(?:到|给|至))\s*(?<targets>.+?)(?<tail>[。！？]?)$/u.exec(
      goal,
    )?.groups;
  const before =
    /^(?<lead>.*?)(?:分别|各自)(?<verb>在|向)\s*(?<targets>.+?)\s*(?<tail>上发布.*|发布.*|提交.*|上传.*)$/u.exec(
      goal,
    )?.groups;
  const clause = after ?? before;
  if (
    !clause?.targets ||
    /[，,：]|并且|同时|并将|再从|下载|读取/u.test(clause.targets)
  )
    return single;
  const destinations = clause.targets
    .split(/\s*(?:、|以及|和|与)\s*/u)
    .map((p) => p.trim());
  if (
    destinations.length < 2 ||
    destinations.length > 12 ||
    destinations.some((p) => !p) ||
    new Set(destinations).size !== destinations.length
  )
    return single;
  return destinations.map((destination) => ({
    goal: clause.lead! + clause.verb! + destination + clause.tail!,
    url: explicitWebsite(destination),
    destination,
  }));
}
