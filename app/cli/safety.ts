export interface ServerIdentity {
  pid: number;
  home: string;
}

/** Refuse to signal a PID unless the live Taste service proves it owns it. */
export function assertStopTarget(info: { pid: number }, live: ServerIdentity | null, expectedHome: string): ServerIdentity {
  if (!live) throw new Error("Taste 未运行；运行信息可能已陈旧，未发送停止信号。");
  if (live.home !== expectedHome) throw new Error(`端口由另一个 Taste Runtime 使用：${live.home}；未发送停止信号。`);
  if (!Number.isSafeInteger(info.pid) || info.pid <= 0 || live.pid !== info.pid) {
    throw new Error("Taste 运行信息中的 PID 与当前服务不一致，未发送停止信号。");
  }
  return live;
}
