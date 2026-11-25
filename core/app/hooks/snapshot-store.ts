export class SnapshotStore<T> {
  private snapshot: T;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.snapshot = initial;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(patch: Partial<T>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
