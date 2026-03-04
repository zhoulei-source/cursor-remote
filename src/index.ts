import { loadConfig, saveAllowedUserId } from './config.js';
import { nanoid } from 'nanoid';
import { createLogger, getLogger } from './utils/logger.js';
import { FeishuClient } from './feishu/client.js';
import { parseCommand, getHelpMessage } from './feishu/event-handler.js';
import type { IParsedMessage } from './feishu/event-handler.js';
import { TaskManager } from './task/manager.js';
import { CursorAgentExecutor } from './executor/cursor-agent.js';
import { StreamReporter } from './executor/reporter.js';
import { SessionStore } from './session/store.js';
import { existsSync } from 'fs';

async function main(): Promise<void> {
  const config = loadConfig();

  createLogger(config.log.level);
  const logger = getLogger();

  logger.info('========================================');
  logger.info('  Cursor Remote 启动中...');
  logger.info('========================================');
  logger.info({ cursorAgent: config.cursor.agentPath }, 'Cursor Agent 路径');
  logger.info({ defaultProject: config.cursor.defaultProjectPath }, '默认项目路径');

  // 初始化各模块
  const feishuClient = new FeishuClient(config.feishu);
  const messenger = feishuClient.getMessenger();
  const reporter = new StreamReporter(messenger, config.stream.pushInterval);
  const sessionStore = new SessionStore();
  const executor = new CursorAgentExecutor(config.cursor);

  // 任务管理器
  const taskManager = new TaskManager({
    onStart: async (task) => reporter.onTaskStart(task),
    onOutput: async (task, chunk) => reporter.onOutput(task, chunk),
    onComplete: async (task) => reporter.onTaskComplete(task),
    onError: async (task, error) => reporter.onTaskError(task, error),
    onCancelled: async (task) => reporter.onTaskCancelled(task),
  });

  // 注册执行器 — 带 session 恢复
  taskManager.setExecutor(async (task) => {
    const projectPath = task.projectPath;
    const feishuChatId = task.source.chatId;

    // 查找已有的 session
    const existingSession = sessionStore.get(feishuChatId, projectPath);
    const resumeSessionId = existingSession?.agentSessionId;

    if (resumeSessionId) {
      logger.info(
        { feishuChatId, resumeSessionId, turns: existingSession.turns },
        '恢复已有会话'
      );
    } else {
      logger.info({ feishuChatId }, '创建新会话');
    }

    // 执行，拿到 session_id
    const result = await executor.execute(
      task,
      {
        onOutput: async (t, chunk) => reporter.onOutput(t, chunk),
        onComplete: async (t) => reporter.onTaskComplete(t),
        onError: async (t, err) => reporter.onTaskError(t, err),
      },
      resumeSessionId
    );

    // 保存 session_id 映射
    if (result.sessionId) {
      sessionStore.set(feishuChatId, result.sessionId, projectPath);
      logger.debug(
        { feishuChatId, agentSessionId: result.sessionId },
        '会话已保存'
      );
    }
  });

  // 用户鉴权
  const allowedUserIds = new Set(config.security.allowedUserIds);
  let pairingCode: string | null = null;

  if (allowedUserIds.size > 0) {
    logger.info({ allowedUserIds: [...allowedUserIds] }, '已启用用户白名单');
  } else {
    pairingCode = nanoid(6).toUpperCase();
    logger.info('========================================');
    logger.info(`  配对码: ${pairingCode}`);
    logger.info('  在飞书中发送此配对码完成身份绑定');
    logger.info('========================================');
  }

  feishuClient.onMessage(async (message: IParsedMessage) => {
    logger.info(
      { senderId: message.senderId, chatId: message.chatId, text: message.text.slice(0, 100) },
      '收到消息'
    );

    // 配对模式：验证配对码并绑定用户
    if (pairingCode && message.text.trim() === pairingCode) {
      allowedUserIds.add(message.senderId);
      pairingCode = null;
      try {
        saveAllowedUserId(message.senderId);
        logger.info({ senderId: message.senderId }, '用户配对成功，已写入配置');
        await messenger.replyText(message.messageId, `✅ 配对成功！已绑定你的身份，只有你可以使用此机器人。`);
      } catch (err) {
        logger.error({ err }, '保存配对信息失败');
        await messenger.replyText(message.messageId, '配对成功，但写入配置文件失败，请手动配置 ALLOWED_USER_IDS');
      }
      return;
    }

    // 白名单校验
    if (allowedUserIds.size > 0 && !allowedUserIds.has(message.senderId)) {
      logger.warn({ senderId: message.senderId }, '未授权用户，已忽略');
      return;
    }

    const command = parseCommand(message.text);

    switch (command.type) {
      case 'help': {
        await messenger.replyText(message.messageId, getHelpMessage());
        break;
      }

      case 'new': {
        const deleted = sessionStore.delete(message.chatId);
        await messenger.replyText(
          message.messageId,
          deleted ? '已开启新会话，之前的上下文已清除。' : '当前没有活跃会话，直接发消息即可开始。'
        );
        break;
      }

      case 'run': {
        const projectPath = command.projectPath ?? config.cursor.defaultProjectPath;
        const prompt = command.prompt ?? '';

        if (!existsSync(projectPath)) {
          await messenger.replyText(message.messageId, `路径不存在: ${projectPath}`);
          return;
        }

        if (!prompt) {
          await messenger.replyText(message.messageId, '请输入任务描述');
          return;
        }

        // 新消息到达，自动取消同一会话中正在执行/排队的旧任务
        const runningTaskId = taskManager.cancelChatTasks(message.chatId);
        if (runningTaskId && executor.activeTaskId === runningTaskId) {
          executor.killActive();
          logger.info({ chatId: message.chatId, cancelledTaskId: runningTaskId }, '新消息到达，已终止旧任务');
        }

        await taskManager.createTask(
          {
            messageId: message.messageId,
            chatId: message.chatId,
            chatType: message.chatType,
            senderId: message.senderId,
          },
          projectPath,
          prompt
        );
        break;
      }

      case 'status': {
        const sessionInfo = sessionStore.getInfo(message.chatId);
        const task = command.taskId
          ? taskManager.getTask(command.taskId)
          : taskManager.getRecentTask();

        const parts: string[] = [];

        if (sessionInfo) {
          parts.push(sessionInfo);
        } else {
          parts.push('当前无活跃会话');
        }

        if (task) {
          const duration = task.finishedAt
            ? task.finishedAt - (task.startedAt ?? task.createdAt)
            : task.startedAt
              ? Date.now() - task.startedAt
              : 0;
          parts.push(`\n最近任务: ${task.status}${duration > 0 ? ` (${(duration / 1000).toFixed(1)}s)` : ''}`);
        }

        await messenger.replyText(message.messageId, parts.join('\n'));
        break;
      }

      case 'cancel': {
        if (!command.taskId) {
          await messenger.replyText(message.messageId, '用法: /cancel task-xxxx');
          return;
        }

        const cancelled = taskManager.cancelTask(command.taskId);
        if (cancelled && executor.activeTaskId === command.taskId) {
          executor.killActive();
        }

        await messenger.replyText(
          message.messageId,
          cancelled ? '已取消' : '无法取消（可能已完成或不存在）'
        );
        break;
      }

      default: {
        await messenger.replyText(message.messageId, '发送 /help 查看帮助');
      }
    }
  });

  // 启动
  await feishuClient.start();
  logger.info('Cursor Remote 已就绪，等待消息...');

  // 优雅退出
  const gracefulShutdown = (signal: string) => {
    logger.info({ signal }, '收到退出信号，正在关闭...');
    reporter.cleanup();
    executor.killActive();
    feishuClient.stop();
    logger.info('已安全退出');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '未捕获的异常');
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '未处理的 Promise 拒绝');
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
