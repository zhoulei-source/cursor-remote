import type { Client } from '@larksuiteoapi/node-sdk';
import { getLogger } from '../utils/logger.js';

/** 飞书消息发送封装 — 纯文本对话模式 */
export class FeishuMessenger {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /** 向指定会话发送文本消息 */
  async sendText(chatId: string, text: string): Promise<string | undefined> {
    const logger = getLogger();
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      const messageId = (res?.data?.message_id as string) ?? undefined;
      logger.debug({ chatId, messageId }, '发送消息成功');
      return messageId;
    } catch (err) {
      logger.error({ err, chatId }, '发送消息失败');
      throw err;
    }
  }

  /** 回复指定消息 */
  async replyText(messageId: string, text: string): Promise<string | undefined> {
    const logger = getLogger();
    try {
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      const replyId = (res?.data?.message_id as string) ?? undefined;
      logger.debug({ messageId, replyId }, '回复成功');
      return replyId;
    } catch (err) {
      logger.error({ err, messageId }, '回复失败');
      throw err;
    }
  }

  /** 更新已发送的文本消息内容（用于流式更新） */
  async updateMessage(messageId: string, text: string): Promise<void> {
    const logger = getLogger();
    try {
      await this.client.im.message.update({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      logger.debug({ messageId }, '更新消息成功');
    } catch (err) {
      logger.error({ err, messageId }, '更新消息失败');
      throw err;
    }
  }
}
