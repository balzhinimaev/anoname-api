/**
 * Модель пользователя в системе анонимного чата
 * @module models/User
 */

import mongoose, { Schema, Document } from 'mongoose';

/**
 * Интерфейс, описывающий модель пользователя
 * @interface IUser
 * @extends {Document}
 */
export interface IUser extends Document {
  /**
   * Уникальный идентификатор пользователя.
   * Для Telegram — реальный Telegram ID (положительный).
   * Для веб/VK-аккаунтов (без Telegram) — синтетический ОТРИЦАТЕЛЬНЫЙ ID,
   * чтобы не пересекаться с реальными Telegram ID и сохранить совместимость
   * с моделью Token и downstream-кодом, завязанным на telegramId.
   */
  telegramId: number;
  /** Способ аутентификации аккаунта */
  authProvider?: 'telegram' | 'web' | 'vk';
  /** Логин для входа по паролю (веб-аккаунты). Уникальный, в нижнем регистре. */
  login?: string;
  /** Bcrypt-хэш пароля (только для веб-аккаунтов) */
  passwordHash?: string;
  /** ID пользователя ВКонтакте (для аккаунтов из VK Mini App). Уникальный. */
  vkId?: number;
  /** Роль пользователя */
  role: 'user' | 'admin';
  /** A/B группа (вариант эксперимента) */
  cohort?: 'A' | 'B';
  /** Кампания/компания, из которой пришёл пользователь (например, из start payload) */
  campaign?: string;
  /** Имя пользователя в Telegram (опционально) */
  username?: string;
  /** Имя пользователя */
  firstName?: string;
  /** Фамилия пользователя */
  lastName?: string;
  /** Описание профиля пользователя */
  bio?: string;
  /** Пол пользователя */
  gender?: 'male' | 'female' | 'other';
  /** Рейтинг пользователя */
  rating: number;
  /** Предпочтения пользователя для поиска собеседников */
  preferences?: {
    /** Предпочитаемый пол собеседника */
    gender?: 'male' | 'female' | 'any';
    /** Предпочитаемый возрастной диапазон */
    ageRange?: {
      /** Минимальный возраст */
      min: number;
      /** Максимальный возраст */
      max: number;
    };
  };
  /** Возраст пользователя */
  age?: number;
  /** Массив URL фотографий пользователя */
  photos?: string[];
  /** Фото профиля (аватар) */
  profilePhoto?: string;
  /** Статус онлайн (есть ли активный сокет) */
  isOnline: boolean;
  /** Время последней активности */
  lastActive: Date;
  /** Дата создания профиля */
  createdAt: Date;
  /** Дата последнего обновления профиля */
  updatedAt: Date;
  
  // === МОНЕТИЗАЦИЯ ===
  /** Премиум статус пользователя */
  subscription?: {
    /** Тип подписки */
    type: 'basic' | 'premium' | 'gold';
    /** Дата начала подписки */
    startDate: Date;
    /** Дата окончания подписки */
    endDate: Date;
    /** Активна ли подписка */
    isActive: boolean;
    /** Автопродление */
    autoRenew: boolean;
  };
  
  /** Виртуальная валюта пользователя */
  currency?: {
    /** Количество "буостов" */
    boosts: number;
    /** Последнее пополнение бесплатной валюты */
    lastFreeRefill: Date;
  };
  
  /** Лимиты использования для базовых пользователей */
  limits?: {
    /** Количество поисков сегодня */
    searchesToday: number;
    /** Дата последнего сброса лимитов */
    lastReset: Date;
    /** Максимальное расстояние поиска (км) */
    maxSearchDistance: number;
    /** Можно ли использовать расширенные фильтры */
    canUseAdvancedFilters: boolean;
  };
  
  /** Статистика для аналитики */
  analytics?: {
    /** Общее количество матчей */
    totalMatches: number;
    /** Количество успешных разговоров */
    successfulChats: number;
    /** Средняя оценка от других пользователей */
    averageRating: number;
    /** Количество полученных оценок */
    ratingsCount: number;
    /** Популярность профиля (просмотры) */
    profileViews: number;
  };

  // === РЕФЕРАЛЫ ===
  /** Уникальный реферальный код пользователя */
  referralCode?: string;
  /** Кто пригласил этого пользователя */
  referredBy?: mongoose.Types.ObjectId;
  /** Статистика по рефералам */
  referralStats?: {
    invitedTotal: number;
    qualifiedTotal: number; // достигли целевого события (например, мэтч)
    rewardedTotal: number;  // получили награду
  };
}

/**
 * Схема пользователя для MongoDB
 * @type {Schema}
 */
const UserSchema: Schema = new Schema({
  telegramId: { type: Number, required: true, unique: true },
  authProvider: { type: String, enum: ['telegram', 'web', 'vk'], default: 'telegram' },
  login: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: { type: String },
  vkId: { type: Number, unique: true, sparse: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  cohort: { type: String, enum: ['A', 'B'], required: false },
  campaign: { type: String },
  username: { type: String },
  firstName: { type: String },
  lastName: { type: String },
  bio: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  rating: { type: Number, default: 0 },
  preferences: {
    gender: { type: String, enum: ['male', 'female', 'any'] },
    ageRange: {
      min: { type: Number, min: 18 },
      max: { type: Number, max: 100 }
    }
  },
  age: { type: Number, min: 18 },
  photos: [{ type: String }],
  profilePhoto: { type: String },
  isOnline: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  
  // === ПОЛЯ МОНЕТИЗАЦИИ ===
  subscription: {
    type: {
      type: String,
      enum: ['basic', 'premium', 'gold'],
      default: 'basic'
    },
    startDate: { type: Date },
    endDate: { type: Date },
    isActive: { type: Boolean, default: false },
    autoRenew: { type: Boolean, default: false }
  },
  
  currency: {
    boosts: { type: Number, default: 0 },
    lastFreeRefill: { type: Date, default: Date.now }
  },
  
  limits: {
    searchesToday: { type: Number, default: 0 },
    lastReset: { type: Date, default: Date.now },
    maxSearchDistance: { type: Number, default: 10 }, // 10км для базовых
    canUseAdvancedFilters: { type: Boolean, default: false }
  },
  
  analytics: {
    totalMatches: { type: Number, default: 0 },
    successfulChats: { type: Number, default: 0 },
    averageRating: { type: Number, default: 0 },
    ratingsCount: { type: Number, default: 0 },
    profileViews: { type: Number, default: 0 }
  },

  // === ПОЛЯ РЕФЕРАЛОВ ===
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referralStats: {
    invitedTotal: { type: Number, default: 0 },
    qualifiedTotal: { type: Number, default: 0 },
    rewardedTotal: { type: Number, default: 0 }
  }
}, {
  timestamps: true
});

// Статистика онлайна: countDocuments({isOnline:true[, gender]}) и TTL-свип
// {isOnline:true, lastActive:{$lte}} — без индекса были сканы всей коллекции
UserSchema.index({ isOnline: 1, gender: 1 });

export default mongoose.model<IUser>('User', UserSchema); 