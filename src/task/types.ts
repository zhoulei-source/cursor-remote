/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';

/** 任务来源（飞书会话信息） */
export interface ITaskSource {
  /** 飞书消息 ID */
  messageId: string;
  /** 飞书会话 ID */
  chatId: string;
  /** 飞书会话类型 */
  chatType: string;
  /** 发送者 ID */
  senderId: string;
}

/** 任务定义 */
export interface ITask {
  /** 任务唯一 ID */
  taskId: string;
  /** 任务来源信息 */
  source: ITaskSource;
  /** 项目目录路径 */
  projectPath: string;
  /** 用户的自然语言 prompt */
  prompt: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 任务创建时间 */
  createdAt: number;
  /** 任务开始执行时间 */
  startedAt?: number;
  /** 任务完成时间 */
  finishedAt?: number;
  /** 累积的输出内容 */
  output: string;
  /** 修改的文件列表 */
  changedFiles: string[];
  /** 错误信息 */
  error?: string;
  /** 飞书状态消息 ID（用于实时更新） */
  statusMessageId?: string;
}

/** 任务执行回调 */
export interface ITaskCallbacks {
  /** 任务开始执行 */
  onStart: (task: ITask) => Promise<void>;
  /** 收到流式输出 */
  onOutput: (task: ITask, chunk: string) => Promise<void>;
  /** 任务完成 */
  onComplete: (task: ITask) => Promise<void>;
  /** 任务失败 */
  onError: (task: ITask, error: Error) => Promise<void>;
  /** 任务被取消 */
  onCancelled: (task: ITask) => Promise<void>;
}
