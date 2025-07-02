/**
 * Модель чата в системе анонимного общения
 * @module models/Chat
 */

import mongoose from 'mongoose';

/**
 * Интерфейс чата
 * @interface IChat
 */
export interface IChat {
  /** Массив ID участников чата */
  participants: mongoose.Types.ObjectId[];
  /** Последнее сообщение в чате */
  lastMessage?: mongoose.Types.ObjectId;
  /** Тип чата: анонимный или постоянный */
  type: 'anonymous' | 'permanent';
  /** Статус активности чата */
  isActive: boolean;
  /** Время истечения анонимного чата */
  expiresAt?: Date;
  /** Время создания чата */
  createdAt: Date;
  /** Время последнего обновления чата */
  updatedAt: Date;
  /** Время завершения чата */
  endedAt?: Date;
  /** Пользователь, завершивший чат */
  endedBy?: mongoose.Types.ObjectId;
  /** Причина завершения чата */
  endReason?: string;
}

/**
 * Схема чата для MongoDB
 * @type {mongoose.Schema}
 */
const chatSchema = new mongoose.Schema<IChat>({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  type: {
    type: String,
    enum: ['anonymous', 'permanent'],
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  expiresAt: {
    type: Date
  },
  endedAt: {
    type: Date
  },
  endedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  endReason: {
    type: String
  }
}, {
  timestamps: true
});

// Индексы для оптимизации запросов
chatSchema.index({ participants: 1 });
chatSchema.index({ isActive: 1 });
chatSchema.index({ type: 1 });

/**
 * TTL индекс для автоматического удаления анонимных чатов по истечении срока
 */
chatSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

/**
 * Проверяет, является ли пользователь участником чата
 * @param {mongoose.Types.ObjectId} userId - ID пользователя
 * @returns {boolean} true если пользователь является участником чата
 */
chatSchema.methods.isParticipant = function(userId: mongoose.Types.ObjectId): boolean {
  return this.participants.some((participantId: mongoose.Types.ObjectId) => 
    participantId.equals(userId)
  );
};

/**
 * Расширение модели чата статическими методами
 * @interface ChatModel
 * @extends {mongoose.Model<IChat>}
 */
interface ChatModel extends mongoose.Model<IChat> {
  /**
   * Находит все активные чаты пользователя
   * @param {mongoose.Types.ObjectId} userId - ID пользователя
   * @returns {Promise<IChat[]>} Массив активных чатов
   */
  findActiveChatsForUser(userId: mongoose.Types.ObjectId): Promise<IChat[]>;
}

chatSchema.statics.findActiveChatsForUser = async function(userId: mongoose.Types.ObjectId) {
  return this.find({
    participants: userId,
    isActive: true
  }).sort({ updatedAt: -1 });
};

/**
 * Middleware для автоматической установки времени истечения анонимных чатов
 */
chatSchema.pre('save', function(next) {
  if (this.isNew && this.type === 'anonymous') {
    // Анонимный чат истекает через 24 часа
    this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
  next();
});

export default mongoose.model<IChat, ChatModel>('Chat', chatSchema); 