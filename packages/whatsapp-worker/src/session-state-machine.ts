import type { SessionStatus } from './types.js';
import { ok, err, type Result } from './types.js';

type TransitionRecord = {
  from: SessionStatus;
  to: SessionStatus;
  at: number;
  context: string;
};

type TransitionListener = (from: SessionStatus, to: SessionStatus, context: string) => void;

const ValidTransitions: Record<SessionStatus, SessionStatus[]> = {
  none: ['pending'],
  pending: ['connected', 'reconnecting', 'destroyed'],
  connected: ['reconnecting', 'destroyed'],
  reconnecting: ['connected', 'reconnecting', 'destroyed'],
  destroyed: [],
};

export class SessionStateMachine {
  private state: SessionStatus = 'none';
  private readonly log: TransitionRecord[] = [];
  private readonly listeners = new Set<TransitionListener>();

  canTransition(to: SessionStatus): boolean {
    return ValidTransitions[this.state].includes(to);
  }

  transition(to: SessionStatus, context: string): Result<void, Error> {
    if (!this.canTransition(to)) {
      return err(new Error(`Invalid transition: ${this.state} -> ${to}: ${context}`));
    }
    const from = this.state;
    this.log.push({ from, to, at: Date.now(), context });
    this.state = to;
    for (const cb of this.listeners) {
      try {
        cb(from, to, context);
      } catch {
        // Listener errors must not break the transition
      }
    }
    return ok(undefined);
  }

  getState(): SessionStatus {
    return this.state;
  }

  getLog(): readonly TransitionRecord[] {
    return this.log;
  }

  onTransition(cb: TransitionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
