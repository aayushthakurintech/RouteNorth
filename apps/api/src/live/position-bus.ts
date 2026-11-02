import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

export interface PositionBus {
  /** Subscribe to one organization's positions. Returns an unsubscribe function. */
  subscribe(orgId: string, onMessage: (json: string) => void): Promise<() => Promise<void>>;
  publish(orgId: string, json: string): Promise<void>;
  close(): Promise<void>;
}

const channel = (orgId: string) => `positions:${orgId}`;

/** In-process bus for tests and single-node dev without Redis. */
export class MemoryPositionBus implements PositionBus {
  private readonly emitter = new EventEmitter();

  async subscribe(orgId: string, onMessage: (json: string) => void) {
    this.emitter.on(channel(orgId), onMessage);
    return async () => { this.emitter.off(channel(orgId), onMessage); };
  }
  async publish(orgId: string, json: string) { this.emitter.emit(channel(orgId), json); }
  async close() { this.emitter.removeAllListeners(); }
}

/** Redis pub/sub bus: the ingest service publishes, every API node fans out to its sockets. */
export class RedisPositionBus implements PositionBus {
  private readonly sub: Redis;
  private readonly pub: Redis;
  private readonly handlers = new Map<string, Set<(json: string) => void>>();

  constructor(url: string) {
    this.sub = new Redis(url);
    this.pub = new Redis(url);
    this.sub.on("message", (ch: string, msg: string) => {
      for (const h of this.handlers.get(ch) ?? []) h(msg);
    });
  }

  async subscribe(orgId: string, onMessage: (json: string) => void) {
    const ch = channel(orgId);
    let set = this.handlers.get(ch);
    if (!set) {
      set = new Set();
      this.handlers.set(ch, set);
      await this.sub.subscribe(ch);
    }
    set.add(onMessage);
    return async () => {
      set!.delete(onMessage);
      if (set!.size === 0) {
        this.handlers.delete(ch);
        await this.sub.unsubscribe(ch);
      }
    };
  }
  async publish(orgId: string, json: string) { await this.pub.publish(channel(orgId), json); }
  async close() { this.sub.disconnect(); this.pub.disconnect(); }
}
