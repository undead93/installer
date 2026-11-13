// Small FIFO job queue: encoding is CPU-bound, so jobs run one (or N) at a time.
export class JobQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.waiting = [];
    this.running = new Map(); // user -> job
  }

  get length() {
    return this.waiting.length;
  }

  get busy() {
    return this.running.size;
  }

  has(user) {
    return this.running.has(user) || this.waiting.some((j) => j.user === user);
  }

  /** 0 = running now, n = n jobs ahead in the line. */
  position(user) {
    if (this.running.has(user)) return 0;
    const i = this.waiting.findIndex((j) => j.user === user);
    return i < 0 ? -1 : i + 1;
  }

  push(user, task) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ user, task, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this.running.size < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift();
      this.running.set(job.user, job);
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running.delete(job.user);
          this.#pump();
        });
    }
  }
}
