import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SingleSessionManager } from './single-session-manager.js';
import type { SessionActor } from '../../domain/session-actor.js';
import { SessionState } from '../../constants/session.constants.js';
import { ok } from '../../types/result.js';

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
};

function createMockActor(status: SessionState = SessionState.None, sessionId = 'session_5491112222333'): SessionActor {
	return {
		sessionId,
		getStatus: vi.fn(() => status),
		getPhoneNumber: vi.fn(() => null),
		startQR: vi.fn(),
		startPairing: vi.fn(),
		reconnect: vi.fn(),
		stop: vi.fn(),
		destroy: vi.fn(() => Promise.resolve(ok(undefined))),
		sendMessage: vi.fn(),
	} as unknown as SessionActor;
}

describe('SingleSessionManager', () => {
	let manager: SingleSessionManager;
	let factoryCalls: string[];
	let factory: (sessionId: string) => SessionActor;

	beforeEach(() => {
		vi.clearAllMocks();
		factoryCalls = [];
		factory = (sessionId: string) => {
			factoryCalls.push(sessionId);
			return createMockActor(SessionState.None, sessionId);
		};
		manager = new SingleSessionManager(factory, mockLogger as any);
	});

	describe('constructor', () => {
		it('starts with no active session', () => {
			expect(manager.hasActiveSession()).toBe(false);
			expect(manager.getSession()).toBeNull();
		});
	});

	describe('getOrCreateSession', () => {
		it('creates a new session when none exists', () => {
			const actor = createMockActor();
			const sessionFactory = vi.fn(() => actor);
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			const result = mgr.getOrCreateSession('session_5491112222333');

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('Expected ok');
			expect(result.value).toBe(actor);
			expect(sessionFactory).toHaveBeenCalledWith('session_5491112222333');
		});

		it('passes sessionId directly to factory without modification', () => {
			const sessionFactory = vi.fn(() => createMockActor());
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');

			expect(sessionFactory).toHaveBeenCalledWith('session_5491112222333');
		});

		it('returns existing session if it is not destroyed', () => {
			const actor = createMockActor(SessionState.Connected);
			const sessionFactory = vi.fn(() => actor);
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');
			const result = mgr.getOrCreateSession('session_5491112222333');

			expect(sessionFactory).toHaveBeenCalledTimes(1);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('Expected ok');
			expect(result.value).toBe(actor);
		});

		it('replaces destroyed session with a new one', () => {
			const destroyedActor = createMockActor(SessionState.Destroyed);
			const freshActor = createMockActor(SessionState.Pending);
			let callCount = 0;
			const sessionFactory = vi.fn(() => {
				callCount++;
				return callCount === 1 ? destroyedActor : freshActor;
			});
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');
			const result = mgr.getOrCreateSession('session_5491112222333');

			expect(sessionFactory).toHaveBeenCalledTimes(2);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('Expected ok');
			expect(result.value).toBe(freshActor);
		});

		it('prevents creating multiple sessions — always only one', () => {
			const sessionFactory = vi.fn(() => createMockActor(SessionState.Connected));
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');
			mgr.getOrCreateSession('session_5491112222333');
			mgr.getOrCreateSession('session_5491112222333');

			expect(sessionFactory).toHaveBeenCalledTimes(1);
		});
	});

	describe('destroySession', () => {
		it('destroys the active session and clears reference', async () => {
			const actor = createMockActor(SessionState.Connected);
			const sessionFactory = vi.fn(() => actor);
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');
			const result = await mgr.destroySession();

			expect(result.ok).toBe(true);
			expect(actor.destroy).toHaveBeenCalled();
			expect(mgr.getSession()).toBeNull();
		});

		it('returns ok even when no session exists', async () => {
			const result = await manager.destroySession();
			expect(result.ok).toBe(true);
		});
	});

	describe('getSession', () => {
		it('returns null when no session exists', () => {
			expect(manager.getSession()).toBeNull();
		});

		it('returns the active session after creation', () => {
			const actor = createMockActor();
			const sessionFactory = vi.fn(() => actor);
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');

			expect(mgr.getSession()).toBe(actor);
		});
	});

	describe('hasActiveSession', () => {
		it('returns false when no session exists', () => {
			expect(manager.hasActiveSession()).toBe(false);
		});

		it('returns true when a session exists', () => {
			const sessionFactory = vi.fn(() => createMockActor());
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');

			expect(mgr.hasActiveSession()).toBe(true);
		});
	});

	describe('startHeartbeat', () => {
		it('logs heartbeat with session info', () => {
			vi.useFakeTimers();
			const actor = createMockActor(SessionState.Connected);
			actor.getPhoneNumber = vi.fn(() => '5491112222333');
			const sessionFactory = vi.fn(() => actor);
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');
			mgr.startHeartbeat(10000);

			vi.advanceTimersByTime(10000);

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session_5491112222333',
					status: SessionState.Connected,
					phoneNumber: '5491112222333',
				}),
				expect.stringContaining('1 session'),
			);

			mgr.stopHeartbeat();
			vi.useRealTimers();
		});

		it('logs heartbeat with no active session', () => {
			vi.useFakeTimers();
			manager.startHeartbeat(10000);

			vi.advanceTimersByTime(10000);

			expect(mockLogger.info).toHaveBeenCalledWith(
				[],
				expect.stringContaining('0 session'),
			);

			manager.stopHeartbeat();
			vi.useRealTimers();
		});
	});

	describe('destroy', () => {
		it('stops heartbeat and destroys session', async () => {
			const actor = createMockActor();
			const sessionFactory = vi.fn(() => actor);
			const mgr = new SingleSessionManager(sessionFactory, mockLogger as any);

			mgr.getOrCreateSession('session_5491112222333');
			await mgr.destroy();

			expect(actor.destroy).toHaveBeenCalled();
			expect(mgr.getSession()).toBeNull();
		});

		it('does not throw if no session exists', async () => {
			await expect(manager.destroy()).resolves.toBeUndefined();
		});
	});
});