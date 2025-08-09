import Chat from '../models/Chat';
import Message, { IMessage } from '../models/Message';
import { wsManager } from '../server';
import mongoose from 'mongoose';
import { wsLogger } from '../utils/logger';
import { SearchService } from './SearchService';

export class ChatService {
  static async sendMessage(
    chatId: string,
    userId: string,
    content: string,
    replyTo?: string
  ): Promise<IMessage> {
    const chat = await Chat.findById(chatId);
    if (!chat) {
      throw new Error('Chat not found');
    }

    if (!chat.participants.some((p) => p.toString() === userId)) {
      throw new Error('User is not a participant of this chat');
    }

    // 1. Проверяем, если это ответ на сообщение
    if (replyTo) {
      const replyMessage = await Message.findById(replyTo);
      if (!replyMessage) {
        throw new Error('Reply message not found');
      }
      
      // Проверяем, что оригинальное сообщение из того же чата
      if (replyMessage.chatId.toString() !== chatId) {
        throw new Error('Reply message is not from the same chat');
      }
    }

    // 2. Создаем сообщение как отдельный документ
    const message = await Message.create({
      chatId: new mongoose.Types.ObjectId(chatId),
      sender: new mongoose.Types.ObjectId(userId),
      content,
      replyTo: replyTo ? new mongoose.Types.ObjectId(replyTo) : undefined,
    });

    // 3. Обновляем lastMessage в чате
    chat.lastMessage = message._id as mongoose.Types.ObjectId;
    await chat.save();
    
    // 4. Загружаем информацию об отправителе и сообщении-ответе для отправки клиенту
    const messageWithSender = await message.populate([
      {
        path: 'sender',
        select: 'telegramId username firstName lastName photos'
      },
      {
        path: 'replyTo',
        select: 'content sender timestamp',
        populate: {
          path: 'sender',
          select: 'telegramId username firstName lastName'
        }
      }
    ]);

    // 5. Отправляем полный объект сообщения всем участникам чата
    wsManager.io.to(`chat:${chatId}`).emit('chat:message', {
      chatId,
      message: messageWithSender,
    });

    return messageWithSender;
  }

  static async markAsRead(
    chatId: string,
    userId: string,
    beforeTimestamp: Date
  ) {
    // Находим все непрочитанные сообщения в чате, отправленные другими пользователями
    // и полученные до указанной временной метки.
    await Message.updateMany(
      {
        chatId: new mongoose.Types.ObjectId(chatId),
        sender: { $ne: new mongoose.Types.ObjectId(userId) },
        timestamp: { $lte: beforeTimestamp },
        isRead: false,
      },
      {
        $set: { isRead: true },
        $addToSet: { readBy: new mongoose.Types.ObjectId(userId) },
      }
    );

    // Уведомляем других участников, что сообщения были прочитаны
    wsManager.io.to(`chat:${chatId}`).emit('chat:read', {
      chatId,
      userId,
      timestamp: beforeTimestamp,
    });
  }

  static async endChat(
    chatId: string,
    userId: string,
    reason?: string
  ): Promise<void> {
    const chat = await Chat.findById(chatId);
    if (!chat) {
      throw new Error('Chat not found');
    }

    if (!chat.participants.some((p) => p.toString() === userId)) {
      throw new Error('User is not a participant of this chat');
    }

    // Проверяем, не завершен ли уже чат
    if (!chat.isActive) {
      throw new Error('Chat is already ended');
    }

    // Обновляем статус чата
    chat.isActive = false;
    chat.endedAt = new Date();
    chat.endedBy = new mongoose.Types.ObjectId(userId);
    chat.endReason = reason;
    await chat.save();

    // Уведомляем всех участников о завершении чата
    wsManager.io.to(`chat:${chatId}`).emit('chat:ended', {
      chatId,
      endedBy: userId,
      reason,
    });

    wsLogger.info('chat_ended', `Chat ${chatId} ended by user ${userId}`, {
      reason,
    });

    // Обновляем глобальную статистику
    SearchService.broadcastSearchStats().catch(err => {
      wsLogger.warn('broadcast_stats_error', 'Failed to broadcast stats after ending chat', { error: (err as Error).message, chatId });
    });
  }
} 