export const DisconnectCategory = {
	Recoverable: 'recoverable',
	Permanent: 'permanent'
} as const;

export type DisconnectCategory = typeof DisconnectCategory[keyof typeof DisconnectCategory];

export interface RecoverableDisconnectEvent {
	category: typeof DisconnectCategory.Recoverable;
	sessionId: string;
	reason: string;
	statusCode: number;
}

export interface PermanentDisconnectEvent {
	category: typeof DisconnectCategory.Permanent;
	sessionId: string;
	reason: string;
	statusCode: number;
}

export type DisconnectEvent = RecoverableDisconnectEvent | PermanentDisconnectEvent;

export function classifyDisconnect(statusCode: number, reason: string): DisconnectCategory {
	if (statusCode === 401 || statusCode === 440 || statusCode === 405) {
		return DisconnectCategory.Permanent;
	}
	return DisconnectCategory.Recoverable;
}