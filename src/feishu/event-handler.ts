import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

/** 从飞书消息事件中解析出的结构化数据 */
export interface IParsedMessage {
  /** 消息 ID */
  messageId: string;
  /** 会话 ID */
  chatId: string;
  /** 会话类型: p2p 或 group */
  chatType: string;
  /** 发送者 ID */
  senderId: string;
  /** 消息文本内容 */
  text: string;
  /** 原始事件数据 */
  raw: unknown;
}

/** 从飞书消息事件中解析的指令 */
export interface IParsedCommand {
  /** 指令类型 */
  type: 'run' | 'status' | 'cancel' | 'help' | 'new' | 'unknown';
  /** 项目路径（可选） */
  projectPath?: string;
  /** 任务描述 / prompt */
  prompt?: string;
  /** 任务 ID（用于查询/取消） */
  taskId?: string;
}

/**
 * 解析飞书消息事件 data
 * 飞书 im.message.receive_v1 事件的 data 结构:
 * {
 *   sender: { sender_id: { open_id, user_id, union_id }, ... },
 *   message: { message_id, chat_id, chat_type, content, message_type, ... }
 * }
 */
export function parseMessageEvent(data: Record<string, unknown>): IParsedMessage | null {
  const logger = getLogger();

  try {
    const message = data['message'] as Record<string, unknown> | undefined;
    const sender = data['sender'] as Record<string, unknown> | undefined;

    if (!message) {
      logger.warn({ data }, '消息事件缺少 message 字段');
      return null;
    }

    const messageType = message['message_type'] as string;
    if (messageType !== 'text') {
      logger.debug({ messageType }, '忽略非文本消息');
      return null;
    }

    // 解析消息内容 - content 是 JSON 字符串
    const contentStr = message['content'] as string;
    let text = '';
    try {
      const content = JSON.parse(contentStr) as Record<string, string>;
      text = content['text'] ?? '';
    } catch {
      text = contentStr ?? '';
    }

    // 去除 @机器人 的 mention 标记
    text = text.replace(/@_user_\d+/g, '').trim();

    const senderInfo = sender?.['sender_id'] as Record<string, string> | undefined;

    return {
      messageId: message['message_id'] as string,
      chatId: message['chat_id'] as string,
      chatType: message['chat_type'] as string,
      senderId: senderInfo?.['open_id'] ?? 'unknown',
      text,
      raw: data,
    };
  } catch (err) {
    logger.error({ err, data }, '解析消息事件失败');
    return null;
  }
}

/**
 * 解析用户消息为指令
 *
 * 支持的格式:
 * - /run [项目路径] 任务描述
 * - /status [任务ID]
 * - /cancel 任务ID
 * - /help
 * - 直接发送文本（等同于 /run 默认项目 文本内容）
 */
export function parseCommand(text: string): IParsedCommand {
  const trimmed = text.trim();

  // /help 指令
  if (trimmed === '/help' || trimmed === '帮助') {
    return { type: 'help' };
  }

  // /new 指令 — 重置会话
  if (trimmed === '/new' || trimmed === '新会话' || trimmed === '重置') {
    return { type: 'new' };
  }

  // /status 指令
  const statusMatch = trimmed.match(/^\/status\s*(task-\S+)?$/);
  if (statusMatch) {
    return { type: 'status', taskId: statusMatch[1] };
  }

  // /cancel 指令
  const cancelMatch = trimmed.match(/^\/cancel\s+(task-\S+)$/);
  if (cancelMatch) {
    return { type: 'cancel', taskId: cancelMatch[1] };
  }

  // /run 指令（带路径：路径必须以 / ~ ./ ../ 开头，看起来像文件路径）
  const runMatch = trimmed.match(/^\/run\s+((?:~|\.{0,2})?\/\S+)\s+(.+)$/s);
  if (runMatch) {
    const projectPath = runMatch[1].replace(/^~/, homedir());
    return { type: 'run', projectPath, prompt: runMatch[2].trim() };
  }

  // /run 指令（不带路径）
  const runNoPathMatch = trimmed.match(/^\/run\s+(.+)$/s);
  if (runNoPathMatch) {
    return { type: 'run', prompt: runNoPathMatch[1].trim() };
  }

  // 直接发送文本 -> 作为默认项目的 /run
  if (trimmed.length > 0) {
    return { type: 'run', prompt: trimmed };
  }

  return { type: 'unknown' };
}

/** 生成帮助消息 */
export function getHelpMessage(): string {
  return [
    '🤖 Cursor Agent 飞书助手',
    '',
    '直接发消息即可对话，同一聊天窗口内自动保持上下文。',
    '',
    '指令:',
    '• /new — 开启新会话（清除上下文）',
    '• /run [路径] 描述 — 指定项目路径执行',
    '• /status — 查看当前会话/任务状态',
    '• /cancel task-xxx — 取消任务',
    '• /help — 显示此帮助',
    '',
    '示例:',
    '• 帮我看看项目结构',
    '• 修复 utils/format.ts 中的日期格式化 bug',
    '• /new（想聊新话题时用这个）',
  ].join('\n');
}
