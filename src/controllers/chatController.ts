import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Chat from '../models/Chat';
import User from '../models/User';
import Message from '../models/Message';
import Rating from '../models/Rating';
import { ChatService } from '../services/ChatService';

// Безопасная проекция участника чата: только неидентифицирующие поля.
// НИКОГДА не отдаём telegramId/username/lastName/passwordHash собеседнику
// в анонимном чате (иначе деанон). _id включается populate по умолчанию.
const PUBLIC_PARTICIPANT_FIELDS = 'firstName profilePhoto photos gender age rating isOnline';

export const createChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { participants, type } = req.body;
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    // Разрешаем создавать чат только если текущий пользователь входит в список участников
    if (!Array.isArray(participants) || !participants.some((p: string) => String(p) === authUserId)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Проверяем существование пользователей
    const users = await User.find({ _id: { $in: participants } });
    if (users.length !== participants.length) {
      res.status(400).json({ error: 'Один или несколько пользователей не найдены' });
      return;
    }

    // Проверяем, существует ли уже чат между этими пользователями
    const existingChat = await Chat.findOne({
      participants: { $all: participants },
      isActive: true
    });

    if (existingChat) {
      res.status(200).json(existingChat);
      return;
    }

    const chat = new Chat({
      participants,
      type: type === 'permanent' ? 'permanent' : 'anonymous',
      isActive: true
    });

    await chat.save();
    res.status(201).json(chat);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании чата' });
  }
};

export const getUserChats = async (req: Request, res: Response): Promise<void> => {
  try {
    // Разрешаем получать список только для себя
    const paramUserId = req.params.userId;
    const authUserId = req.user?.userId;
    if (!authUserId || paramUserId !== authUserId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    // По умолчанию показываем активные чаты. Завершённые — только если пользователь их сохранил.
    const chats = await Chat.find({
      $or: [
        { participants: authUserId, isActive: true },
        { participants: authUserId, isActive: false, savedBy: authUserId },
      ]
    })
      .populate('participants', PUBLIC_PARTICIPANT_FIELDS)
      .populate('lastMessage');

    res.status(200).json(chats);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении чатов пользователя' });
  }
};

export const getChatMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const before = req.query.before as string; // message ID или ISO дата
    const after = req.query.after as string;   // message ID или ISO дата (для получения пропущенных сообщений)

    // Проверяем, существует ли чат
    const chat = await Chat.findById(chatId);
    if (!chat) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }
    // Проверяем, что пользователь — участник чата
    const isParticipant = chat.participants.some((p) => p.toString() === authUserId);
    const isSavedViewer = !chat.isActive && chat.savedBy?.some((p) => p.toString() === authUserId);
    if (!isParticipant && !isSavedViewer) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    
    // Формируем запрос для сообщений
    const query: any = { chatId };
    const looksLikeObjectId = (val: string) => /^[a-f\d]{24}$/i.test(val);

    if (before && after) {
      // Если переданы оба — приоритетнее after (синхронизация пропусков)
      // но добавим guard, чтобы не получить противоречивый запрос
    }

    if (after) {
      if (looksLikeObjectId(after)) {
        query._id = { $gt: after };
      } else {
        const asDate = new Date(after);
        if (!isNaN(asDate.getTime())) {
          query.timestamp = { $gt: asDate };
        }
      }
    } else if (before) {
      if (looksLikeObjectId(before)) {
        query._id = { $lt: before };
      } else {
        const asDate = new Date(before);
        if (!isNaN(asDate.getTime())) {
          query.timestamp = { $lt: asDate };
        }
      }
    }

    const sortDirection = after ? 1 : -1; // новые вверх по умолчанию, но для after — от старых к новым
    const messages = await Message.find(query)
      .limit(limit)
      .sort({ timestamp: sortDirection })
      .populate('sender', PUBLIC_PARTICIPANT_FIELDS);

    if (!messages) {
      res.status(404).json({ error: 'Сообщения не найдены' });
      return;
    }

    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении сообщений' });
  }
};

// Сохранить завершённый чат для текущего пользователя
export const saveChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    const chat = await Chat.findById(chatId).select('participants isActive savedBy');
    if (!chat) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }

    const isParticipant = chat.participants.some((p) => p.toString() === authUserId);
    if (!isParticipant) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Разрешаем сохранять как активный, так и завершённый чат — чтобы пользователь мог закрепить диалог
    await Chat.findByIdAndUpdate(chatId, { $addToSet: { savedBy: authUserId } }, { new: true });
    res.status(200).json({ message: 'Чат сохранён' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при сохранении чата' });
  }
};

// Убрать сохранение чата для текущего пользователя
export const unsaveChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    const chat = await Chat.findById(chatId).select('participants savedBy');
    if (!chat) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }

    const isParticipant = chat.participants.some((p) => p.toString() === authUserId);
    if (!isParticipant) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await Chat.findByIdAndUpdate(chatId, { $pull: { savedBy: authUserId } }, { new: true });
    res.status(200).json({ message: 'Чат удалён из сохранённых' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении из сохранённых' });
  }
};

// Получить список сохранённых чатов пользователя (включая завершённые)
export const getSavedChats = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    const chats = await Chat.find({ savedBy: authUserId })
      .populate('participants', PUBLIC_PARTICIPANT_FIELDS)
      .populate('lastMessage');

    res.status(200).json(chats);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении сохранённых чатов' });
  }
};

export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const { content, replyTo } = req.body;
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: 'Сообщение не может быть пустым' });
      return;
    }
    if (content.length > 2000) {
      res.status(400).json({ error: 'Слишком длинное сообщение' });
      return;
    }

    // Проверяем, что пользователь является участником чата
    const chat = await Chat.findById(chatId).select('participants isActive');
    if (!chat || !chat.isActive) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }
    const isParticipant = chat.participants.some((p) => p.toString() === authUserId);
    if (!isParticipant) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const created = await ChatService.sendMessage(chatId, authUserId, content, replyTo);
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при отправке сообщения' });
  }
};

export const markMessagesAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const { beforeTimestamp } = req.body;
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    if (!beforeTimestamp) {
      res.status(400).json({ error: 'userId и beforeTimestamp обязательны' });
      return;
    }

    // Проверяем участие
    const chat = await Chat.findById(chatId).select('participants isActive');
    if (!chat || !chat.isActive) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }
    const isParticipant = chat.participants.some((p) => p.toString() === authUserId);
    if (!isParticipant) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await ChatService.markAsRead(chatId, authUserId, new Date(beforeTimestamp));

    res.status(200).json({ message: 'Сообщения отмечены как прочитанные' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при отметке сообщений как прочитанных' });
  }
};

export const deactivateChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }
    const chatFound = await Chat.findById(chatId).select('participants isActive');
    if (!chatFound) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }
    const isParticipant = chatFound.participants.some((p) => p.toString() === authUserId);
    if (!isParticipant) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    
    const chat = await Chat.findByIdAndUpdate(
      chatId,
      { $set: { isActive: false } },
      { new: true }
    );

    if (!chat) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }

    res.status(200).json(chat);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при деактивации чата' });
  }
}; 

// История всех чатов пользователя с агрегированной статистикой
export const getUserChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const authUserId = req.user?.userId;
    if (!authUserId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    // Пагинация
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    // Счётчики для пагинации и сводки
    const totalChats = await Chat.countDocuments({ participants: authUserId });

    // Если нет чатов — быстрый ответ
    if (totalChats === 0) {
      res.status(200).json({
        summary: {
          totalChats: 0,
          totalMessages: 0,
          firstMessageAt: null,
          lastMessageAt: null
        },
        chats: [],
        pagination: { page, limit, totalChats, totalPages: 0 }
      });
      return;
    }
    // Страница чатов, в которых пользователь был участником (активные и завершённые)
    const chatsPage = await Chat.find({ participants: authUserId })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('participants', PUBLIC_PARTICIPANT_FIELDS)
      .populate('lastMessage');

    const pageChatIds = chatsPage.map((c) => c._id);

    // Агрегируем сообщения по чатам (только для текущей страницы)
    const msgAggPage = await Message.aggregate<{
      _id: mongoose.Types.ObjectId;
      messagesCount: number;
      firstMessageAt: Date;
      lastMessageAt: Date;
    }>([
      { $match: { chatId: { $in: pageChatIds } } },
      {
        $group: {
          _id: '$chatId',
          messagesCount: { $sum: 1 },
          firstMessageAt: { $min: '$timestamp' },
          lastMessageAt: { $max: '$timestamp' }
        }
      }
    ]);

    const pageByChatId = new Map<string, { messagesCount: number; firstMessageAt?: Date; lastMessageAt?: Date }>();
    msgAggPage.forEach((row) => {
      pageByChatId.set(row._id.toString(), {
        messagesCount: row.messagesCount,
        firstMessageAt: row.firstMessageAt,
        lastMessageAt: row.lastMessageAt
      });
    });

    // Рейтинги по чатам текущей страницы
    const userObjectId = new mongoose.Types.ObjectId(authUserId);
    const ratingsPage = await Rating.find({
      chatId: { $in: pageChatIds },
      $or: [
        { raterUserId: userObjectId },
        { ratedUserId: userObjectId }
      ]
    }).select('chatId raterUserId ratedUserId score comment createdAt');

    const ratingByChat: Record<string, { myRatingGiven?: any; myRatingReceived?: any }> = {};
    ratingsPage.forEach((r) => {
      const key = r.chatId.toString();
      if (!ratingByChat[key]) ratingByChat[key] = {};
      if ((r.raterUserId as unknown as mongoose.Types.ObjectId).toString() === authUserId) {
        ratingByChat[key].myRatingGiven = {
          score: r.score,
          comment: r.comment,
          createdAt: r.createdAt
        };
      }
      if ((r.ratedUserId as unknown as mongoose.Types.ObjectId).toString() === authUserId) {
        ratingByChat[key].myRatingReceived = {
          score: r.score,
          comment: r.comment,
          createdAt: r.createdAt
        };
      }
    });

    // Сводка по всем чатам пользователя (глобальная): totalMessages/первое/последнее
    // Получаем только IDs всех чатов пользователя для аккуратного match
    // Глобальную сводку убрали по требованиям приватности; считаем только текущую страницу

    const result = chatsPage.map((chat) => {
      const stats = pageByChatId.get(chat._id.toString());
      const messagesCount = stats?.messagesCount ?? 0;
      const firstMessageAt = stats?.firstMessageAt ?? null;
      const lastMessageAt = stats?.lastMessageAt ?? null;
      const ratingInfo = ratingByChat[chat._id.toString()] || {};

      return {
        chatId: chat._id,
        type: chat.type,
        isActive: chat.isActive,
        createdAt: chat.createdAt,
        endedAt: chat.endedAt ?? null,
        participants: chat.participants,
        messagesCount,
        firstMessageAt,
        lastMessageAt,
        myRatingGiven: ratingInfo.myRatingGiven || null,
        myRatingReceived: ratingInfo.myRatingReceived || null
      };
    });

    res.status(200).json({
      chats: result,
      pagination: {
        page,
        limit,
        total: totalChats,
        pages: Math.ceil(totalChats / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении истории чатов' });
  }
};