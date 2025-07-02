import mongoose from 'mongoose';

export interface IToken {
  token: string;
  userId: mongoose.Types.ObjectId;
  telegramId: string;
  isValid: boolean;
  expiresAt: Date;
  lastUsedAt: Date;
  userAgent?: string;
  ipAddress?: string;
  deviceId?: string; // Идентификатор устройства/сессии
  platform: string; // telegram, web, mobile и т.д.
}

interface TokenModel extends mongoose.Model<IToken> {
  cleanupExpiredTokens(): Promise<number>;
  deactivateOldTokens(telegramId: string, platform: string): Promise<number>;
}

const tokenSchema = new mongoose.Schema<IToken>({
  token: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  telegramId: {
    type: String,
    required: true
  },
  isValid: {
    type: Boolean,
    default: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  lastUsedAt: {
    type: Date,
    default: Date.now
  },
  userAgent: String,
  ipAddress: String,
  deviceId: String,
  platform: {
    type: String,
    required: true,
    enum: ['telegram', 'web', 'mobile'],
    default: 'telegram'
  }
}, {
  timestamps: true
});

// Индексы для быстрого поиска
tokenSchema.index({ userId: 1 });
tokenSchema.index({ telegramId: 1 });
tokenSchema.index({ expiresAt: 1 });
tokenSchema.index({ platform: 1 });
tokenSchema.index({ deviceId: 1 });

// Статический метод для очистки устаревших токенов
tokenSchema.statics.cleanupExpiredTokens = async function() {
  const now = new Date();
  const result = await this.deleteMany({
    $or: [
      { expiresAt: { $lt: now } },  // Удаляем истекшие токены
      { isValid: false }  // Удаляем невалидные токены
    ]
  });
  return result.deletedCount;
};

// Метод для деактивации старых токенов пользователя на определенной платформе
tokenSchema.statics.deactivateOldTokens = async function(telegramId: string, platform: string) {
  const result = await this.updateMany(
    { 
      telegramId,
      platform,
      isValid: true
    },
    { 
      $set: { 
        isValid: false,
        lastUsedAt: new Date()
      }
    }
  );
  return result.modifiedCount;
};

const Token = mongoose.model<IToken, TokenModel>('Token', tokenSchema);

export default Token; 