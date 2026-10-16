import { createRequire } from 'node:module';
import { z } from 'zod';

const gateState = z.object({
  epoch: z.number().int().nonnegative(),
  available: z.boolean(),
  blocked: z.boolean(),
});
export const nativeInputEventSchema = z.strictObject({
  owner: z.string().max(100),
  kind: z.enum(['mouse', 'keyboard', 'paste']),
  serial: z.number().int().nonnegative(),
});
type NativeInputEvent = z.infer<typeof nativeInputEventSchema>;
type NativeBridge = {
  open(file: string, create: boolean): void;
  state(taskId: string): z.infer<typeof gateState>;
  trip(taskId: string): void;
  available(value: boolean): void;
  allow(taskId: string, epoch: number): boolean;
  permit<T>(taskId: string, epoch: number, send: () => T): T;
  install(handle: Buffer, listener: (event: unknown) => void): void;
  tagRegion(
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    px: number,
    py: number,
  ): void;
  untag(label: string): void;
  focused(): string;
  traceStart(): void;
};
/** 本机同步资格门。持锁仅检查并交付一个发送，绝不等待记录、网络或IPC回执。 */
export class InputGate {
  private native: NativeBridge | undefined;
  readonly failureCode:
    'NATIVE_INPUT_LOAD_FAILED' | 'NATIVE_INPUT_GATE_OPEN_FAILED' | undefined;
  constructor(binary: string, file: string, create: boolean) {
    let bridge: NativeBridge;
    try {
      bridge = createRequire(binary)(binary) as NativeBridge;
    } catch {
      this.failureCode = 'NATIVE_INPUT_LOAD_FAILED';
      return;
    }
    try {
      bridge.open(file, create);
      this.native = bridge;
    } catch {
      /* 缺少本机能力仍允许查看网页，但任何自动派发都拒绝。 */
      this.failureCode = 'NATIVE_INPUT_GATE_OPEN_FAILED';
    }
  }
  state(taskId: string) {
    if (!this.native) return { epoch: 0, available: false, blocked: true };
    return gateState.parse(this.native.state(taskId));
  }
  block(taskId: string) {
    this.native?.trip(taskId);
  }
  available(value: boolean) {
    this.native?.available(value);
  }
  allow(taskId: string, epoch: number) {
    return this.native?.allow(taskId, epoch) ?? false;
  }
  valid(taskId: string, epoch: number) {
    const state = this.state(taskId);
    return state.available && !state.blocked && state.epoch === epoch;
  }
  permit<T>(taskId: string, epoch: number, send: () => T): T {
    if (!this.native) throw Error('NATIVE_INPUT_UNAVAILABLE');
    return this.native.permit(taskId, epoch, send);
  }
  install(handle: Buffer, listener: (event: NativeInputEvent) => void) {
    if (!this.native) throw Error('NATIVE_INPUT_UNAVAILABLE');
    this.native.install(handle, (event) =>
      listener(nativeInputEventSchema.parse(event)),
    );
  }
  bind(
    label: string,
    bounds: { x: number; y: number; width: number; height: number },
    point: { x: number; y: number },
  ) {
    if (!this.native) throw Error('NATIVE_INPUT_UNAVAILABLE');
    this.native.tagRegion(
      label,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      point.x,
      point.y,
    );
  }
  unbind(label: string) {
    this.native?.untag(label);
  }
  focused() {
    return this.native?.focused() ?? 'unknown';
  }
  startValidationTrace() {
    this.native?.traceStart();
  }
}
