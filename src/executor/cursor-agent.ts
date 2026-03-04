import { spawn, type ChildProcess } from 'child_process';
import type { ICursorConfig } from '../config.js';
import type { ITask } from '../task/types.js';
import { getLogger } from '../utils/logger.js';
import { extractChangedFiles } from './stream-parser.js';

/** Cursor Agent 执行器的输出回调 */
export interface IExecutorCallbacks {
  onOutput: (task: ITask, chunk: string) => Promise<void>;
  onComplete: (task: ITask) => Promise<void>;
  onError: (task: ITask, error: Error) => Promise<void>;
}

/** 执行结果，包含 session_id 用于会话恢复 */
export interface IExecuteResult {
  sessionId: string | null;
}

/** 活跃的执行器实例（用于取消） */
interface IActiveProcess {
  child: ChildProcess;
  taskId: string;
}

/**
 * Cursor Agent 执行器
 * 支持 --resume 会话恢复
 */
export class CursorAgentExecutor {
  private config: ICursorConfig;
  private activeProcess: IActiveProcess | null = null;

  constructor(config: ICursorConfig) {
    this.config = config;
  }

  /**
   * 执行 Cursor Agent 任务
   * @param task 任务对象
   * @param callbacks 回调
   * @param resumeSessionId 可选，恢复指定会话
   * @returns 执行结果（包含 session_id）
   */
  async execute(
    task: ITask,
    callbacks: IExecutorCallbacks,
    resumeSessionId?: string
  ): Promise<IExecuteResult> {
    const logger = getLogger();

    logger.info(
      {
        taskId: task.taskId,
        projectPath: task.projectPath,
        prompt: task.prompt.slice(0, 100),
        resume: resumeSessionId ?? 'new session',
      },
      '启动 Cursor Agent'
    );

    return new Promise<IExecuteResult>((resolve, reject) => {
      let fullOutput = '';
      let sessionId: string | null = null;
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      // 超时处理
      const timeout = setTimeout(() => {
        logger.warn({ taskId: task.taskId }, '任务执行超时');
        task.status = 'timeout';
        this.killActive();
        settle(() => reject(new Error(`任务超时 (${this.config.taskTimeout / 1000}s)`)));
      }, this.config.taskTimeout);

      try {
        // 构建参数
        const args = [
          '-p',
          '--output-format', 'stream-json',
          '--stream-partial-output',
          '--force',
          '--trust',
          '--workspace', task.projectPath,
        ];

        // 恢复会话
        if (resumeSessionId) {
          args.push('--resume', resumeSessionId);
        }

        // prompt 放最后
        args.push(task.prompt);

        logger.debug({ agentPath: this.config.agentPath, args, resume: !!resumeSessionId }, '启动参数');

        const child = spawn(this.config.agentPath, args, {
          cwd: task.projectPath,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.activeProcess = { child, taskId: task.taskId };
        logger.debug({ pid: child.pid, taskId: task.taskId }, '子进程已启动');

        // 处理 stdout — stream-json 每行一个 JSON
        let buffer = '';
        child.stdout?.on('data', (data: Buffer) => {
          buffer += data.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const event = JSON.parse(trimmed) as Record<string, unknown>;

              // 提取 session_id（第一条 init 事件就会带）
              if (event['session_id'] && !sessionId) {
                sessionId = event['session_id'] as string;
                logger.debug({ sessionId }, '获取到 session_id');
              }

              // 提取可读文本
              const text = this.extractText(event);
              if (text) {
                // 去重：cursor-agent 在 stream-partial-output 模式下，
                // 可能在流式 delta 之后再发一个完整内容的 assistant 事件，
                // 如果新文本和已累积输出一致，说明是重复的完整消息，跳过
                const isDuplicate =
                  fullOutput.length > 0 &&
                  text.length >= fullOutput.length * 0.8 &&
                  (fullOutput.trim() === text.trim() || fullOutput.trim().startsWith(text.trim()) || text.trim().startsWith(fullOutput.trim()));

                if (!isDuplicate) {
                  fullOutput += text;
                  task.output = fullOutput;

                  const files = extractChangedFiles(fullOutput);
                  if (files.length > 0) {
                    task.changedFiles = files;
                  }

                  callbacks.onOutput(task, text).catch((err) => {
                    logger.error({ err }, '输出回调失败');
                  });
                } else {
                  logger.debug({ taskId: task.taskId, textLen: text.length, outputLen: fullOutput.length }, '跳过重复文本');
                }
              }
            } catch {
              // 非 JSON 行，当作普通文本
              fullOutput += trimmed + '\n';
              task.output = fullOutput;
              callbacks.onOutput(task, trimmed).catch((err) => {
                logger.error({ err }, '输出回调失败');
              });
            }
          }
        });

        // 处理 stderr
        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString('utf-8').trim();
          if (text) {
            logger.debug({ taskId: task.taskId, stderr: text }, 'stderr');
            fullOutput += `[stderr] ${text}\n`;
            task.output = fullOutput;
          }
        });

        // 进程退出
        child.on('close', (exitCode) => {
          clearTimeout(timeout);
          this.activeProcess = null;

          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer.trim()) as Record<string, unknown>;
              if (event['session_id'] && !sessionId) {
                sessionId = event['session_id'] as string;
              }
              const text = this.extractText(event);
              if (text) {
                // 去重：同上，避免 close 时残留 buffer 里的完整消息再次追加
                const isDuplicate =
                  fullOutput.length > 0 &&
                  text.length >= fullOutput.length * 0.8 &&
                  (fullOutput.trim() === text.trim() || fullOutput.trim().startsWith(text.trim()) || text.trim().startsWith(fullOutput.trim()));

                if (!isDuplicate) {
                  fullOutput += text;
                  task.output = fullOutput;
                }
              }
            } catch {
              fullOutput += buffer.trim();
              task.output = fullOutput;
            }
          }

          logger.info(
            { taskId: task.taskId, exitCode, outputLength: fullOutput.length, sessionId },
            'Cursor Agent 执行完毕'
          );

          task.changedFiles = extractChangedFiles(fullOutput);

          if (exitCode === 0 || task.status === 'cancelled') {
            settle(() => resolve({ sessionId }));
          } else {
            settle(() =>
              reject(new Error(`Cursor Agent 退出码: ${exitCode}\n${fullOutput.slice(-500)}`))
            );
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          this.activeProcess = null;
          logger.error({ err, taskId: task.taskId }, '子进程启动失败');
          settle(() => reject(err));
        });
      } catch (err) {
        clearTimeout(timeout);
        this.activeProcess = null;
        settle(() => reject(err as Error));
      }
    });
  }

  /**
   * 从 stream-json 事件中提取可读文本
   * 跳过 thinking（思考过程）、system、user、result 等事件
   * 只提取 assistant 消息中的文本
   */
  private extractText(event: Record<string, unknown>): string {
    const type = event['type'] as string | undefined;

    // 跳过思考过程
    if (type === 'thinking') return '';

    // 跳过系统/用户/结果事件
    if (type === 'system' || type === 'user' || type === 'result') return '';

    // assistant 流式 delta — 只取 text 类型的内容
    if (type === 'assistant') {
      const msg = event['message'] as Record<string, unknown> | undefined;
      if (msg) {
        const content = msg['content'] as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(content)) {
          return content
            .filter((c) => c['type'] === 'text')
            .map((c) => c['text'] as string)
            .join('');
        }
      }
    }

    return '';
  }

  /** 终止当前活跃进程，通知 Agent 停止工作 */
  killActive(): void {
    const logger = getLogger();
    if (this.activeProcess) {
      logger.info({ taskId: this.activeProcess.taskId }, '终止 Cursor Agent 进程');
      const child = this.activeProcess.child;

      try {
        // 1. 关闭 stdin，通知 Agent 输入已结束
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }

        // 2. 发送 SIGINT（等同 Ctrl+C），让 cursor-agent 优雅取消当前任务
        child.kill('SIGINT');

        // 3. 如果 SIGINT 后 3 秒仍未退出，发 SIGTERM
        setTimeout(() => {
          if (!child.killed) {
            logger.warn({ taskId: this.activeProcess?.taskId }, 'SIGINT 未生效，发送 SIGTERM');
            child.kill('SIGTERM');
          }
        }, 3000);

        // 4. 如果 SIGTERM 后 2 秒仍未退出，强制 SIGKILL
        setTimeout(() => {
          if (!child.killed) {
            logger.warn({ taskId: this.activeProcess?.taskId }, 'SIGTERM 未生效，强制 SIGKILL');
            child.kill('SIGKILL');
          }
        }, 5000);
      } catch {
        // 忽略
      }
      this.activeProcess = null;
    }
  }

  get isRunning(): boolean {
    return this.activeProcess !== null;
  }

  get activeTaskId(): string | null {
    return this.activeProcess?.taskId ?? null;
  }
}
