import { Request, Response } from 'express';
import Chat from '../models/Chat';
import User from '../models/User';
import Message from '../models/Message';
import { ChatService } from '../services/ChatService';

export const createChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { participants } = req.body;

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
      messages: [],
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
    const { userId } = req.params;
    const chats = await Chat.find({
      participants: userId,
      isActive: true
    })
      .populate('participants', 'telegramId username firstName lastName photos')
      .populate('lastMessage');

    res.status(200).json(chats);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении чатов пользователя' });
  }
};

export const getChatMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before as string; // message ID

    // Проверяем, существует ли чат
    const chat = await Chat.findById(chatId);
    if (!chat) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }
    
    // Формируем запрос для сообщений
    const query: any = { chatId };
    if (before) {
      query._id = { $lt: before };
    }

    const messages = await Message.find(query)
      .limit(limit)
      .sort({ timestamp: -1 })
      .populate('sender', 'telegramId username firstName lastName photos');

    if (!messages) {
      res.status(404).json({ error: 'Сообщения не найдены' });
      return;
    }

    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении сообщений' });
  }
};

export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const { content, sender } = req.body;

    const message = {
      sender,
      content,
      timestamp: new Date(),
      isRead: false
    };

    const chat = await Chat.findByIdAndUpdate(
      chatId,
      {
        $push: { messages: message },
        $set: { lastMessage: message }
      },
      { new: true }
    );

    if (!chat) {
      res.status(404).json({ error: 'Чат не найден' });
      return;
    }

    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при отправке сообщения' });
  }
};

export const markMessagesAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const { userId, beforeTimestamp } = req.body;

    if (!userId || !beforeTimestamp) {
      res.status(400).json({ error: 'userId и beforeTimestamp обязательны' });
      return;
    }

    await ChatService.markAsRead(chatId, userId, new Date(beforeTimestamp));

    res.status(200).json({ message: 'Сообщения отмечены как прочитанные' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при отметке сообщений как прочитанных' });
  }
};

export const deactivateChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    
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