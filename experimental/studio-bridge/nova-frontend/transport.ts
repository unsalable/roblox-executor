/**
 * The bridge transport abstraction. The session (protocol, pairing, heartbeat,
 * correlation) is written against this interface and never touches a socket
 * directly, so the same session logic runs over the real loopback transport
 * and over an in-memory fake in tests.
 *
 * The plugin is always the network client: it POSTs request/response messages
 * ("deliveries") and long-polls for messages Nova pushes to it. That shape is
 * dictated by Roblox Studio, whose plugins can use HttpService but have no
 * outbound socket or WebSocket API.
 */

/** An inbound request from the plugin that expects a single correlated reply. */
export interface BridgeDelivery {
  /** Raw message body, still to be decoded by the session. */
  readonly body: string;
  /** Session token the plugin presented, or null before pairing. */
  readonly token: string | null;
  /** Sends the reply body back on the same request. Safe to call once. */
  readonly respond: (body: string) => void;
}

export interface BridgePollEvent {
  /** Session token the poller presented. */
  readonly token: string | null;
}

export interface BridgeStartResult {
  /** Human-readable bound address, e.g. "127.0.0.1:46682". */
  readonly address: string;
}

export interface BridgeTransport {
  readonly kind: "tauri" | "fake";
  /** Binds the loopback listener. Rejects with a structured reason on failure. */
  start: (config: { port: number }) => Promise<BridgeStartResult>;
  /** Stops the listener and releases parked polls. Idempotent. */
  stop: () => Promise<void>;
  /** Queues a message for delivery on the plugin's next authenticated poll. */
  push: (message: string) => void;
  /**
   * Drops every queued but undelivered message. Called when a session ends, so
   * traffic addressed to a session that no longer exists can never be picked up
   * by the next one.
   */
  clearQueue: () => void;
  /**
   * Sets the token the transport requires on polls and non-pairing requests.
   * Null means "not paired yet": polls are refused, requests are allowed so the
   * pairing exchange can happen.
   */
  setAuthToken: (token: string | null) => void;
  /** A request arrived from the plugin. */
  onDelivery: (handler: (delivery: BridgeDelivery) => void) => () => void;
  /** The plugin polled; used only for liveness accounting. */
  onPoll: (handler: (event: BridgePollEvent) => void) => () => void;
  /** A transport-level failure occurred (bind lost, listener error). */
  onError: (handler: (error: { message: string }) => void) => () => void;
}
