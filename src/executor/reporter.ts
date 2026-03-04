import type { FeishuMessenger } from '../feishu/message.js';
import type { ITask } from '../task/types.js';
import { truncateOutput } from './stream-parser.js';
import { getLogger } from '../utils/logger.js';

/**
 * 对话式结果推送器
 * 以普通文本消息的形式，流式更新 Agent 的执行输出
 */
export class StreamReporter {
  private messenger: FeishuMessenger;
  private pushInterval: number;
  /** 每个任务的推送定时器 */
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  /** 每个任务上次推送时的输出长度（避免重复推送） */
  private lastPushedLength = new Map<string, number>();

  constructor(messenger: FeishuMessenger, pushInterval: number) {
    this.messenger = messenger;
    this.pushInterval = pushInterval;
  }

  /** 任务开始：回复一条"思考中"消息，后续流式更新这条消息 */
  async onTaskStart(task: ITask): Promise<void> {
    const logger = getLogger();

    try {
      // 回复用户消息，作为后续流式更新的载体
      const replyId = await this.messenger.replyText(task.source.messageId, '🤔 思考中...');
      if (replyId) {
        task.statusMessageId = replyId;
      }

      // 启动定时推送
      this.startPeriodicPush(task);

      logger.debug({ taskId: task.taskId, replyId }, '已回复初始消息');
    } catch (err) {
      logger.error({ err, taskId: task.taskId }, '回复初始消息失败');
    }
  }

  /** 收到输出块：由定时器批量推送 */
  async onOutput(_task: ITask, _chunk: string): Promise<void> {
    // 输出已被累积到 task.output，由定时器统一推送
  }

  /** 任务完成：推送最终结果 */
  async onTaskComplete(task: ITask): Promise<void> {
    const logger = getLogger();
    this.stopPeriodicPush(task.taskId);

    try {
      const finalText = this.buildFinalText(task);

      if (task.statusMessageId) {
        await this.messenger.updateMessage(task.statusMessageId, finalText);
      } else {
        await this.messenger.sendText(task.source.chatId, finalText);
      }

      const duration = (task.finishedAt ?? Date.now()) - (task.startedAt ?? task.createdAt);
      logger.info(
        {
          taskId: task.taskId,
          status: task.status,
          duration: `${(duration / 1000).toFixed(1)}s`,
          changedFiles: task.changedFiles,
        },
        '任务完成，结果已推送'
      );
      // 打印 Agent 实际输出内容，方便终端查看
      logger.info('── Agent 输出 ──────────────────────');
      console.log(task.output || '（无输出）');
      logger.info('───────────────────────────────────');
    } catch (err) {
      logger.error({ err, taskId: task.taskId }, '推送完成结果失败');
    }
  }

  /** 任务被取消：更新状态消息 */
  async onTaskCancelled(task: ITask): Promise<void> {
    const logger = getLogger();
    this.stopPeriodicPush(task.taskId);

    try {
      const duration = (task.finishedAt ?? Date.now()) - (task.startedAt ?? task.createdAt);
      const cancelText = `⏹️ 已取消 (${(duration / 1000).toFixed(1)}s)\n收到新消息，旧任务自动终止。`;

      if (task.statusMessageId) {
        await this.messenger.updateMessage(task.statusMessageId, cancelText);
      }

      logger.info({ taskId: task.taskId }, '取消通知已推送');
    } catch (err) {
      logger.error({ err, taskId: task.taskId }, '推送取消通知失败');
    }
  }

  /** 任务失败：推送错误信息 */
  async onTaskError(task: ITask, error: Error): Promise<void> {
    const logger = getLogger();
    this.stopPeriodicPush(task.taskId);

    try {
      const errorText = task.output
        ? truncateOutput(task.output, 3000)
        : `❌ 执行失败: ${error.message}`;

      if (task.statusMessageId) {
        await this.messenger.updateMessage(task.statusMessageId, `❌ ${errorText}`);
      } else {
        await this.messenger.sendText(task.source.chatId, `❌ ${errorText}`);
      }

      logger.info({ taskId: task.taskId, error: error.message }, '错误信息已推送');
    } catch (err) {
      logger.error({ err, taskId: task.taskId }, '推送错误信息失败');
    }
  }

  /** 启动定时推送：每隔一段时间更新回复消息内容 */
  private startPeriodicPush(task: ITask): void {
    const logger = getLogger();
    this.lastPushedLength.set(task.taskId, 0);

    const timer = setInterval(async () => {
      const lastLen = this.lastPushedLength.get(task.taskId) ?? 0;

      // 没有新输出，跳过
      if (task.output.length === lastLen) return;
      this.lastPushedLength.set(task.taskId, task.output.length);

      if (!task.statusMessageId) return;

      try {
        const text = truncateOutput(task.output, 3000) + '\n\n⏳ 执行中...';
        await this.messenger.updateMessage(task.statusMessageId, text);
        logger.debug({ taskId: task.taskId, outputLen: task.output.length }, '流式更新');
      } catch (err) {
        logger.error({ err, taskId: task.taskId }, '流式更新失败');
      }
    }, this.pushInterval);

    this.timers.set(task.taskId, timer);
  }

  /** 停止定时推送 */
  private stopPeriodicPush(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(taskId);
    }
    this.lastPushedLength.delete(taskId);
  }

  /** 构建最终文本 */
  private buildFinalText(task: ITask): string {
    const output = task.output ? truncateOutput(task.output, 3000) : '（无输出）';
    const duration = (task.finishedAt ?? Date.now()) - (task.startedAt ?? task.createdAt);
    const parts: string[] = [output];

    if (task.changedFiles.length > 0) {
      parts.push(`\n📝 修改文件: ${task.changedFiles.join(', ')}`);
    }

    parts.push(`\n✅ 完成 (${(duration / 1000).toFixed(1)}s)`);

    return parts.join('');
  }

  /** 清理所有定时器 */
  cleanup(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.lastPushedLength.clear();
  }
}
