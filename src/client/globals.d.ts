interface TaskballSlots {
  inject(key: 'shell.overlay' | 'plugins.bundle.config', callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
  /** Ledger read used to reach the settings shell's seat (F-009). */
  entries?(key: string): readonly unknown[]
}

interface TaskballUiWorkspace {
  openSession(target: string): void
}

interface TaskballConfigForm {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: Record<string, unknown> | undefined
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly { op: 'set'; path: string[]; value: unknown }[], expectedRevision?: number): Promise<boolean>
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

interface TaskballClientContext {
  slots: TaskballSlots
  uiWorkspace: TaskballUiWorkspace
  configForms: {
    get(entryId: string): TaskballConfigForm
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  }
  /**
   * Optional-service read. Cordis THROWS when a service outside `inject` is read
   * as a property, so an optional service must go through `get` (AGENTS.md §13).
   * Always present on a cordis `Context`; it returns `undefined` for a service
   * that is not available instead of throwing.
   */
  get(name: string): unknown
  effect(callback: () => void | (() => void), label?: string): () => void
}
