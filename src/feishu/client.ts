import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { IFeishuConfig } from '../config.js';
import { getLogger } from '../utils/logger.js';
import { FeishuMessenger } from './message.js';
import { parseMessageEvent } from './event-handler.js';
import type { IParsedMessage } from './event-handler.js';

export type MessageHandler = (message: IParsedMessage) => Promise<void>;

/** 飞书长连接客户端 */
export class FeishuClient {
  private config: IFeishuConfig;
  private client: Client;
  private wsClient: WSClient | null = null;
  private messenger: FeishuMessenger;
  private messageHandler: MessageHandler | null = null;

  constructor(config: IFeishuConfig) {
    this.config = config;
    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    this.messenger = new FeishuMessenger(this.client);
  }

  /** 获取消息发送器 */
  getMessenger(): FeishuMessenger {
    return this.messenger;
  }

  /** 注册消息处理回调 */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** 启动长连接 */
  async start(): Promise<void> {
    const logger = getLogger();

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        logger.debug({ data }, '收到飞书消息事件');

        const parsed = parseMessageEvent(data as Record<string, unknown>);
        if (!parsed) return;

        logger.info(
          { messageId: parsed.messageId, chatId: parsed.chatId, text: parsed.text },
          '解析消息成功'
        );

        if (this.messageHandler) {
          try {
            await this.messageHandler(parsed);
          } catch (err) {
            logger.error({ err, messageId: parsed.messageId }, '消息处理异常');
          }
        }
      },
    });

    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: 2, // WARN level
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    logger.info('飞书 WebSocket 长连接已启动');
  }

  /** 停止连接 */
  stop(): void {
    const logger = getLogger();
    // WSClient 没有暴露 stop 方法，通过进程退出来关闭
    this.wsClient = null;
    logger.info('飞书客户端已停止');
  }
}
