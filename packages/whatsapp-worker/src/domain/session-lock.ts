import { Mutex } from 'async-mutex';

export class SessionLock {
  private readonly mutex = new Mutex();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(fn);
  }

  isLocked(): boolean {
    return this.mutex.isLocked();
  }
}
