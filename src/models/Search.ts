import mongoose from 'mongoose';

export interface ISearch {
  _id?: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  telegramId: string;
  status: 'searching' | 'matched' | 'cancelled' | 'expired';
  
  // Данные пользователя для мэтчинга
  gender: 'male' | 'female';
  age: number;
  rating: number;

  // Критерии поиска
  desiredGender: ('male' | 'female' | 'any')[];
  desiredAgeMin: number;
  desiredAgeMax: number;
  minAcceptableRating: number;
  useGeolocation: boolean;
  location?: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  maxDistance?: number; // в километрах
  // Премиум-признак на момент начала поиска (снимок для приоритезации очереди)
  isPremium?: boolean;
  isBoosted?: boolean;
  // Платформа на момент поиска (для сквозной аналитики): telegram | web | vk
  platform?: string;

  // Результат мэтчинга
  matchedWith?: {
    userId: mongoose.Types.ObjectId;
    telegramId: string;
    chatId?: mongoose.Types.ObjectId;
  };

  createdAt: Date;
  updatedAt: Date;
}

const searchSchema = new mongoose.Schema<ISearch>({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  telegramId: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['searching', 'matched', 'cancelled', 'expired'],
    default: 'searching'
  },
  
  // Данные пользователя
  gender: {
    type: String,
    enum: ['male', 'female'],
    required: true
  },
  age: {
    type: Number,
    required: true,
    min: 18,
    max: 100
  },
  rating: {
    type: Number,
    required: true,
    default: 0
  },

  // Критерии поиска
  desiredGender: [{
    type: String,
    enum: ['male', 'female', 'any']
  }],
  desiredAgeMin: {
    type: Number,
    required: true,
    min: 18,
    max: 100
  },
  desiredAgeMax: {
    type: Number,
    required: true,
    min: 18,
    max: 100
  },
  minAcceptableRating: {
    type: Number,
    default: -1 // -1 означает "любой рейтинг"
  },
  useGeolocation: {
    type: Boolean,
    default: false
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: false
    },
    coordinates: {
      type: [Number],
      required: false
    }
  },
  maxDistance: {
    type: Number,
    min: 1,
    max: 100, // максимум 100 км
    default: 10
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  isBoosted: {
    type: Boolean,
    default: false
  },
  platform: {
    type: String
  },

  matchedWith: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    telegramId: String,
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat'
    }
  }
}, {
  timestamps: true
});

// Индексы
searchSchema.index({ userId: 1 });
searchSchema.index({ telegramId: 1 });
searchSchema.index({ status: 1 });
searchSchema.index({ gender: 1 });
searchSchema.index({ age: 1 });
searchSchema.index({ rating: 1 });
// Гео-индекс для поиска по координатам
searchSchema.index({ location: '2dsphere' });
// Приоритезация очереди: сначала буст, затем премиум, затем старшие по времени
searchSchema.index({ isBoosted: -1, isPremium: -1, createdAt: 1 });
// Единственный активный поиск на пользователя
searchSchema.index(
  { userId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'searching' } }
);

// Автоматическое истечение поиска через 30 минут
searchSchema.index({ createdAt: 1 }, { expireAfterSeconds: 1800 });

export default mongoose.model<ISearch>('Search', searchSchema); 