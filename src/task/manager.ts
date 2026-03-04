import { generateTaskId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { TaskQueue } from './queue.js';
import type { ITask, ITaskSource, ITaskCallbacks, TaskStatus } from './types.js';

/** 任务管理器 */
export class TaskManager {
  /** 所有任务（taskId -> ITask） */
  private tasks = new Map<string, ITask>();
  /** 任务队列 */
  private queue: TaskQueue<ITask>;
  /** 任务执行函数 */
  private executor: ((task: ITask) => Promise<void>) | null = null;
  /** 回调 */
  private callbacks: ITaskCallbacks;

  constructor(callbacks: ITaskCallbacks) {
    this.callbacks = callbacks;
    this.queue = new TaskQueue<ITask>(async (task) => {
      await this.executeTask(task);
    });
  }

  /** 注册任务执行器 */
  setExecutor(executor: (task: ITask) => Promise<void>): void {
    this.executor = executor;
  }

  /** 创建并加入队列 */
  async createTask(source: ITaskSource, projectPath: string, prompt: string): Promise<ITask> {
    const logger = getLogger();
    const taskId = generateTaskId();

    const task: ITask = {
      taskId,
      source,
      projectPath,
      prompt,
      status: 'pending',
      createdAt: Date.now(),
      output: '',
      changedFiles: [],
    };

    this.tasks.set(taskId, task);

    logger.info({ taskId, projectPath, prompt: prompt.slice(0, 100) }, '任务已创建');

    // 加入队列（不等待执行完成）
    this.queue.enqueue(task).catch((err) => {
      logger.error({ err, taskId }, '任务队列执行异常');
    });

    return task;
  }

  /** 获取任务 */
  getTask(taskId: string): ITask | undefined {
    return this.tasks.get(taskId);
  }

  /** 获取最近的任务 */
  getRecentTask(): ITask | undefined {
    let latest: ITask | undefined;
    for (const task of this.tasks.values()) {
      if (!latest || task.createdAt > latest.createdAt) {
        latest = task;
      }
    }
    return latest;
  }

  /** 取消任务 */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'pending') {
      task.status = 'cancelled';
      return true;
    }

    // running 状态的任务需要通过执行器来取消
    if (task.status === 'running') {
      task.status = 'cancelled';
      return true;
    }

    return false;
  }

  /**
   * 取消指定聊天会话的所有任务（running + pending）
   * @returns 正在运行的任务 taskId（如果有），调用方需要据此 kill 执行器
   */
  cancelChatTasks(chatId: string): string | null {
    const logger = getLogger();
    let runningTaskId: string | null = null;

    // 1. 找到正在运行的任务并标记取消
    for (const task of this.tasks.values()) {
      if (task.source.chatId === chatId && task.status === 'running') {
        task.status = 'cancelled';
        runningTaskId = task.taskId;
        logger.info({ taskId: task.taskId, chatId }, '取消正在运行的任务（新消息到达）');
      }
    }

    // 2. 从队列中移除该会话的待执行任务
    const removed = this.queue.removeBy(
      (task) => task.source.chatId === chatId && task.status === 'pending'
    );
    for (const task of removed) {
      task.status = 'cancelled';
      logger.info({ taskId: task.taskId, chatId }, '取消排队中的任务（新消息到达）');
    }

    return runningTaskId;
  }

  /** 更新任务状态 */
  updateStatus(taskId: string, status: TaskStatus): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
    }
  }

  /** 追加输出 */
  appendOutput(taskId: string, chunk: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.output += chunk;
    }
  }

  /** 设置修改的文件 */
  setChangedFiles(taskId: string, files: string[]): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.changedFiles = files;
    }
  }

  /** 队列中等待的任务数 */
  get queueLength(): number {
    return this.queue.length;
  }

  /** 清理过期任务（保留最近 50 条） */
  cleanup(): void {
    const logger = getLogger();
    if (this.tasks.size <= 50) return;

    const sorted = [...this.tasks.entries()].sort(
      ([, a], [, b]) => b.createdAt - a.createdAt
    );

    const toRemove = sorted.slice(50);
    for (const [taskId] of toRemove) {
      this.tasks.delete(taskId);
    }

    logger.debug({ removed: toRemove.length }, '清理过期任务');
  }

  /** 执行任务 */
  private async executeTask(task: ITask): Promise<void> {
    const logger = getLogger();

    // 检查是否已被取消
    if (task.status === 'cancelled') {
      logger.info({ taskId: task.taskId }, '任务已取消，跳过执行');
      return;
    }

    if (!this.executor) {
      throw new Error('未注册任务执行器');
    }

    task.status = 'running';
    task.startedAt = Date.now();

    try {
      await this.callbacks.onStart(task);
      await this.executor(task);

      // 检查执行后是否被取消（status 可能被外部修改）
      if ((task.status as TaskStatus) === 'cancelled') {
        logger.info({ taskId: task.taskId }, '任务执行期间被取消');
        task.finishedAt = Date.now();
        await this.callbacks.onCancelled(task);
        return;
      }

      task.status = 'success';
      task.finishedAt = Date.now();
      await this.callbacks.onComplete(task);
    } catch (err) {
      task.status = 'failed';
      task.finishedAt = Date.now();
      task.error = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: task.taskId }, '任务执行失败');
      await this.callbacks.onError(task, err instanceof Error ? err : new Error(String(err)));
    }

    this.cleanup();
  }
}
