import { getLogger } from '../utils/logger.js';

/**
 * 会话信息
 * 将飞书会话 (chatId) 映射到 cursor-agent 的 session_id
 */
export interface ISession {
  /** 飞书会话 ID */
  feishuChatId: string;
  /** cursor-agent 的 session_id */
  agentSessionId: string;
  /** 项目路径 */
  projectPath: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 对话轮次 */
  turns: number;
}

/**
 * 会话管理器
 * 维护飞书会话和 cursor-agent 会话的映射关系
 */
export class SessionStore {
  /** feishuChatId → ISession */
  private sessions = new Map<string, ISession>();
  /** 会话过期时间（默认 2 小时） */
  private expireMs: number;

  constructor(expireMs = 2 * 60 * 60 * 1000) {
    this.expireMs = expireMs;
  }

  /** 获取会话（如果存在且未过期且项目路径一致） */
  get(feishuChatId: string, projectPath: string): ISession | null {
    const session = this.sessions.get(feishuChatId);
    if (!session) return null;

    // 过期了
    if (Date.now() - session.lastActiveAt > this.expireMs) {
      const logger = getLogger();
      logger.debug({ feishuChatId, agentSessionId: session.agentSessionId }, '会话已过期，清除');
      this.sessions.delete(feishuChatId);
      return null;
    }

    // 项目路径变了，旧会话作废
    if (session.projectPath !== projectPath) {
      const logger = getLogger();
      logger.debug({ feishuChatId }, '项目路径变更，重置会话');
      this.sessions.delete(feishuChatId);
      return null;
    }

    return session;
  }

  /** 创建或更新会话 */
  set(feishuChatId: string, agentSessionId: string, projectPath: string): ISession {
    const existing = this.sessions.get(feishuChatId);
    const session: ISession = {
      feishuChatId,
      agentSessionId,
      projectPath,
      createdAt: existing?.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
      turns: (existing?.turns ?? 0) + 1,
    };
    this.sessions.set(feishuChatId, session);
    return session;
  }

  /** 更新活跃时间和轮次 */
  touch(feishuChatId: string): void {
    const session = this.sessions.get(feishuChatId);
    if (session) {
      session.lastActiveAt = Date.now();
      session.turns += 1;
    }
  }

  /** 删除会话（用于 /new 重置） */
  delete(feishuChatId: string): boolean {
    return this.sessions.delete(feishuChatId);
  }

  /** 获取会话信息（用于 /status） */
  getInfo(feishuChatId: string): string | null {
    const session = this.sessions.get(feishuChatId);
    if (!session) return null;

    const age = Math.round((Date.now() - session.createdAt) / 1000 / 60);
    return `会话: ${session.agentSessionId.slice(0, 8)}...\n轮次: ${session.turns}\n项目: ${session.projectPath}\n时长: ${age}min`;
  }
}
