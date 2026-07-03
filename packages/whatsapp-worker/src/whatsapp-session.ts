import { Mutex } from 'async-mutex';
import makeWASocket, {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type WASocket,
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import type { Client } from '@libsql/client';
import type { Logger } from 'pino';
import type { Db } from '@chepibe-personal/shared';
import { eq, whatsappSessions, whatsappSessionKeys } from '@chepibe-personal/shared';
import { sql } from 'drizzle-orm';
import { SignalKeyStore } from './signal-key-store.js';
import type { AudioHandler } from './audio-handler.js';
import { SessionStateMachine } from './session-state-machine.js';
import {
  ok, err, type Result, type SessionEvent, type SessionEventName,
  SessionEventName as EventName,
  SessionStatus,
  BaileysDisconnectCode, TeardownReason,
  Baileys, StateMachineAction,
  WHATSAPP_JID_SUFFIX, LID_SUFFIX, GROUP_JID_SUFFIX, DEDUP_TTL_SECONDS, RESPONSIVE_THRESHOLD_MS,
  MAX_RECONNECT_ATTEMPTS, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS,
  QR_TIMEOUT_MS, PAIRING_TIMEOUT_MS, PASSKEY_TIMEOUT_MS,
  ERROR_PREFIX_TIMEOUT_QR, ERROR_PREFIX_TIMEOUT_PAIRING,
  ERROR_PAIRING_CODE_FAILED, ERROR_PHONE_MISMATCH,
  ERROR_NO_SOCKET, ERROR_SEND_FAILED, ERROR_RECONNECT_FAILED,
  type PairingStep, type PasskeySubmitPayload, type PasskeyLinkingCache,
  type WebAuthnResponseJSON,
  PairingStep as PairingStepEnum,
} from './types.js';

export class WhatsAppSession {
  readonly sessionId: string;
  private phoneNumber: string | null = null;
  private socket: WASocket | null = null;
  private readonly stateMachine: SessionStateMachine;
  private readonly lock: Mutex;
  private keyStore: SignalKeyStore | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private processedMessages = new NodeCache({ stdTTL: DEDUP_TTL_SECONDS, useClones: false });
  private readonly lidToPhoneCache = new Map<string, string>();
  private abortController: AbortController | null = null;
  private lastActivityAt = new Date();
  private passkeyLinkingCache: PasskeyLinkingCache | null = null;
  private passkeyTimeoutTimer: NodeJS.Timeout | null = null;

  constructor(
    sessionId: string,
    private readonly db: Db,
    private readonly client: Client,
    private readonly audioHandler: AudioHandler,
    private readonly logger: Logger,
    private readonly allowedPhone: string,
    private readonly eventSink: (event: SessionEvent) => void | Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.stateMachine = new SessionStateMachine();
    this.lock = new Mutex();
  }

  async startQR(): Promise<Result<{ qrCode: string }, Error>> {
    return this.lock.runExclusive(async () => {
      const state = this.stateMachine.getState();
      if (state !== SessionStatus.None && state !== SessionStatus.Destroyed) {
        return err(new Error(`Cannot startQR from state ${state}`));
      }

      const trans = this.stateMachine.transition(SessionStatus.Pending, StateMachineAction.StartQr);
      if (!trans.ok) return trans as Result<never, Error>;

      const setup = await this.setupSocketAndSession('Creating Baileys socket for QR');
      if (!setup.ok) return setup;

      const { socket, saveCredentials } = setup.value;
      this.abortController = new AbortController();

      try {
        const result = await new Promise<Result<{ qrCode: string }, Error>>((resolve) => {
          const timeout = setTimeout(() => {
            socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
            this.abortController?.abort();
            resolve(err(new Error(ERROR_PREFIX_TIMEOUT_QR)));
          }, QR_TIMEOUT_MS);

          const updateListener = async (update: any) => {
            const { connection, qr } = update;
            if (this.abortController?.signal.aborted) return;

            if (qr) {
              clearTimeout(timeout);
              socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
              this.logger.info({ sessionId: this.sessionId }, 'QR code generated');
              await saveCredentials();
              await this.emitEvent(EventName.QrReady, { sessionId: this.sessionId, qrCode: qr });
              resolve(ok({ qrCode: qr }));
              return;
            }

            if (connection === Baileys.Connection.Open) {
              clearTimeout(timeout);
              socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(ok({ qrCode: '' }));
              return;
            }

            if (connection === Baileys.Connection.Close) {
              clearTimeout(timeout);
              socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(err(new Error('Connection closed during QR')));
            }
          };

          socket.ev.on(Baileys.Event.ConnectionUpdate, updateListener);
        });

        if (!result.ok) {
          const reason = result.error.message.includes('closed')
            ? TeardownReason.ConnectionClosed
            : TeardownReason.QrTimeout;
          await this.doTeardown(true, reason);
        }
        return result;
      } finally {
        this.abortController = null;
      }
    });
  }

  async startPairing(phoneNumber: string): Promise<Result<{ code: string }, Error>> {
    return this.lock.runExclusive(async () => {
      const state = this.stateMachine.getState();
      if (state !== SessionStatus.None && state !== SessionStatus.Destroyed) {
        return err(new Error(`Cannot startPairing from state ${state}`));
      }

      const trans = this.stateMachine.transition(SessionStatus.Pending, StateMachineAction.StartPairing);
      if (!trans.ok) return trans as Result<never, Error>;

      const setup = await this.setupSocketAndSession('Creating Baileys socket for pairing code');
      if (!setup.ok) return setup;

      const { socket, saveCredentials } = setup.value;
      this.abortController = new AbortController();

      try {
        const result = await new Promise<Result<{ code: string }, Error>>((resolve) => {
          const timeout = setTimeout(() => {
            socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
            this.abortController?.abort();
            resolve(err(new Error(ERROR_PREFIX_TIMEOUT_PAIRING)));
          }, PAIRING_TIMEOUT_MS);

          const updateListener = async (update: any) => {
            const { connection, qr } = update;
            if (this.abortController?.signal.aborted) return;

            if (qr) {
              try {
                const code = await socket.requestPairingCode(phoneNumber);
                this.logger.info({ sessionId: this.sessionId }, 'Pairing code generated');
                clearTimeout(timeout);
                socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
                await saveCredentials();
                resolve(ok({ code }));
                return;
              } catch {
                clearTimeout(timeout);
                socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
                resolve(err(new Error(ERROR_PAIRING_CODE_FAILED)));
                this.abortController?.abort();
                return;
              }
            }

            if (connection === Baileys.Connection.Open) {
              clearTimeout(timeout);
              socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(ok({ code: '' }));
              return;
            }

            if (connection === Baileys.Connection.Close) {
              clearTimeout(timeout);
              socket.ev.off(Baileys.Event.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(err(new Error('Connection closed during pairing')));
            }
          };

          socket.ev.on(Baileys.Event.ConnectionUpdate, updateListener);
        });

        if (!result.ok) {
          const reason = result.error.message.includes('closed')
            ? TeardownReason.ConnectionClosed
            : result.error.message.includes('pairing')
              ? TeardownReason.PairingCodeFailed
              : TeardownReason.PairingTimeout;
          await this.doTeardown(true, reason);
        }
        return result;
      } finally {
        this.abortController = null;
      }
    });
  }

  async reconnect(): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      const state = this.stateMachine.getState();
      if (state !== SessionStatus.None && state !== SessionStatus.Pending && state !== SessionStatus.Connected && state !== SessionStatus.Reconnecting && state !== SessionStatus.Suspended) {
        this.logger.warn({ state, sessionId: this.sessionId }, 'reconnect() skipped: invalid state');
        return ok(undefined);
      }

      if (state === SessionStatus.None) {
        const pendingTrans = this.stateMachine.transition(SessionStatus.Pending, 'reconnect-init');
        if (!pendingTrans.ok) {
          this.logger.error({ state: this.stateMachine.getState(), err: pendingTrans.error, sessionId: this.sessionId }, 'reconnect() failed None→Pending transition');
          return pendingTrans;
        }
      }

      const trans = this.stateMachine.transition(SessionStatus.Reconnecting, `reconnect attempt ${this.reconnectAttempts + 1}`);
      if (!trans.ok) {
        this.logger.error({ state: this.stateMachine.getState(), err: trans.error, sessionId: this.sessionId }, 'reconnect() failed state transition');
        return trans;
      }

      if (this.socket) {
        try { await this.socket.end(undefined); } catch { /* best-effort */ }
        this.socket = null;
      }

      if (this.keyStore) {
        try { await this.keyStore.forceFlush(); } catch { /* best-effort */ }
        this.keyStore = null;
      }

      try {
        const setup = await this.setupSocketAndSession('Reconnecting with saved credentials');
        if (!setup.ok) return setup;
        return ok(undefined);
      } catch (e) {
        return err(new Error(ERROR_RECONNECT_FAILED, { cause: e }));
      }
    });
  }

  async stop(reason?: string): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      return this.doTeardown(false, reason ?? TeardownReason.Shutdown);
    });
  }

  async destroy(): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      return this.doTeardown(true, TeardownReason.Shutdown);
    });
  }

  async sendMessage(jid: string, content: any): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      if (!this.socket) return err(new Error(ERROR_NO_SOCKET));
      try {
        await this.socket.sendMessage(jid, content);
        return ok(undefined);
      } catch (e) {
        return err(new Error(ERROR_SEND_FAILED, { cause: e }));
      }
    });
  }

  private setupMessageListener(socket: WASocket): void {
    socket.ev.on(Baileys.Event.MessagesUpsert, async (m: any) => {
      this.logger.info({ sessionId: this.sessionId, type: m.type, messageCount: m.messages?.length }, 'Received messages');
      if (m.messages) {
        for (const msg of m.messages) {
          await this.handleMessage(msg);
        }
      }
    });
  }

  private async handleConnectionUpdate(update: any, socket?: WASocket, saveCredentials?: () => Promise<void>): Promise<void> {
    const { connection, lastDisconnect, isNewLogin } = update;

    if (this.stateMachine.getState() === SessionStatus.Reconnecting && this.reconnectTimeout) {
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
      const isDuplicateReconnectTrigger = isNewLogin || statusCode === BaileysDisconnectCode.RestartRequired;
      if (isDuplicateReconnectTrigger) {
        this.logger.warn({ sessionId: this.sessionId, isNewLogin, statusCode }, 'Ignoring duplicate reconnect trigger while already reconnecting');
        return;
      }
    }

    if (isNewLogin) {
      this.reconnectAttempts = 0;
      const trans = this.stateMachine.transition(SessionStatus.Reconnecting, 'isNewLogin');
      if (trans.ok) {
        await this.scheduleReconnect();
      }
      return;
    }

    if (connection === Baileys.Connection.Open) {
      this.reconnectAttempts = 0;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (socket && saveCredentials) {
        await this.onConnectionOpen(socket, saveCredentials);
      }
    }

    if (connection === Baileys.Connection.Close) {
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;

      if (statusCode === BaileysDisconnectCode.LoggedOut) {
        await this.emitEvent(EventName.PermanentDisconnect, {
          sessionId: this.sessionId,
          reason: TeardownReason.LoggedOut,
          statusCode,
        });
        await this.doTeardown(true, TeardownReason.LoggedOut);
        return;
      }

      if (statusCode === BaileysDisconnectCode.RestartRequired) {
        this.reconnectAttempts = 0;
        const trans = this.stateMachine.transition(SessionStatus.Reconnecting, '515-restart-required');
        if (!trans.ok) {
          this.logger.error({ state: this.stateMachine.getState(), err: trans.error, sessionId: this.sessionId }, 'Failed 515 transition to Reconnecting, falling back to teardown');
          await this.doTeardown(true, TeardownReason.ConnectionClosed);
          return;
        }
        await this.emitEvent(EventName.RecoverableDisconnect, {
          sessionId: this.sessionId,
          reason: TeardownReason.ConnectionClosed,
          statusCode,
        });
        await this.scheduleReconnect();
        return;
      }

      this.reconnectAttempts++;
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        await this.emitEvent(EventName.PermanentDisconnect, {
          sessionId: this.sessionId,
          reason: TeardownReason.MaxRetries,
          statusCode: statusCode ?? 0,
        });
        await this.doTeardown(true, TeardownReason.MaxRetries);
        return;
      }

      const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS);
      await this.emitEvent(EventName.RecoverableDisconnect, {
        sessionId: this.sessionId,
        reason: TeardownReason.ConnectionClosed,
        statusCode: statusCode ?? 0,
      });
      await this.scheduleReconnect(delay);
    }
  }

  private async scheduleReconnect(delayMs = RECONNECT_BASE_DELAY_MS): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.reconnectTimeout = setTimeout(() => {
      void this.reconnect();
    }, delayMs);
  }

  private async handleMessage(msg: any): Promise<void> {
    const state = this.stateMachine.getState();
    if (state !== SessionStatus.Connected) {
      this.logger.debug({ sessionId: this.sessionId, state }, 'Ignoring message: not connected');
      return;
    }

    this.lastActivityAt = new Date();

    if (!msg.message) {
      this.logger.debug({ sessionId: this.sessionId }, 'Ignoring message: no message content');
      return;
    }

    const audioMessage = msg.message.audioMessage || msg.message.pttMessage;
    if (!audioMessage) {
      this.logger.debug({ sessionId: this.sessionId, messageType: Object.keys(msg.message)[0] }, 'Ignoring message: not audio');
      return;
    }

    this.logger.info({ sessionId: this.sessionId, sender: msg.key.remoteJid, fromMe: msg.key.fromMe }, 'Processing audio message');

    const msgId = msg.key.id;
    const dedupKey = `${this.sessionId}:${msgId}`;
    if (this.processedMessages.has(dedupKey)) return;

    const chatJid = msg.key.remoteJid;
    const isFromMe = msg.key.fromMe;
    const isGroup = chatJid.endsWith(GROUP_JID_SUFFIX);

    // For groups, the actual sender is in msg.key.participant
    // For DMs, the sender is msg.key.remoteJid
    const senderJid = isGroup ? (msg.key.participant || chatJid) : chatJid;

    if (isFromMe && senderJid !== this.phoneNumber && !senderJid.endsWith('@lid')) {
      this.logger.debug({ sessionId: this.sessionId, msgId, senderJid }, 'Ignoring message: sent by us to someone else');
      this.processedMessages.set(dedupKey, true);
      return;
    }

    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      if (!buffer) {
        this.logger.warn({ sessionId: this.sessionId, msgId }, 'Media download returned empty');
        return;
      }

      const resolvedSenderPhone = await this.resolvePhoneFromJid(senderJid, msg);
      const pushName = msg.pushName || null;

      // Get group name if it's a group message
      let groupName: string | null = null;
      if (isGroup && this.socket) {
        try {
          const groupMetadata = await this.socket.groupMetadata(chatJid);
          groupName = groupMetadata.subject || null;
        } catch (e) {
          this.logger.warn({ err: e, chatJid }, 'Failed to fetch group metadata');
        }
      }

      await this.audioHandler.handleAudioMessage(
        this.socket!,
        senderJid,
        buffer,
        audioMessage.mimetype,
        msgId,
        audioMessage.seconds,
        this.phoneNumber ?? this.allowedPhone,
        resolvedSenderPhone,
        pushName,
        isGroup,
        groupName,
      );
      this.processedMessages.set(dedupKey, true);
    } catch (e) {
      this.logger.error({ err: e, sessionId: this.sessionId, msgId }, 'Failed to process audio message');
    }
  }

  private async resolvePhoneFromJid(jid: string, msg: any): Promise<string | null> {
    if (jid.endsWith(WHATSAPP_JID_SUFFIX)) {
      return jid.split('@')[0];
    }
    if (jid.endsWith(LID_SUFFIX)) {
      const cached = this.lidToPhoneCache.get(jid);
      if (cached) return cached;
      const phone = await this.resolveLidToPhone(jid);
      if (phone) {
        this.lidToPhoneCache.set(jid, phone);
      }
      return phone;
    }
    if (msg.key.participant) {
      return this.resolvePhoneFromJid(msg.key.participant, msg);
    }
    return this.phoneNumber;
  }

  private async resolveLidToPhone(_lid: string): Promise<string | null> {
    return null;
  }

  private async setupSocketAndSession(logMessage: string): Promise<Result<{ socket: WASocket; saveCredentials: () => Promise<void> }, Error>> {
    const { creds, saveCredentials } = await this.loadOrCreateAuthState();
    const version = await fetchLatestBaileysVersion();

    const keyStore = new SignalKeyStore(this.sessionId, this.db, this.client, this.logger);
    this.keyStore = keyStore;
    await keyStore.loadFromDB();

    const keys = makeCacheableSignalKeyStore(keyStore, this.logger);
    const authState: AuthenticationState = { creds, keys };

    const socket = makeWASocket({
      version: version.version,
      logger: this.logger.child({ baileys: true, level: 'silent' }),
      printQRInTerminal: false,
      auth: authState,
    });

    socket.ev.on(Baileys.Event.CredsUpdate, () => { void saveCredentials(); });

    socket.ev.on(Baileys.Event.ConnectionUpdate, (update) => {
      this.handleConnectionUpdate(update, socket, saveCredentials).catch((e) =>
        this.logger.error({ err: e, sessionId: this.sessionId }, 'Error in global connection update handler'),
      );
    });

    this.setupPasskeySocketListeners(socket);

    this.socket = socket;
    return ok({ socket, saveCredentials });
  }

  private async loadOrCreateAuthState(): Promise<{ creds: AuthenticationCreds; saveCredentials: () => Promise<void> }> {
    const rows = await this.db
      .select({ id: whatsappSessions.id, creds: whatsappSessions.creds })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, this.sessionId))
      .limit(1);

    const creds: AuthenticationCreds = rows.length > 0 && rows[0].creds
      ? JSON.parse(rows[0].creds, BufferJSON.reviver)
      : initAuthCreds();

    const saveCredentials = async () => {
      await this.db
        .insert(whatsappSessions)
        .values({ id: this.sessionId, status: SessionStatus.Pending, creds: JSON.stringify(creds, BufferJSON.replacer) })
        .onConflictDoUpdate({
          target: whatsappSessions.id,
          set: { creds: JSON.stringify(creds, BufferJSON.replacer), updatedAt: sql`(unixepoch())` },
        });
    };

    return { creds, saveCredentials };
  }

  private async onConnectionOpen(socket: WASocket, saveCredentials: () => Promise<void>): Promise<Result<void, Error>> {
    await saveCredentials();

    const phoneFromSocket = socket.user?.id?.split(':')[0].replace(/\D/g, '');
    if (phoneFromSocket && phoneFromSocket !== this.allowedPhone) {
      this.logger.fatal({ sessionId: this.sessionId, connectedPhone: phoneFromSocket, allowedPhone: this.allowedPhone }, ERROR_PHONE_MISMATCH);
      await this.emitEvent(EventName.PermanentDisconnect, {
        sessionId: this.sessionId,
        reason: TeardownReason.PhoneMismatch,
        statusCode: BaileysDisconnectCode.LoggedOut,
      });
      await this.doTeardown(true, TeardownReason.PhoneMismatch);
      return err(new Error(ERROR_PHONE_MISMATCH));
    }

    this.phoneNumber = phoneFromSocket ?? this.allowedPhone;
    const trans = this.stateMachine.transition(SessionStatus.Connected, StateMachineAction.ConnectionOpened);
    if (!trans.ok) return trans;

    await saveCredentials();

    await this.db
      .update(whatsappSessions)
      .set({ status: SessionStatus.Connected, phoneNumber: this.phoneNumber, updatedAt: sql`(unixepoch())` })
      .where(eq(whatsappSessions.id, this.sessionId));

    await this.emitEvent(EventName.Connected, {
      sessionId: this.sessionId,
      phoneNumber: this.phoneNumber,
    });

    this.setupMessageListener(socket);
    return ok(undefined);
  }

  private async doTeardown(deleteData: boolean, reason: string): Promise<Result<void, Error>> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.socket) {
      try { await this.socket.end(undefined); } catch { /* best-effort */ }
      this.socket = null;
    }

    if (this.keyStore) {
      await this.keyStore.forceFlush();
      this.keyStore.destroy?.();
      this.keyStore = null;
    }

    if (deleteData) {
      await this.db.delete(whatsappSessionKeys).where(eq(whatsappSessionKeys.sessionId, this.sessionId));
      await this.db.delete(whatsappSessions).where(eq(whatsappSessions.id, this.sessionId));
    } else {
      await this.db
        .update(whatsappSessions)
        .set({ status: SessionStatus.Suspended })
        .where(eq(whatsappSessions.id, this.sessionId));
    }

    this.processedMessages.flushAll();
    this.lidToPhoneCache.clear();

    const transitionResult = this.stateMachine.transition(SessionStatus.Suspended, reason);
    if (!transitionResult.ok) return transitionResult;

    await this.emitEvent(EventName.Disconnected, { sessionId: this.sessionId, reason });
    return ok(undefined);
  }

  private async emitEvent(type: SessionEventName, payload: any): Promise<void> {
    const event: SessionEvent = { type, payload } as SessionEvent;
    try {
      await this.eventSink(event);
    } catch (e) {
      this.logger.error({ err: e, sessionId: this.sessionId, eventType: type }, 'EventSink error');
    }
  }

  getStatus(): SessionStatus {
    return this.stateMachine.getState();
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  isResponsive(): boolean {
    const diff = Date.now() - this.lastActivityAt.getTime();
    return diff < RESPONSIVE_THRESHOLD_MS;
  }

  async submitPasskeyResponse(payload: PasskeySubmitPayload): Promise<Result<void>> {
    if (!this.socket) return err(new Error(ERROR_NO_SOCKET));
    if (!this.passkeyLinkingCache) return err(new Error('No pending passkey request'));

    const cache = this.passkeyLinkingCache;
    try {
      await this.sendPasskeyPrologue(payload.response, cache);
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  getPairingStep(): PairingStep {
    return PairingStepEnum.WaitingQr;
  }

  private setupPasskeySocketListeners(socket: WASocket): void {
    const ws = (socket as any).ws;
    if (!ws) {
      this.logger.warn({ sessionId: this.sessionId }, 'WebSocket not accessible for passkey listeners');
      return;
    }

    ws.on('CB:passkey_prologue_request', (node: any) => {
      this.handlePasskeyPrologueRequest(socket, node).catch((e) =>
        this.logger.error({ err: e, sessionId: this.sessionId }, 'handlePasskeyPrologueRequest error'),
      );
    });

    ws.on('CB:crsc_continuation', (node: any) => {
      this.handleCrscContinuation(socket, node).catch((e) =>
        this.logger.error({ err: e, sessionId: this.sessionId }, 'handleCrscContinuation error'),
      );
    });
  }

  private async handlePasskeyPrologueRequest(socket: WASocket, node: any): Promise<void> {
    this.logger.info({ sessionId: this.sessionId }, 'passkey_prologue_request detected');

    const content = node.content as any[];
    if (!content || content.length === 0) {
      this.logger.warn({ sessionId: this.sessionId }, 'Empty passkey_prologue_request content');
      return;
    }

    const passkeyNode = content.find((n: any) => n.tag === 'passkey_request_options');
    if (!passkeyNode) {
      this.logger.warn({ sessionId: this.sessionId }, 'No passkey_request_options in prologue request');
      return;
    }

    let publicKey: string;
    try {
      const keyData = passkeyNode.content as Uint8Array;
      publicKey = Buffer.from(keyData).toString('base64');
    } catch {
      publicKey = Buffer.from(JSON.stringify(passkeyNode.content)).toString('base64');
    }

    const ephemeralKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDHE', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );
    const companionNonce = crypto.getRandomValues(new Uint8Array(32));
    const deviceType = 5;
    const pairingRef = new Uint8Array(0);

    this.passkeyLinkingCache = {
      ephemeralKeyPair,
      companionNonce,
      pairingRef,
      deviceType,
      passkeyHandoffKey: null,
    };

    this.clearPasskeyTimeoutTimer();
    this.passkeyTimeoutTimer = setTimeout(() => {
      void this.onPasskeyTimeout();
    }, PASSKEY_TIMEOUT_MS);

    await this.emitEvent(EventName.PasskeyRequest, {
      sessionId: this.sessionId,
      publicKey,
    });
  }

  private async sendPasskeyPrologue(
    webAuthnResponse: WebAuthnResponseJSON,
    cache: PasskeyLinkingCache,
  ): Promise<void> {
    if (!this.socket) throw new Error(ERROR_NO_SOCKET);

    const companionEphemeralIdentity = await this.buildCompanionEphemeralIdentity(cache);
    const commitment = await this.computeCommitment(companionEphemeralIdentity, cache.companionNonce);

    const prologuePayloadContent: any[] = [
      { tag: 'ephemeral_identity', attrs: {}, content: companionEphemeralIdentity },
      { tag: 'commitment', attrs: {}, content: commitment },
    ];

    if (cache.passkeyHandoffKey) {
      const proof = await this.computeHmacProof(webAuthnResponse, cache);
      prologuePayloadContent.push({ tag: 'pairing_handoff_proof', attrs: {}, content: proof });
    }

    const iqNode = {
      tag: 'iq',
      attrs: { to: 'w.whatsapp.net', type: 'set', id: `passkey-${Date.now()}` },
      content: [{
        tag: 'passkey_prologue',
        attrs: {},
        content: prologuePayloadContent,
      }],
    };

    await this.socket.query(iqNode);
    this.logger.info({ sessionId: this.sessionId }, 'passkey_prologue IQ sent');
  }

  private async handleCrscContinuation(socket: WASocket, node: any): Promise<void> {
    this.logger.info({ sessionId: this.sessionId }, 'crsc_continuation detected');

    if (!this.passkeyLinkingCache) {
      this.logger.warn({ sessionId: this.sessionId }, 'crsc_continuation but no linking cache');
      return;
    }

    const content = node.content as any[];
    const primaryEphemeralNode = content?.find((n: any) => n.tag === 'primary_ephemeral_identity');
    if (!primaryEphemeralNode) {
      this.logger.warn({ sessionId: this.sessionId }, 'No primary_ephemeral_identity in crsc_continuation');
      return;
    }

    const primaryEphemeralIdentity = primaryEphemeralNode.content as Uint8Array;
    const cache = this.passkeyLinkingCache;

    const sharedSecret = await this.computeSharedSecret(cache.ephemeralKeyPair, primaryEphemeralIdentity);
    const companionNonce = await this.sendCompanionNonce(socket, sharedSecret);
    const confirmationCode = await this.computeConfirmationCode(companionNonce, primaryEphemeralIdentity);

    const codeFormatted = `${confirmationCode.slice(0, 4)}-${confirmationCode.slice(4, 8)}`;
    const skipHandoffUX = false;

    await this.emitEvent(EventName.PasskeyConfirmation, {
      sessionId: this.sessionId,
      code: codeFormatted,
      skipHandoffUX,
    });
  }

  private async sendCompanionNonce(
    socket: WASocket,
    sharedSecret: Uint8Array,
  ): Promise<Uint8Array> {
    if (!this.passkeyLinkingCache) throw new Error('No linking cache');

    const companionNonce = this.passkeyLinkingCache.companionNonce;
    const encKey = await this.deriveEncryptionKey(sharedSecret);

    const nonceIq = {
      tag: 'iq',
      attrs: { to: 'w.whatsapp.net', type: 'set', id: `nonce-${Date.now()}` },
      content: [{
        tag: 'companion_nonce',
        attrs: {},
        content: [{ tag: 'nonce', attrs: {}, content: companionNonce }],
      }],
    };

    await socket.query(nonceIq);
    return companionNonce;
  }

  async submitConfirmation(): Promise<Result<void>> {
    if (!this.socket) return err(new Error(ERROR_NO_SOCKET));
    if (!this.passkeyLinkingCache) return err(new Error('No pending confirmation'));

    try {
      await this.sendEncryptedPairingRequest();
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async sendEncryptedPairingRequest(): Promise<void> {
    if (!this.socket || !this.passkeyLinkingCache) throw new Error('Missing socket or cache');

    const cache = this.passkeyLinkingCache;
    const encKey = new Uint8Array(32);

    const pairingRequestData = Buffer.from(JSON.stringify({
      noiseKey: 'placeholder',
      identityKey: 'placeholder',
      advSecret: 'placeholder',
    }));

    const encrypted = await this.aesGcmEncrypt(pairingRequestData, encKey);

    const iqNode = {
      tag: 'iq',
      attrs: { to: 'w.whatsapp.net', type: 'set', id: `encpair-${Date.now()}` },
      content: [{
        tag: 'encrypted_pairing_request',
        attrs: {},
        content: [{ tag: 'enc_payload', attrs: {}, content: encrypted }],
      }],
    };

    await this.socket.query(iqNode);
    this.logger.info({ sessionId: this.sessionId }, 'encrypted_pairing_request IQ sent');
  }

  private async buildCompanionEphemeralIdentity(cache: PasskeyLinkingCache): Promise<Uint8Array> {
    const publicKey = await crypto.subtle.exportKey('raw', cache.ephemeralKeyPair.publicKey);
    const ref = cache.pairingRef;
    const deviceType = Buffer.from([cache.deviceType]);
    const nonce = cache.companionNonce;

    const combined = new Uint8Array(publicKey.byteLength + ref.byteLength + deviceType.byteLength + nonce.byteLength);
    let offset = 0;
    combined.set(new Uint8Array(publicKey), offset); offset += publicKey.byteLength;
    combined.set(ref, offset); offset += ref.byteLength;
    combined.set(deviceType, offset); offset += deviceType.byteLength;
    combined.set(nonce, offset);

    return combined;
  }

  private async computeCommitment(identity: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
    const combined = new Uint8Array(identity.length + nonce.length);
    combined.set(identity); combined.set(nonce, identity.length);
    const hash = await crypto.subtle.digest('SHA-256', combined);
    return new Uint8Array(hash);
  }

  private async computeHmacProof(_webAuthnResponse: WebAuthnResponseJSON, _cache: PasskeyLinkingCache): Promise<Uint8Array> {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  private async computeSharedSecret(privateKey: CryptoKeyPair, peerPublicKey: Uint8Array): Promise<Uint8Array> {
    const peerKey = await crypto.subtle.importKey(
      'raw', peerPublicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, [],
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerKey },
      privateKey.privateKey,
      256,
    );
    return new Uint8Array(sharedBits);
  }

  private async deriveEncryptionKey(sharedSecret: Uint8Array): Promise<Uint8Array> {
    const hash = await crypto.subtle.digest('SHA-256', sharedSecret);
    return new Uint8Array(hash);
  }

  private async computeConfirmationCode(companionNonce: Uint8Array, primaryPubKey: Uint8Array): Promise<string> {
    const combined = new Uint8Array(companionNonce.length + primaryPubKey.length);
    combined.set(companionNonce); combined.set(primaryPubKey, companionNonce.length);
    const hash = await crypto.subtle.digest('SHA-256', combined);
    const codeBytes = new Uint8Array(hash).slice(0, 5);
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += String(codeBytes[i] % 10);
    }
    return code;
  }

  private async aesGcmEncrypt(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key,
      { name: 'AES-GCM' },
      false, ['encrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey, data,
    );
    const result = new Uint8Array(iv.length + (encrypted as ArrayBuffer).byteLength);
    result.set(iv); result.set(new Uint8Array(encrypted), iv.length);
    return result;
  }

  private clearPasskeyTimeoutTimer(): void {
    if (this.passkeyTimeoutTimer) {
      clearTimeout(this.passkeyTimeoutTimer);
      this.passkeyTimeoutTimer = null;
    }
  }

  private async onPasskeyTimeout(): Promise<void> {
    this.logger.warn({ sessionId: this.sessionId }, 'Passkey flow timed out');
    this.clearPasskeyTimeoutTimer();
    this.passkeyLinkingCache = null;
    await this.emitEvent(EventName.PasskeyError, {
      sessionId: this.sessionId,
      error: 'Timeout waiting for passkey verification',
      isContinuation: false,
    });
    await this.doTeardown(true, TeardownReason.PasskeyTimeout);
  }
}
