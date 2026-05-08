import { Mutex } from 'async-mutex';
import type { Logger } from 'pino';
import type { Db } from '@chepibe-personal/shared';
import type { Client } from '@libsql/client';
import type { AudioHandler } from '../../infrastructure/groq/audio-handler';
import type { SessionActor } from '../../domain/session-actor';
import type { SessionEvent } from '../../types/session-events';
import { ok, err, type Result } from '../../types/result';

export type SessionActorFactory = (sessionId: string) => SessionActor;

export class SocketManager {
  private readonly actors = new Map<string, SessionActor>();
  private readonly lock = new Mutex();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionFactory: SessionActorFactory,
    private readonly logger: Logger,
  ) {}

  async createSession(sessionId: string): Promise<Result<SessionActor, Error>> {
    return this.lock.runExclusive(async () => {
      const existing = this.actors.get(sessionId);
      if (existing) {
        const status = existing.getStatus();
        if (status !== 'destroyed') {
          return ok(existing);
        }
      }

      const actor = this.sessionFactory(sessionId);
      this.actors.set(sessionId, actor);
      return ok(actor);
    });
  }

  async destroySession(sessionId: string): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      const actor = this.actors.get(sessionId);
      if (!actor) return ok(undefined);
      const result = await actor.destroy();
      this.actors.delete(sessionId);
      return result;
    });
  }

  getActor(sessionId: string): SessionActor | undefined {
    return this.actors.get(sessionId);
  }

  getActors(): SessionActor[] {
    return Array.from(this.actors.values());
  }

  startHeartbeat(intervalMs = 30000): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const all = this.getActors();
      this.logger.info(
        all.map((a) => ({ sessionId: a.sessionId, status: a.getStatus(), phoneNumber: a.getPhoneNumber() })),
        `Heartbeat: ${all.length} session(s) active`,
      );
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async destroy(): Promise<void> {
    this.stopHeartbeat();
    const all = this.getActors();
    await Promise.allSettled(all.map((a) => a.destroy()));
    this.actors.clear();
  }
}
