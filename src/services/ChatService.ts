import Chat from '../models/Chat';
import Message, { IMessage } from '../models/Message';
import { wsManager } from '../server';
import mongoose from 'mongoose';
import { wsLogger } from '../utils/logger';
import { SearchService } from './SearchService';
import { BlockService } from './BlockService';
import { gameManager } from './GameService';

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

    // Блокировки: если между участниками есть блок — запретить отправку
    const participants = chat.participants.map((p) => p.toString());
    const otherUserId = participants.find((p) => p !== userId);
    if (otherUserId) {
      const hasBlock = await BlockService.anyBlockBetween(userId, otherUserId);
      if (hasBlock) {
        throw new Error('Messaging blocked by user settings');
      }
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
    // PII: НЕ раскрываем @username и фамилию партнёра (прямой путь к деанону).
    // telegramId оставляем — фронт по нему определяет «своё» сообщение (isFromMe).
    const messageWithSender = await message.populate([
      {
        path: 'sender',
        select: 'telegramId firstName photos profilePhoto'
      },
      {
        path: 'replyTo',
        select: 'content sender timestamp',
        populate: {
          path: 'sender',
          select: 'firstName'
        }
      }
    ]);

    // 5. Отправляем полный объект сообщения всем участникам чата
    wsManager.io.to(`chat:${chatId}`).emit('chat:message', {
      chatId,
      message: messageWithSender,
    });

    // Живое сообщение перезапускает таймер тишины для авто-айсбрейкера
    wsManager.noteChatMessage(chatId, userId);

    return messageWithSender;
  }

  static async markAsRead(
    chatId: string,
    userId: string,
    beforeTimestamp: Date
  ) {
    // Авторизация: только участник чата может помечать прочтение (как в sendMessage/endChat).
    const chat = await Chat.findById(chatId).select('participants');
    if (!chat || !chat.participants.some((p) => p.toString() === userId)) {
      throw new Error('User is not a participant of this chat');
    }

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

    // Завершаем мини-игру, если была активна: освобождаем память сессии и
    // закрываем игровой оверлей у обоих игроков (иначе он «зависнет» после чата).
    try {
      gameManager.endForChat(chatId);
      wsManager.io.to(`chat:${chatId}`).emit('game:end', { reason: 'chat_ended' });
    } catch (gameCleanupError) {
      wsLogger.warn('chat_end_game_cleanup', (gameCleanupError as Error).message, { chatId });
    }

    wsLogger.info('chat_ended', `Chat ${chatId} ended by user ${userId}`, {
      reason,
    });

    // Выполняем очистку комнаты и локального состояния (для сценариев авто-таймаута тоже)
    try {
      const participants = chat.participants.map((p) => p.toString());
      wsManager.cleanupChatRoom(chatId, participants);
    } catch (cleanupError) {
      wsLogger.warn('chat_end_cleanup_service', (cleanupError as Error).message, { chatId });
    }

    // Обновляем глобальную статистику
    SearchService.broadcastSearchStats().catch(err => {
      wsLogger.warn('broadcast_stats_error', 'Failed to broadcast stats after ending chat', { error: (err as Error).message, chatId });
    });
  }
} 