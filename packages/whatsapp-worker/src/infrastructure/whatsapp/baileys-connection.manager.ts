import makeWASocket, {
    type AuthenticationCreds,
    type AuthenticationState,
    BufferJSON,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    initAuthCreds,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import EventEmitter from 'node:events';
import type { Client } from '@libsql/client';
import type { Logger } from 'pino';
import type { Db } from '@chepibe-personal/shared';
import { eq, whatsappSessionKeys, whatsappSessions } from '@chepibe-personal/shared';
import type { BaileysSession, SessionStatus } from '../../types.js';
import type { AudioHandler } from '../groq/audio-handler.js';
import { SqliteKeyStore } from './signal-key-store.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60000;
const DEBUG = process.env.DEBUG === 'true';

function serializeBaileysArg(arg: any): string {
    if (!arg) return '';
    if (typeof arg === 'string') return arg;
    if (arg?.message) return arg.message;
    if (arg?.output?.statusCode) return `statusCode=${arg.output.statusCode} message=${arg.message || 'unknown'}`;
    try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
}

function createBaileysLogger(logger: Logger): any {
    return {
        info: (...args: any[]) => { if (DEBUG) logger.info({ baileys: true }, args.map(serializeBaileysArg).join(' ')); },
        error: (...args: any[]) => logger.error({ baileys: true }, args.map(serializeBaileysArg).join(' ')),
        warn: (...args: any[]) => { if (DEBUG) logger.warn({ baileys: true }, args.map(serializeBaileysArg).join(' ')); },
        debug: (...args: any[]) => { if (DEBUG) logger.debug({ baileys: true }, args.map(serializeBaileysArg).join(' ')); },
        trace: (...args: any[]) => {},
        fatal: (...args: any[]) => logger.fatal({ baileys: true }, args.map(serializeBaileysArg).join(' ')),
        child: () => createBaileysLogger(logger),
        level: DEBUG ? 'trace' as const : 'silent' as const,
    };
}

export class BaileysConnectionManager {
    private sessions = new Map<string, BaileysSession>();
    private reconnectAttempts = new Map<string, number>();
    private reconnectTimeouts = new Map<string, NodeJS.Timeout>();
    private processedMessages = new NodeCache({ stdTTL: 86400, useClones: false });
    private keyStores = new Map<string, SqliteKeyStore>();
    private readonly eventEmitter = new EventEmitter();
    private readonly logger: Logger;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private readonly allowedPhone: string;

    constructor(
        private db: Db,
        private client: Client,
        private audioHandler: AudioHandler,
        logger: Logger,
        allowedPhone: string,
    ) {
        this.logger = logger.child({ component: 'baileys' });
        this.allowedPhone = allowedPhone;
    }

    on(event: string, handler: (...args: any[]) => void): void {
        this.eventEmitter.on(event, handler);
    }

    // ----------------------------------------------------------------
    // Session lifecycle
    // ----------------------------------------------------------------

    async restoreSessions(): Promise<void> {
        this.logger.info('Restoring sessions from database...');

        let sessions: any[];
        try {
            sessions = await this.db.select().from(whatsappSessions);
        } catch (err) {
            this.logger.error({ err }, 'Failed to load sessions from database');
            return;
        }

        if (sessions.length === 0) {
            this.logger.info('No sessions found in database');
            return;
        }

        for (const row of sessions) {
            if (!row.creds) {
                this.logger.info({ sessionId: row.id, status: row.status, phoneNumber: row.phoneNumber }, 'Session has no credentials, skipping');
                continue;
            }
            this.logger.info({ sessionId: row.id, status: row.status, phoneNumber: row.phoneNumber }, 'Restoring session...');
            try {
                await this.reconnectWithSavedCreds(row.id);
                this.logger.info({ sessionId: row.id }, 'Session restoration initiated');
            } catch (err) {
                this.logger.error({ err, sessionId: row.id }, 'Failed to restore session');
            }
        }
    }

    startHeartbeat(intervalMs = 30000): void {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

        this.heartbeatInterval = setInterval(() => {
            const sessions = this.getSessions();
            this.logger.info(
                sessions.map(s => ({ sessionId: s.sessionId, status: s.status, phoneNumber: s.phoneNumber })),
                `Heartbeat: ${sessions.length} session(s) active`,
            );

            for (const session of sessions) {
                if (session.status === 'connected' && !session.socket.user) {
                    this.logger.warn({ sessionId: session.sessionId }, 'Session marked connected but has no user — marking disconnected');
                    session.status = 'disconnected' as SessionStatus;
                    void this.reconnectWithSavedCreds(session.sessionId);
                }
            }
        }, intervalMs);
    }

    stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    // ----------------------------------------------------------------
    // Public API
    // ----------------------------------------------------------------

    getSessions(): BaileysSession[] {
        return Array.from(this.sessions.values());
    }

    getSession(sessionId: string): BaileysSession | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Create a new connection to obtain a QR code for pairing.
     * If a session with the same ID already exists and is pending (has a QR code),
     * returns the existing QR code instead of creating a new connection.
     * Otherwise tears down any existing session and creates a fresh one.
     */
    async createConnection(sessionId: string): Promise<{ qrCode: string }> {
        const existing = this.sessions.get(sessionId);
        if (existing?.qrCode && existing.status === 'pending') {
            this.logger.info({ sessionId }, 'Returning existing QR code');
            return { qrCode: existing.qrCode };
        }

        await this.teardownSession(sessionId, { deleteData: false });

        const { state, saveCredentials } = await this.loadOrCreateAuthState(sessionId);

        const { version } = await fetchLatestBaileysVersion();
        this.logger.info({ sessionId, version: version.join('.') }, 'Creating Baileys socket');
        const msgRetryCounterCache = new NodeCache();

        const socket = makeWASocket({
            version,
            logger: createBaileysLogger(this.logger),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, createBaileysLogger(this.logger)),
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
        });

        const session: BaileysSession = {
            sessionId,
            socket,
            status: 'pending' as SessionStatus,
            createdAt: new Date(),
        };
        this.sessions.set(sessionId, session);

        socket.ev.on('messages.upsert', (m) => {
            if (DEBUG) this.logger.debug({ sessionId, type: m.type, count: m.messages?.length }, 'messages.upsert received');
            void this.handleMessage(m, sessionId);
        });
        socket.ev.on('creds.update', saveCredentials);

        return new Promise((resolve, reject) => {
            let hasResolved = false;

            const timeout = setTimeout(() => {
                if (!hasResolved) {
                    hasResolved = true;
                    this.logger.warn({ sessionId }, 'Timeout waiting for QR code');
                    void this.teardownSession(sessionId, { deleteData: true, reason: 'qr_timeout' });
                    reject(new Error('Timeout waiting for QR code'));
                }
            }, 30000);

            socket.ev.on('connection.update', async (update) => {
                const { connection, qr, lastDisconnect } = update;

                if (DEBUG) this.logger.debug({ sessionId, connection, hasQr: !!qr }, 'connection.update');

                if (qr && !hasResolved) {
                    session.qrCode = qr;
                    this.logger.info({ sessionId }, 'QR code generated');
                    this.eventEmitter.emit('QR_READY', { sessionId, qrCode: qr });
                    hasResolved = true;
                    clearTimeout(timeout);
                    resolve({ qrCode: qr });
                }

                if (connection === 'open') {
                    this.logger.info({ sessionId }, 'Connection opened');
                    session.status = 'connected' as SessionStatus;

                    const userId = socket.user?.id;
                    if (userId) {
                        session.phoneNumber = userId.split('@')[0].split(':')[0];
                    }

                    if (session.phoneNumber !== this.allowedPhone) {
                        this.logger.fatal({
                            sessionId,
                            connectedPhone: session.phoneNumber,
                            allowedPhone: this.allowedPhone,
                        }, 'Connected phone number does not match ALLOWED_PHONE. Disconnecting.');
                        await this.teardownSession(sessionId, { deleteData: true, reason: 'phone_mismatch' });
                        if (!hasResolved) {
                            hasResolved = true;
                            clearTimeout(timeout);
                            reject(new Error(`Phone number mismatch. Expected: ${this.allowedPhone}, Got: ${session.phoneNumber}`));
                        }
                        return;
                    }

                    await saveCredentials();
                    await this.updateSessionStatus(sessionId, 'connected', session.phoneNumber);
                    this.reconnectAttempts.delete(sessionId);

                    this.eventEmitter.emit('CONNECTED', { sessionId, phoneNumber: session.phoneNumber });
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
                    const errorMsg = (lastDisconnect?.error as any)?.message || 'unknown';
                    this.logger.info({ sessionId, statusCode, errorMsg }, 'Connection closed');

                    if (statusCode === 515 || errorMsg.includes('restart')) {
                        this.logger.info({ sessionId, statusCode }, '515 restart required, reconnecting with saved creds');
                        await saveCredentials();
                        try { await socket.end(undefined); } catch {}

                        try {
                            await this.reconnectWithSavedCreds(sessionId);
                            const reconnected = this.sessions.get(sessionId);
                            if (reconnected?.status === 'connected') {
                                this.logger.info({ sessionId }, 'Reconnected successfully after 515');
                                if (!hasResolved) {
                                    hasResolved = true;
                                    clearTimeout(timeout);
                                    resolve({ qrCode: session.qrCode || '' });
                                }
                            }
                        } catch (err) {
                            this.logger.error({ err, sessionId }, 'Failed to reconnect after 515');
                            if (!hasResolved) {
                                hasResolved = true;
                                clearTimeout(timeout);
                                reject(new Error('Failed to reconnect after QR scan'));
                            }
                        }
                    } else if (statusCode === 401) {
                        this.logger.info({ sessionId }, 'Logged out (401), clearing session');
                        await this.teardownSession(sessionId, { deleteData: true, reason: 'logged_out' });
                        if (!hasResolved) {
                            hasResolved = true;
                            clearTimeout(timeout);
                            reject(new Error('Logged out'));
                        }
                    } else if (!hasResolved) {
                        hasResolved = true;
                        clearTimeout(timeout);
                    void this.teardownSession(sessionId, { deleteData: true, reason: 'connection_closed' });
                        reject(new Error(`Connection closed before QR: statusCode=${statusCode} error=${errorMsg}`));
                    }
                }
            });
        });
    }

    /**
     * Disconnect a session via API request.
     * Deletes session data so it cannot be restored.
     */
    async disconnectSession(sessionId: string): Promise<void> {
        await this.teardownSession(sessionId, { deleteData: true });
    }

    async destroy(): Promise<void> {
        this.stopHeartbeat();
        for (const [sessionId] of this.sessions) {
            await this.teardownSession(sessionId, { deleteData: false });
        }
        this.keyStores.clear();
        for (const [, timeout] of this.reconnectTimeouts) {
            clearTimeout(timeout);
        }
        this.reconnectTimeouts.clear();
        this.reconnectAttempts.clear();
    }

    // ----------------------------------------------------------------
    // Reconnection
    // ----------------------------------------------------------------

    private async reconnectWithSavedCreds(sessionId: string): Promise<void> {
        const { state, saveCredentials } = await this.loadOrCreateAuthState(sessionId);

        const { version } = await fetchLatestBaileysVersion();
        const msgRetryCounterCache = new NodeCache();

        this.logger.info({ sessionId, version: version.join('.') }, 'Reconnecting with saved credentials');

        const socket = makeWASocket({
            version,
            logger: createBaileysLogger(this.logger),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, createBaileysLogger(this.logger)),
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
        });

        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                sessionId,
                socket,
                status: 'pending' as SessionStatus,
                createdAt: new Date(),
            };
            this.sessions.set(sessionId, session);
        } else {
            session.socket = socket;
        }

        socket.ev.on('messages.upsert', (m) => {
            if (DEBUG) this.logger.debug({ sessionId, type: m.type, count: m.messages?.length }, 'messages.upsert received (restored)');
            void this.handleMessage(m, sessionId);
        });
        socket.ev.on('connection.update', (update) => {
            void this.handleConnectionUpdate(sessionId, update, saveCredentials);
        });
        socket.ev.on('creds.update', saveCredentials);
    }

    // ----------------------------------------------------------------
    // Connection event handlers
    // ----------------------------------------------------------------

    private async handleConnectionUpdate(
        sessionId: string,
        update: any,
        saveCredentials: () => Promise<void>,
    ): Promise<void> {
        const { connection, lastDisconnect, qr } = update;
        const session = this.sessions.get(sessionId);
        if (!session) return;

        if (DEBUG) this.logger.debug({ sessionId, connection, hasQr: !!qr }, 'handleConnectionUpdate');

        if (qr) {
            session.qrCode = qr;
            this.eventEmitter.emit('QR_READY', { sessionId, qrCode: qr });
        }

        if (connection === 'open') {
            this.reconnectAttempts.delete(sessionId);
            const reconnectTimeout = this.reconnectTimeouts.get(sessionId);
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                this.reconnectTimeouts.delete(sessionId);
            }

            const userId = session.socket.user?.id;
            if (userId) {
                session.phoneNumber = userId.split('@')[0].split(':')[0];
            }

            if (session.phoneNumber !== this.allowedPhone) {
                this.logger.fatal({
                    sessionId,
                    connectedPhone: session.phoneNumber,
                    allowedPhone: this.allowedPhone,
                }, 'Reconnected phone number does not match ALLOWED_PHONE. Disconnecting.');
                await this.teardownSession(sessionId, { deleteData: true, reason: 'phone_mismatch' });
                return;
            }

            session.status = 'connected' as SessionStatus;
            this.logger.info({ sessionId, phoneNumber: session.phoneNumber }, 'Session connected');

            await saveCredentials();
            await this.updateSessionStatus(sessionId, 'connected', session.phoneNumber);

            this.eventEmitter.emit('CONNECTED', { sessionId, phoneNumber: session.phoneNumber });

            const watchdog = setTimeout(() => {
                const current = this.sessions.get(sessionId);
                if (current && current.status === 'connected' && current.createdAt.getTime() > Date.now() - 35000) {
                    this.logger.warn({ sessionId }, 'Connection may be degraded, forcing reconnect');
                    void this.reconnectWithSavedCreds(sessionId);
                }
            }, 30000);
            watchdog.unref();
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            const errorMsg = (lastDisconnect?.error as any)?.message || 'unknown';
            const loggedOut = statusCode === 401;

            this.logger.info({ sessionId, statusCode, errorMsg }, 'Connection closed (reconnect handler)');

            if (loggedOut) {
                this.logger.info({ sessionId }, 'Logged out, clearing session');
                await this.teardownSession(sessionId, { deleteData: true, reason: 'logged_out' });
                return;
            }

            const attempts = (this.reconnectAttempts.get(sessionId) ?? 0) + 1;
            if (attempts >= MAX_RECONNECT_ATTEMPTS) {
                this.logger.warn({ sessionId, attempts }, 'Max reconnect attempts reached');
                // Preserve session data so user can try again later, but mark as disconnected
                await this.teardownSession(sessionId, { deleteData: false, reason: 'max_retries' });
                return;
            }

            this.reconnectAttempts.set(sessionId, attempts);
            const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts - 1), RECONNECT_MAX_DELAY_MS);

            this.logger.info({ sessionId, attempts, delay }, 'Scheduling reconnect');

            const timeout = setTimeout(() => {
                this.reconnectTimeouts.delete(sessionId);
                void this.reconnectWithSavedCreds(sessionId);
            }, delay);

            this.reconnectTimeouts.set(sessionId, timeout);
        }
    }

    // ----------------------------------------------------------------
    // Message handling
    // ----------------------------------------------------------------

    private async handleMessage(m: any, sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || session.status !== 'connected') return;

        if (session.phoneNumber !== this.allowedPhone) {
            this.logger.warn({ sessionId, phoneNumber: session.phoneNumber, allowedPhone: this.allowedPhone }, 'Session phone does not match ALLOWED_PHONE, skipping message processing');
            return;
        }

        if (!m.messages?.length) return;

        if (m.type !== 'notify' && !m.requestId) {
            const hasAudio = m.messages?.some((msg: any) =>
                msg.message?.audioMessage || msg.message?.pttMessage
            );

            if (!hasAudio) {
                this.logger.debug({ sessionId, type: m.type }, 'Message received → not notify/offline → skipping (no audio)');
                return;
            }

            this.logger.info({ sessionId, type: m.type, messageCount: m.messages?.length }, 'Processing append messages with audio');
        }

        for (const message of m.messages) {
            const sender = message.key.remoteJid;
            if (!sender || !message.message) continue;

            const isFromMe = message.key.fromMe === true;
            const msgId = message.key.id;
            if (!msgId) continue;

            const isGroup = sender.includes('@g.us');
            const participant = message.key.participant || message.key.participantAlt;
            const senderIsLid = (isGroup ? participant : sender)?.includes('@lid');
            const participantSource = isGroup ? participant : sender;
            const rawNumber = (participantSource || sender).split('@')[0].split(':')[0];

            let phoneNumber: string;
            if (isFromMe) {
                phoneNumber = session.phoneNumber || rawNumber;
            } else {
                phoneNumber = rawNumber;
            }

            this.logger.info({
                sender,
                isGroup,
                participant,
                isFromMe,
                rawNumber,
                phoneNumber,
                sessionPhone: session.phoneNumber,
            }, 'Sender detection');

            const audioMessage = message.message.audioMessage || message.message.pttMessage;
            if (isFromMe && !audioMessage) {
                this.logger.info({ phoneNumber, msgId }, 'Message received → from self → not audio → skipping (likely bot reply)');
                continue;
            }

            const dedupKey = `${phoneNumber}:${msgId}`;
            if (this.processedMessages.has(dedupKey)) {
                this.logger.info({ phoneNumber, msgId }, 'Message received → duplicate → skipping');
                continue;
            }
            this.processedMessages.set(dedupKey, true);

            if (audioMessage) {
                this.logger.info({
                    sessionId, phoneNumber, msgId, fromMe: isFromMe,
                    duration: audioMessage.seconds, mimetype: audioMessage.mimetype,
                }, 'Message received → audio → processing');

                try {
                    const audioBuffer = await downloadMediaMessage(message, 'buffer', {}, {
                        logger: createBaileysLogger(this.logger),
                        reuploadRequest: async (msg: any) => msg,
                    });

                    this.logger.info({ msgId, bufferSize: audioBuffer.length }, 'Audio downloaded');

                    const mimetype = audioMessage.mimetype || 'audio/ogg';
                    const ownerJid = session.socket.user?.id;
                    const isFromOtherChat = sender !== ownerJid && !ownerJid?.startsWith(phoneNumber);

                    await this.audioHandler.handleAudioMessage(
                        session.socket,
                        sender,
                        audioBuffer,
                        mimetype,
                        msgId,
                        audioMessage.seconds,
                        isFromOtherChat ? phoneNumber : undefined,
                        ownerJid,
                    );
                } catch (err) {
                    this.logger.error({ err, msgId }, 'Failed to process voice message');
                }
            } else {
                const msgType = Object.keys(message.message).join(',');
                this.logger.info({ phoneNumber, msgId, msgType }, 'Message received → not audio → skipping');
            }
        }
    }

    // ----------------------------------------------------------------
    // Auth state
    // ----------------------------------------------------------------

    private async loadOrCreateAuthState(sessionId: string): Promise<{
        state: AuthenticationState;
        saveCredentials: () => Promise<void>;
    }> {
        let creds: AuthenticationCreds;

        const row = await this.db.select().from(whatsappSessions)
            .where(eq(whatsappSessions.id, sessionId))
            .limit(1);

        if (row.length > 0 && row[0].creds) {
            this.logger.info({ sessionId }, 'Loaded existing credentials from DB');
            const credsStr = typeof row[0].creds === 'string' ? row[0].creds : JSON.stringify(row[0].creds);
            creds = JSON.parse(credsStr, BufferJSON.reviver) as AuthenticationCreds;
        } else {
            this.logger.info({ sessionId }, 'Generating new credentials');
            creds = initAuthCreds();
        }

        const keyStore = new SqliteKeyStore(sessionId, this.db, this.client, this.logger);
        this.keyStores.set(sessionId, keyStore);

        if (row.length > 0 && row[0].creds) {
            await keyStore.loadFromDB();
        }

        const state: AuthenticationState = {
            creds,
            keys: keyStore,
        };

        const saveCredentials = async () => {
            try {
                const credsStr = JSON.stringify(creds, BufferJSON.replacer);
                await this.db.insert(whatsappSessions)
                    .values({ id: sessionId, status: 'pending', creds: credsStr })
                    .onConflictDoUpdate({
                        target: whatsappSessions.id,
                        set: { creds: credsStr, updatedAt: Math.floor(Date.now() / 1000) },
                    });
                this.logger.debug({ sessionId }, 'Saved credentials');
            } catch (error) {
                this.logger.error({ err: error, sessionId }, 'Failed to save credentials — session may not persist across restarts');
            }
        };

        return { state, saveCredentials };
    }

    // ----------------------------------------------------------------
    // Session teardown (single entry point for all cleanup)
    // ----------------------------------------------------------------

    /**
     * Tears down a session: flushes pending key writes, closes the socket,
     * cleans up internal maps, optionally deletes DB data, and emits events.
     *
     * This is the ONLY method that should clean up a session. All call sites
     * go through here so cleanup is consistent.
     *
     * @param deleteData - If true, deletes session data from the DB so it
     *   cannot be restored on restart. Use false for graceful shutdown,
     *   reconnects, and internal teardowns where data should be preserved.
     * @param reason - Optional reason string included in the DISCONNECTED event.
     */
    private async teardownSession(
        sessionId: string,
        options: { deleteData: boolean; reason?: string } = { deleteData: true },
    ): Promise<void> {
        const { deleteData, reason } = options;
        const session = this.sessions.get(sessionId);

        const reconnectTimeout = this.reconnectTimeouts.get(sessionId);
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            this.reconnectTimeouts.delete(sessionId);
        }
        this.reconnectAttempts.delete(sessionId);

        const keyStore = this.keyStores.get(sessionId);
        if (keyStore) {
            await keyStore.forceFlush();
            keyStore.destroy();
            this.keyStores.delete(sessionId);
        }

        if (session) {
            try { await session.socket.end(undefined); } catch {}
        }

        if (deleteData) {
            await this.deleteSessionData(sessionId);
        } else if (session) {
            await this.updateSessionStatus(sessionId, 'disconnected');
        }

        this.sessions.delete(sessionId);

        this.eventEmitter.emit('DISCONNECTED', { sessionId, reason: reason ?? (deleteData ? 'disconnected' : 'shutdown') });
    }

    // ----------------------------------------------------------------
    // Database helpers
    // ----------------------------------------------------------------

    private async updateSessionStatus(sessionId: string, status: string, phoneNumber?: string): Promise<void> {
        try {
            await this.db.insert(whatsappSessions)
                .values({ id: sessionId, status, phoneNumber })
                .onConflictDoUpdate({
                    target: whatsappSessions.id,
                    set: {
                        status,
                        ...(phoneNumber && { phoneNumber }),
                        updatedAt: Math.floor(Date.now() / 1000),
                    },
                });
        } catch (err) {
            this.logger.error({ err, sessionId }, 'Failed to update session status in DB');
        }
    }

    private async deleteSessionData(sessionId: string): Promise<void> {
        try {
            await this.db.delete(whatsappSessionKeys).where(eq(whatsappSessionKeys.sessionId, sessionId));
            await this.db.delete(whatsappSessions).where(eq(whatsappSessions.id, sessionId));
        } catch (err) {
            this.logger.error({ err, sessionId }, 'Failed to delete session data');
        }
    }
}