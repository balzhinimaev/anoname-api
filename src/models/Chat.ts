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
  /** Канонизированный первый участник (минимальный ID) */
  userA?: mongoose.Types.ObjectId;
  /** Канонизированный второй участник (максимальный ID) */
  userB?: mongoose.Types.ObjectId;
  /** Последнее сообщение в чате */
  lastMessage?: mongoose.Types.ObjectId;
  /** Тип чата: анонимный или постоянный */
  type: 'anonymous' | 'permanent';
  /** Статус активности чата */
  isActive: boolean;
  /** Пользователи, сохранившие завершённый чат */
  savedBy?: mongoose.Types.ObjectId[];
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
  userA: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  userB: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
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
  savedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: []
  }],
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
chatSchema.index({ savedBy: 1 });
// Для поиска истории сообщений с сортировкой по времени
// Индексы на Message добавлены в самой модели Message
// Гарантия единственного активного чата между парой пользователей
chatSchema.index(
  { userA: 1, userB: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

// Ранее здесь был TTL-индекс по expiresAt для автоудаления анонимных чатов.
// Убран, чтобы история переписки не удалялась автоматически.

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
  // Канонизируем пару
  if (Array.isArray(this.participants) && this.participants.length >= 2) {
    try {
      const a = this.participants[0];
      const b = this.participants[1];
      if (a && b) {
        const [minId, maxId] = [a.toString(), b.toString()].sort();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).userA = new mongoose.Types.ObjectId(minId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).userB = new mongoose.Types.ObjectId(maxId);
      }
    } catch {}
  }
  next();
});

export default mongoose.model<IChat, ChatModel>('Chat', chatSchema); 