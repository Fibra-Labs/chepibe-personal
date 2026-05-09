import {Mutex} from 'async-mutex';
import type {Logger} from 'pino';
import type {SessionActor} from '../../domain/session-actor';
import {ok, type Result} from '../../types/result';

export type SessionActorFactory = (sessionId: string) => SessionActor;

export class SingleSessionManager {
	private actor: SessionActor | null = null;
	private readonly lock = new Mutex();
	private heartbeatTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly sessionFactory: SessionActorFactory,
		private readonly logger: Logger,
	) {}

	getOrCreateSession(sessionId: string): Result<SessionActor, Error> {
		if (this.actor && this.actor.getStatus() !== 'destroyed') {
			return ok(this.actor);
		}

		this.actor = this.sessionFactory(sessionId);
		return ok(this.actor);
	}

	async destroySession(): Promise<Result<void, Error>> {
		return this.lock.runExclusive(async () => {
			if (!this.actor) return ok(undefined);
			const result = await this.actor.destroy();
			this.actor = null;
			return result;
		});
	}

	getSession(): SessionActor | null {
		return this.actor;
	}

	hasActiveSession(): boolean {
		return this.actor !== null && this.actor.getStatus() !== 'destroyed';
	}

	startHeartbeat(intervalMs = 30000): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			if (this.actor) {
				this.logger.info(
					{sessionId: this.actor.sessionId, status: this.actor.getStatus(), phoneNumber: this.actor.getPhoneNumber()},
					`Heartbeat: 1 session active`,
				);
			} else {
				this.logger.info([], `Heartbeat: 0 sessions active`);
			}
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
		if (this.actor) {
			await this.actor.destroy();
			this.actor = null;
		}
	}
}