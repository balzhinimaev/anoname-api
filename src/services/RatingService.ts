import mongoose from 'mongoose';
import Rating, { IRating } from '../models/Rating';
import Chat from '../models/Chat';
import User from '../models/User';
import { wsManager } from '../server';
import { wsLogger } from '../utils/logger';
import { GamificationService } from './GamificationService';

export class RatingService {
  /**
   * Создает новую оценку для пользователя
   */
  static async rateUser(
    chatId: string,
    raterUserId: string,
    score: number,
    comment?: string
  ): Promise<IRating> {
    // Находим чат и проверяем, что он существует
    const chat = await Chat.findById(chatId);
    if (!chat) {
      throw new Error('Chat not found');
    }

    // Проверяем, что пользователь является участником чата
    if (!chat.participants.some(p => p.toString() === raterUserId)) {
      throw new Error('User is not a participant of this chat');
    }

    // Находим ID пользователя, которого оценивают (другой участник чата)
    const ratedUserId = chat.participants.find(p => p.toString() !== raterUserId);
    if (!ratedUserId) {
      throw new Error('Rated user not found in chat');
    }

    // Проверяем, не оценивал ли уже этот пользователь этот чат
    const existingRating = await Rating.findOne({
      chatId: new mongoose.Types.ObjectId(chatId),
      raterUserId: new mongoose.Types.ObjectId(raterUserId)
    });

    if (existingRating) {
      throw new Error('User has already rated this chat');
    }

    // Получаем Telegram ID пользователей
    const [rater, rated] = await Promise.all([
      User.findById(raterUserId),
      User.findById(ratedUserId)
    ]);

    if (!rater || !rated) {
      throw new Error('User not found');
    }

    // Создаем новую оценку
    const rating = await Rating.create({
      ratedUserId: ratedUserId,
      ratedTelegramId: rated.telegramId,
      raterUserId: new mongoose.Types.ObjectId(raterUserId),
      raterTelegramId: rater.telegramId,
      chatId: new mongoose.Types.ObjectId(chatId),
      score,
      comment
    });

    // Обновляем средний рейтинг оцененного пользователя
    await this.updateUserRating(ratedUserId.toString());

    // Геймификация: полученная пятёрка — XP и вехи «любимца»
    if (score === 5) {
      GamificationService.award(ratedUserId.toString(), 'five_star').catch(() => {});
    }

    // Отправляем уведомление о новой оценке
    wsManager.sendToUser(ratedUserId.toString(), 'chat:rated', {
      chatId,
      ratedBy: raterUserId,
      score
    });

    wsLogger.info('chat_rated', `Chat ${chatId} rated by user ${raterUserId}`, {
      score,
      ratedUserId: ratedUserId.toString()
    });

    return rating;
  }

  /**
   * Обновляет средний рейтинг пользователя
   */
  private static async updateUserRating(userId: string): Promise<void> {
    const ratings = await Rating.find({ ratedUserId: new mongoose.Types.ObjectId(userId) });
    
    if (ratings.length > 0) {
      const averageRating = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
      const rounded = Number(averageRating.toFixed(2));
      await User.findByIdAndUpdate(userId, {
        $set: { rating: rounded }
      });
    }
  }
} 