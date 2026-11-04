export interface HostSession {
  readonly id: string
}

export interface HostSessionEvent {
  readonly type: string
  readonly time: number
  readonly data: unknown
}

export interface HostConnectionRpcHandlerResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string; readonly details: object }
}

export interface HostConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<HostConnectionRpcHandlerResult>,
  ): () => Promise<void>
}

export interface HostEventOptions {
  /** Receive the event regardless of context/scope filter checks. */
  readonly global?: boolean
  readonly prepend?: boolean
}

export interface HostContext {
  effect(callback: () => void | (() => void), label?: string): () => void
  on(
    event: 'session/event',
    listener: (session: HostSession, event: HostSessionEvent) => void,
    options?: HostEventOptions,
  ): () => void
  get(name: string): unknown
  inject(deps: string[], callback: (scoped: HostContext) => void | (() => void)): unknown
  logger: { warn(message: string, error?: unknown): void }
  sessions: { list(): readonly HostSession[] }
}
