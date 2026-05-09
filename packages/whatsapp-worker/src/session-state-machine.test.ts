import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStateMachine } from './session-state-machine.js';
import type { SessionStatus } from './types.js';

const AllStatuses: SessionStatus[] = [
  'none', 'pending', 'connected', 'reconnecting', 'destroyed',
];

const ValidTransitions: Record<SessionStatus, SessionStatus[]> = {
  none: ['pending'],
  pending: ['connected', 'reconnecting', 'destroyed'],
  connected: ['reconnecting', 'destroyed'],
  reconnecting: ['connected', 'reconnecting', 'destroyed'],
  destroyed: [],
};

describe('SessionStateMachine', () => {
  let machine: SessionStateMachine;

  beforeEach(() => {
    machine = new SessionStateMachine();
  });

  describe('initial state', () => {
    it('starts in "none" state', () => {
      expect(machine.getState()).toBe('none');
    });

    it('has an empty transition log', () => {
      expect(machine.getLog()).toEqual([]);
    });
  });

  describe('canTransition', () => {
    it.each(AllStatuses.filter((s) => s !== 'none') as SessionStatus[])(
      'returns false for invalid transition from none to %s',
      (to) => {
        if (!ValidTransitions.none.includes(to)) {
          expect(machine.canTransition(to)).toBe(false);
        }
      },
    );

    it('returns true for valid transition none -> pending', () => {
      expect(machine.canTransition('pending')).toBe(true);
    });

    it('returns false for valid target when not in correct source state', () => {
      expect(machine.canTransition('connected')).toBe(false);
    });
  });

  describe('valid transitions', () => {
    it('none -> pending', () => {
      const result = machine.transition('pending', 'session-start');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('pending');
    });

    it('pending -> connected', () => {
      machine.transition('pending', 'session-start');
      const result = machine.transition('connected', 'connection-established');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('connected');
    });

    it('pending -> reconnecting', () => {
      machine.transition('pending', 'session-start');
      const result = machine.transition('reconnecting', 'connection-lost');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('reconnecting');
    });

    it('pending -> destroyed', () => {
      machine.transition('pending', 'session-start');
      const result = machine.transition('destroyed', 'session-killed');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('destroyed');
    });

    it('connected -> reconnecting', () => {
      machine.transition('pending', 'session-start');
      machine.transition('connected', 'connection-established');
      const result = machine.transition('reconnecting', 'connection-lost');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('reconnecting');
    });

    it('connected -> destroyed', () => {
      machine.transition('pending', 'session-start');
      machine.transition('connected', 'connection-established');
      const result = machine.transition('destroyed', 'session-killed');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('destroyed');
    });

    it('reconnecting -> connected', () => {
      machine.transition('pending', 'session-start');
      machine.transition('connected', 'connection-established');
      machine.transition('reconnecting', 'connection-lost');
      const result = machine.transition('connected', 'connection-restored');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('connected');
    });

    it('reconnecting -> reconnecting (self-loop)', () => {
      machine.transition('pending', 'session-start');
      machine.transition('connected', 'connection-established');
      machine.transition('reconnecting', 'connection-lost');
      const result = machine.transition('reconnecting', 'retry-connection');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('reconnecting');
    });

    it('reconnecting -> destroyed', () => {
      machine.transition('pending', 'session-start');
      machine.transition('connected', 'connection-established');
      machine.transition('reconnecting', 'connection-lost');
      const result = machine.transition('destroyed', 'session-killed');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('destroyed');
    });
  });

  describe('invalid transitions', () => {
    it.each([
      ['none', 'connected'],
      ['none', 'reconnecting'],
      ['none', 'destroyed'],
    ] as [SessionStatus, SessionStatus][])(
      'rejects invalid transition %s -> %s',
      (from, to) => {
        if (from === 'none') {
          const result = machine.transition(to, 'invalid-attempt');
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.message).toBe(`Invalid transition: ${from} -> ${to}: invalid-attempt`);
          }
        }
      },
    );

    it('rejects none -> connected', () => {
      const result = machine.transition('connected', 'skip-pending');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: none -> connected: skip-pending');
      }
    });

    it('rejects none -> reconnecting', () => {
      const result = machine.transition('reconnecting', 'skip-pending');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: none -> reconnecting: skip-pending');
      }
    });

    it('rejects none -> destroyed', () => {
      const result = machine.transition('destroyed', 'direct-destroy');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: none -> destroyed: direct-destroy');
      }
    });

    it('rejects connected -> pending', () => {
      machine.transition('pending', 'start');
      machine.transition('connected', 'up');
      const result = machine.transition('pending', 'back-to-pending');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: connected -> pending: back-to-pending');
      }
    });

    it('rejects connected -> connected (self-loop)', () => {
      machine.transition('pending', 'start');
      machine.transition('connected', 'up');
      const result = machine.transition('connected', 'already-connected');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: connected -> connected: already-connected');
      }
    });

    it('rejects destroyed -> any state', () => {
      machine.transition('pending', 'start');
      machine.transition('destroyed', 'kill');
      for (const target of AllStatuses) {
        const result = machine.transition(target, `try-${target}`);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toBe(`Invalid transition: destroyed -> ${target}: try-${target}`);
        }
      }
    });

    it('does not change state on invalid transition', () => {
      const result = machine.transition('connected', 'skip');
      expect(result.ok).toBe(false);
      expect(machine.getState()).toBe('none');
    });
  });

  describe('transition log', () => {
    it('records a log entry with from, to, timestamp, and context', () => {
      const before = Date.now();
      machine.transition('pending', 'session-start');
      const after = Date.now();

      const log = machine.getLog();
      expect(log).toHaveLength(1);
      expect(log[0].from).toBe('none');
      expect(log[0].to).toBe('pending');
      expect(log[0].context).toBe('session-start');
      expect(log[0].at).toBeGreaterThanOrEqual(before);
      expect(log[0].at).toBeLessThanOrEqual(after);
    });

    it('accumulates multiple transitions', () => {
      machine.transition('pending', 'start');
      machine.transition('connected', 'up');
      machine.transition('reconnecting', 'lost');
      machine.transition('connected', 'restored');

      const log = machine.getLog();
      expect(log).toHaveLength(4);
      expect(log[0]).toEqual({ from: 'none', to: 'pending', at: expect.any(Number), context: 'start' });
      expect(log[1]).toEqual({ from: 'pending', to: 'connected', at: expect.any(Number), context: 'up' });
      expect(log[2]).toEqual({ from: 'connected', to: 'reconnecting', at: expect.any(Number), context: 'lost' });
      expect(log[3]).toEqual({ from: 'reconnecting', to: 'connected', at: expect.any(Number), context: 'restored' });
    });

    it('does not record invalid transitions', () => {
      machine.transition('connected', 'skip');
      expect(machine.getLog()).toHaveLength(0);
    });

    it('returns a readonly snapshot (mutation safe)', () => {
      machine.transition('pending', 'start');
      const log = machine.getLog();
      expect(log).toHaveLength(1);
    });
  });

  describe('onTransition listener', () => {
    it('calls listener on valid transition with from, to, context', () => {
      const listener = vi.fn();
      machine.onTransition(listener);

      machine.transition('pending', 'session-start');

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith('none', 'pending', 'session-start');
    });

    it('calls multiple listeners in order', () => {
      const callOrder: string[] = [];
      const listenerA = vi.fn(() => callOrder.push('A'));
      const listenerB = vi.fn(() => callOrder.push('B'));
      machine.onTransition(listenerA);
      machine.onTransition(listenerB);

      machine.transition('pending', 'start');

      expect(callOrder).toEqual(['A', 'B']);
    });

    it('swallows listener errors without breaking transition', () => {
      const badListener = vi.fn(() => {
        throw new Error('listener boom');
      });
      const goodListener = vi.fn();
      machine.onTransition(badListener);
      machine.onTransition(goodListener);

      const result = machine.transition('pending', 'start');

      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe('pending');
      expect(badListener).toHaveBeenCalledOnce();
      expect(goodListener).toHaveBeenCalledOnce();
    });

    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = machine.onTransition(listener);

      unsubscribe();
      machine.transition('pending', 'start');

      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribe removes only the specific listener', () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = machine.onTransition(listenerA);
      machine.onTransition(listenerB);

      unsubA();
      machine.transition('pending', 'start');

      expect(listenerA).not.toHaveBeenCalled();
      expect(listenerB).toHaveBeenCalledOnce();
    });

    it('does not call listener on invalid transition', () => {
      const listener = vi.fn();
      machine.onTransition(listener);

      machine.transition('connected', 'invalid');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('full lifecycle', () => {
    it('none -> pending -> connected -> reconnecting -> connected -> destroyed', () => {
      machine.transition('pending', 'start');
      machine.transition('connected', 'up');
      machine.transition('reconnecting', 'lost');
      machine.transition('connected', 'restored');
      machine.transition('destroyed', 'kill');

      expect(machine.getState()).toBe('destroyed');
      expect(machine.getLog()).toHaveLength(5);

      const result = machine.transition('pending', 'impossible');
      expect(result.ok).toBe(false);
    });
  });

  describe('exhaustive invalid transition coverage', () => {
    const InvalidTransitions: [SessionStatus, SessionStatus][] = [
      ['none', 'none'],
      ['none', 'connected'],
      ['none', 'reconnecting'],
      ['none', 'destroyed'],
      ['pending', 'none'],
      ['pending', 'pending'],
      ['connected', 'none'],
      ['connected', 'pending'],
      ['connected', 'connected'],
      ['reconnecting', 'none'],
      ['reconnecting', 'pending'],
      ['destroyed', 'none'],
      ['destroyed', 'pending'],
      ['destroyed', 'connected'],
      ['destroyed', 'reconnecting'],
      ['destroyed', 'destroyed'],
    ];

    it.each(InvalidTransitions)(
      'rejects %s -> %s',
      (from, to) => {
        const sm = new SessionStateMachine();
        const pathTo = buildPathTo(from);
        for (const [target, ctx] of pathTo) {
          sm.transition(target, ctx);
        }
        expect(sm.getState()).toBe(from);
        const result = sm.transition(to, `try-${to}`);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain(`Invalid transition: ${from} -> ${to}`);
        }
      },
    );
  });
});

type TransitionStep = [SessionStatus, string];

function buildPathTo(target: SessionStatus): TransitionStep[] {
  const paths: Record<SessionStatus, TransitionStep[]> = {
    none: [],
    pending: [['pending', 'start']],
    connected: [['pending', 'start'], ['connected', 'up']],
    reconnecting: [['pending', 'start'], ['connected', 'up'], ['reconnecting', 'lost']],
    destroyed: [['pending', 'start'], ['destroyed', 'kill']],
  };
  return paths[target];
}
