/**
 * Baileys disconnect status codes extracted from magic numbers.
 * These map to WhatsApp Web's internal close codes.
 */
export enum BaileysDisconnectCode {
  /** Client was logged out (device removed or session invalidated). */
  LoggedOut = 401,
  /** Method not allowed — typically indicates an outdated client. */
  MethodNotAllowed = 405,
  /** Restart required — server wants the client to reconnect. */
  RestartRequired = 515,
  /** Conflict — another device took over the session. */
  Conflict = 440,
}

/**
 * Typed reasons for session teardown, replacing magic strings.
 */
export enum TeardownReason {
  PhoneMismatch = 'phone_mismatch',
  QrTimeout = 'qr_timeout',
  PairingRequest = 'pairing_request',
  PairingTimeout = 'pairing_timeout',
  PairingCodeFailed = 'pairing_code_failed',
  LoggedOut = 'logged_out',
  ConnectionClosed = 'connection_closed',
  InvalidSession = 'invalid_session',
  MaxRetries = 'max_retries',
  Disconnected = 'disconnected',
  Shutdown = 'shutdown',
}