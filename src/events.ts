import { EventEmitter } from "node:events";

export interface EngineEvent {
  type: "run_created" | "step" | "trace" | "needs_input" | "resumed" | "submitted" | "failed";
  runId: string;
  data: any;
  timestamp: string;
}

class EngineEventEmitter extends EventEmitter {
  emitEvent(type: EngineEvent["type"], runId: string, data: any): void {
    const event: EngineEvent = {
      type,
      runId,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emit("event", event);
    this.emit(`event:${runId}`, event);
  }
}

export const engineEvents = new EngineEventEmitter();
