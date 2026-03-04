import { getLogger } from '../utils/logger.js';

interface QueueItem<T> {
  data: T;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
}

/**
 * 串行任务队列
 * 同一时间只执行一个任务，防止并发冲突
 */
export class TaskQueue<T> {
  private queue: QueueItem<T>[] = [];
  private running = false;
  private processor: (item: T) => Promise<void>;

  constructor(processor: (item: T) => Promise<void>) {
    this.processor = processor;
  }

  /** 将任务加入队列 */
  enqueue(data: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, resolve, reject });
      this.processNext();
    });
  }

  /** 当前队列长度 */
  get length(): number {
    return this.queue.length;
  }

  /** 是否正在执行任务 */
  get isRunning(): boolean {
    return this.running;
  }

  private async processNext(): Promise<void> {
    if (this.running) return;

    const item = this.queue.shift();
    if (!item) return;

    const logger = getLogger();
    this.running = true;

    try {
      await this.processor(item.data);
      item.resolve();
    } catch (err) {
      logger.error({ err }, '队列任务执行失败');
      item.reject(err);
    } finally {
      this.running = false;
      // 继续处理下一个
      this.processNext();
    }
  }

  /** 按条件移除队列中的待执行任务（不影响正在执行的任务） */
  removeBy(predicate: (item: T) => boolean): T[] {
    const logger = getLogger();
    const removed: T[] = [];
    const remaining: QueueItem<T>[] = [];

    for (const item of this.queue) {
      if (predicate(item.data)) {
        removed.push(item.data);
        item.reject(new Error('任务已被取消'));
      } else {
        remaining.push(item);
      }
    }

    this.queue = remaining;
    if (removed.length > 0) {
      logger.info({ count: removed.length }, '已从队列中移除任务');
    }
    return removed;
  }

  /** 清空队列（不影响正在执行的任务） */
  clear(): void {
    const logger = getLogger();
    const count = this.queue.length;
    for (const item of this.queue) {
      item.reject(new Error('队列已清空'));
    }
    this.queue = [];
    if (count > 0) {
      logger.info({ count }, '已清空队列中的任务');
    }
  }
}
