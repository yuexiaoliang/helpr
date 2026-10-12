// 实验用 Module：只控制本次执行的浏览器动作，不是产品状态模型。
export class Stopped extends Error {
  constructor() { super('Execution stopped or superseded'); this.name = 'Stopped'; }
}

export class ExecutionControl {
  constructor(task, log) {
    this.task = task;
    this.log = log;
    this.generation = 1;
    this.active = true;
    this.abort = new AbortController();
    this.pending = new Set();
  }

  ticket() {
    return Object.freeze({ owner: this, generation: this.generation, signal: this.abort.signal });
  }

  check(ticket, operation) {
    if (ticket.owner !== this || ticket.generation !== this.generation || !this.active || ticket.signal.aborted) {
      this.log({ kind: 'rejected-stale-work', task: this.task, generation: ticket.generation, operation });
      throw new Stopped();
    }
  }

  dispatch(ticket, operation, action) {
    // 最后一次检查到调用单个浏览器原语之间没有 await。
    const pending = (async () => {
      this.check(ticket, operation);
      this.log({ kind: 'dispatch', task: this.task, generation: ticket.generation, operation });
      const value = await action(ticket.signal);
      this.check(ticket, operation + ':result');
      return value;
    })();
    this.pending.add(pending);
    const remove = () => this.pending.delete(pending);
    pending.then(remove, remove);
    return pending;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.log({ kind: 'stop', task: this.task, generation: this.generation });
    this.abort.abort(new Stopped());
  }

  async settled() {
    await Promise.allSettled([...this.pending]);
    this.log({ kind: 'browser-calls-settled', task: this.task, generation: this.generation });
  }

  startNewExecution() {
    if (this.active || this.pending.size) throw new Error('Old browser calls must settle first');
    this.generation++;
    this.abort = new AbortController();
    this.active = true;
    this.log({ kind: 'new-execution', task: this.task, generation: this.generation });
    return this.ticket();
  }
}
