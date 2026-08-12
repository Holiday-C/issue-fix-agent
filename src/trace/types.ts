export type TraceEvent = Readonly<{
  type: "iteration_started" | "model_responded" | "tool_completed" | "agent_stopped";
  iteration: number;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}>;

export interface TraceSink {
  record(event: TraceEvent): Promise<void>;
}

export class NoopTraceSink implements TraceSink {
  public async record(_event: TraceEvent): Promise<void> {
    await Promise.resolve();
  }
}
