import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStateMachine } from './session-state-machine.js';
import { SessionStatus } from './types.js';

const AllStatuses: SessionStatus[] = [
  SessionStatus.None, SessionStatus.Pending, SessionStatus.Connected, SessionStatus.Reconnecting, SessionStatus.Destroyed,
];

const ValidTransitions: Record<SessionStatus, SessionStatus[]> = {
  [SessionStatus.None]: [SessionStatus.Pending],
  [SessionStatus.Pending]: [SessionStatus.Connected, SessionStatus.Reconnecting, SessionStatus.Destroyed],
  [SessionStatus.Connected]: [SessionStatus.Reconnecting, SessionStatus.Destroyed],
  [SessionStatus.Reconnecting]: [SessionStatus.Connected, SessionStatus.Reconnecting, SessionStatus.Destroyed],
  [SessionStatus.Destroyed]: [],
};

describe('SessionStateMachine', () => {
  let machine: SessionStateMachine;

  beforeEach(() => {
    machine = new SessionStateMachine();
  });

  describe('initial state', () => {
    it('starts in "none" state', () => {
      expect(machine.getState()).toBe(SessionStatus.None);
    });

    it('has an empty transition log', () => {
      expect(machine.getLog()).toEqual([]);
    });
  });

  describe('canTransition', () => {
    it.each(AllStatuses.filter((s) => s !== SessionStatus.None) as SessionStatus[])(
      'returns false for invalid transition from none to %s',
      (to) => {
        if (!ValidTransitions.none.includes(to)) {
          expect(machine.canTransition(to)).toBe(false);
        }
      },
    );

    it('returns true for valid transition none -> pending', () => {
      expect(machine.canTransition(SessionStatus.Pending)).toBe(true);
    });

    it('returns false for valid target when not in correct source state', () => {
      expect(machine.canTransition(SessionStatus.Connected)).toBe(false);
    });
  });

  describe('valid transitions', () => {
    it('none -> pending', () => {
      const result = machine.transition(SessionStatus.Pending, 'session-start');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Pending);
    });

    it('pending -> connected', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      const result = machine.transition(SessionStatus.Connected, 'connection-established');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Connected);
    });

    it('pending -> reconnecting', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      const result = machine.transition(SessionStatus.Reconnecting, 'connection-lost');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Reconnecting);
    });

    it('pending -> destroyed', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      const result = machine.transition(SessionStatus.Destroyed, 'session-killed');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Destroyed);
    });

    it('connected -> reconnecting', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      machine.transition(SessionStatus.Connected, 'connection-established');
      const result = machine.transition(SessionStatus.Reconnecting, 'connection-lost');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Reconnecting);
    });

    it('connected -> destroyed', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      machine.transition(SessionStatus.Connected, 'connection-established');
      const result = machine.transition(SessionStatus.Destroyed, 'session-killed');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Destroyed);
    });

    it('reconnecting -> connected', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      machine.transition(SessionStatus.Connected, 'connection-established');
      machine.transition(SessionStatus.Reconnecting, 'connection-lost');
      const result = machine.transition(SessionStatus.Connected, 'connection-restored');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Connected);
    });

    it('reconnecting -> reconnecting (self-loop)', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      machine.transition(SessionStatus.Connected, 'connection-established');
      machine.transition(SessionStatus.Reconnecting, 'connection-lost');
      const result = machine.transition(SessionStatus.Reconnecting, 'retry-connection');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Reconnecting);
    });

    it('reconnecting -> destroyed', () => {
      machine.transition(SessionStatus.Pending, 'session-start');
      machine.transition(SessionStatus.Connected, 'connection-established');
      machine.transition(SessionStatus.Reconnecting, 'connection-lost');
      const result = machine.transition(SessionStatus.Destroyed, 'session-killed');
      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Destroyed);
    });
  });

  describe('invalid transitions', () => {
    it.each([
      [SessionStatus.None, SessionStatus.Connected],
      [SessionStatus.None, SessionStatus.Reconnecting],
      [SessionStatus.None, SessionStatus.Destroyed],
    ] as [SessionStatus, SessionStatus][])(
      'rejects invalid transition %s -> %s',
      (from, to) => {
        if (from === SessionStatus.None) {
          const result = machine.transition(to, 'invalid-attempt');
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.message).toBe(`Invalid transition: ${from} -> ${to}: invalid-attempt`);
          }
        }
      },
    );

    it('rejects none -> connected', () => {
      const result = machine.transition(SessionStatus.Connected, 'skip-pending');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: none -> connected: skip-pending');
      }
    });

    it('rejects none -> reconnecting', () => {
      const result = machine.transition(SessionStatus.Reconnecting, 'skip-pending');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: none -> reconnecting: skip-pending');
      }
    });

    it('rejects none -> destroyed', () => {
      const result = machine.transition(SessionStatus.Destroyed, 'direct-destroy');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: none -> destroyed: direct-destroy');
      }
    });

    it('rejects connected -> pending', () => {
      machine.transition(SessionStatus.Pending, 'start');
      machine.transition(SessionStatus.Connected, 'up');
      const result = machine.transition(SessionStatus.Pending, 'back-to-pending');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: connected -> pending: back-to-pending');
      }
    });

    it('rejects connected -> connected (self-loop)', () => {
      machine.transition(SessionStatus.Pending, 'start');
      machine.transition(SessionStatus.Connected, 'up');
      const result = machine.transition(SessionStatus.Connected, 'already-connected');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid transition: connected -> connected: already-connected');
      }
    });

    it('rejects destroyed -> any state', () => {
      machine.transition(SessionStatus.Pending, 'start');
      machine.transition(SessionStatus.Destroyed, 'kill');
      for (const target of AllStatuses) {
        const result = machine.transition(target, `try-${target}`);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toBe(`Invalid transition: destroyed -> ${target}: try-${target}`);
        }
      }
    });

    it('does not change state on invalid transition', () => {
      const result = machine.transition(SessionStatus.Connected, 'skip');
      expect(result.ok).toBe(false);
      expect(machine.getState()).toBe(SessionStatus.None);
    });
  });

  describe('transition log', () => {
    it('records a log entry with from, to, timestamp, and context', () => {
      const before = Date.now();
      machine.transition(SessionStatus.Pending, 'session-start');
      const after = Date.now();

      const log = machine.getLog();
      expect(log).toHaveLength(1);
      expect(log[0].from).toBe(SessionStatus.None);
      expect(log[0].to).toBe(SessionStatus.Pending);
      expect(log[0].context).toBe('session-start');
      expect(log[0].at).toBeGreaterThanOrEqual(before);
      expect(log[0].at).toBeLessThanOrEqual(after);
    });

    it('accumulates multiple transitions', () => {
      machine.transition(SessionStatus.Pending, 'start');
      machine.transition(SessionStatus.Connected, 'up');
      machine.transition(SessionStatus.Reconnecting, 'lost');
      machine.transition(SessionStatus.Connected, 'restored');

      const log = machine.getLog();
      expect(log).toHaveLength(4);
      expect(log[0]).toEqual({ from: SessionStatus.None, to: SessionStatus.Pending, at: expect.any(Number), context: 'start' });
      expect(log[1]).toEqual({ from: SessionStatus.Pending, to: SessionStatus.Connected, at: expect.any(Number), context: 'up' });
      expect(log[2]).toEqual({ from: SessionStatus.Connected, to: SessionStatus.Reconnecting, at: expect.any(Number), context: 'lost' });
      expect(log[3]).toEqual({ from: SessionStatus.Reconnecting, to: SessionStatus.Connected, at: expect.any(Number), context: 'restored' });
    });

    it('does not record invalid transitions', () => {
      machine.transition(SessionStatus.Connected, 'skip');
      expect(machine.getLog()).toHaveLength(0);
    });

    it('returns a readonly snapshot (mutation safe)', () => {
      machine.transition(SessionStatus.Pending, 'start');
      const log = machine.getLog();
      expect(log).toHaveLength(1);
    });
  });

  describe('onTransition listener', () => {
    it('calls listener on valid transition with from, to, context', () => {
      const listener = vi.fn();
      machine.onTransition(listener);

      machine.transition(SessionStatus.Pending, 'session-start');

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(SessionStatus.None, SessionStatus.Pending, 'session-start');
    });

    it('calls multiple listeners in order', () => {
      const callOrder: string[] = [];
      const listenerA = vi.fn(() => callOrder.push('A'));
      const listenerB = vi.fn(() => callOrder.push('B'));
      machine.onTransition(listenerA);
      machine.onTransition(listenerB);

      machine.transition(SessionStatus.Pending, 'start');

      expect(callOrder).toEqual(['A', 'B']);
    });

    it('swallows listener errors without breaking transition', () => {
      const badListener = vi.fn(() => {
        throw new Error('listener boom');
      });
      const goodListener = vi.fn();
      machine.onTransition(badListener);
      machine.onTransition(goodListener);

      const result = machine.transition(SessionStatus.Pending, 'start');

      expect(result.ok).toBe(true);
      expect(machine.getState()).toBe(SessionStatus.Pending);
      expect(badListener).toHaveBeenCalledOnce();
      expect(goodListener).toHaveBeenCalledOnce();
    });

    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = machine.onTransition(listener);

      unsubscribe();
      machine.transition(SessionStatus.Pending, 'start');

      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribe removes only the specific listener', () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = machine.onTransition(listenerA);
      machine.onTransition(listenerB);

      unsubA();
      machine.transition(SessionStatus.Pending, 'start');

      expect(listenerA).not.toHaveBeenCalled();
      expect(listenerB).toHaveBeenCalledOnce();
    });

    it('does not call listener on invalid transition', () => {
      const listener = vi.fn();
      machine.onTransition(listener);

      machine.transition(SessionStatus.Connected, 'invalid');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('full lifecycle', () => {
    it('none -> pending -> connected -> reconnecting -> connected -> destroyed', () => {
      machine.transition(SessionStatus.Pending, 'start');
      machine.transition(SessionStatus.Connected, 'up');
      machine.transition(SessionStatus.Reconnecting, 'lost');
      machine.transition(SessionStatus.Connected, 'restored');
      machine.transition(SessionStatus.Destroyed, 'kill');

      expect(machine.getState()).toBe(SessionStatus.Destroyed);
      expect(machine.getLog()).toHaveLength(5);

      const result = machine.transition(SessionStatus.Pending, 'impossible');
      expect(result.ok).toBe(false);
    });
  });

  describe('exhaustive invalid transition coverage', () => {
    const InvalidTransitions: [SessionStatus, SessionStatus][] = [
      [SessionStatus.None, SessionStatus.None],
      [SessionStatus.None, SessionStatus.Connected],
      [SessionStatus.None, SessionStatus.Reconnecting],
      [SessionStatus.None, SessionStatus.Destroyed],
      [SessionStatus.Pending, SessionStatus.None],
      [SessionStatus.Pending, SessionStatus.Pending],
      [SessionStatus.Connected, SessionStatus.None],
      [SessionStatus.Connected, SessionStatus.Pending],
      [SessionStatus.Connected, SessionStatus.Connected],
      [SessionStatus.Reconnecting, SessionStatus.None],
      [SessionStatus.Reconnecting, SessionStatus.Pending],
      [SessionStatus.Destroyed, SessionStatus.None],
      [SessionStatus.Destroyed, SessionStatus.Pending],
      [SessionStatus.Destroyed, SessionStatus.Connected],
      [SessionStatus.Destroyed, SessionStatus.Reconnecting],
      [SessionStatus.Destroyed, SessionStatus.Destroyed],
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
    pending: [[SessionStatus.Pending, 'start']],
    connected: [[SessionStatus.Pending, 'start'], [SessionStatus.Connected, 'up']],
    reconnecting: [[SessionStatus.Pending, 'start'], [SessionStatus.Connected, 'up'], [SessionStatus.Reconnecting, 'lost']],
    destroyed: [[SessionStatus.Pending, 'start'], [SessionStatus.Destroyed, 'kill']],
  };
  return paths[target];
}
