import mongoose from 'mongoose';

/**
 * Web Push подписка браузера (одна на устройство/браузер; у юзера их может
 * быть несколько). Мёртвые подписки (404/410 от пуш-сервиса) удаляются при
 * отправке.
 */
export interface IPushSubscription {
  userId: mongoose.Types.ObjectId;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const pushSubscriptionSchema = new mongoose.Schema<IPushSubscription>({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  userAgent: { type: String }
}, {
  timestamps: true
});

export default mongoose.model<IPushSubscription>('PushSubscription', pushSubscriptionSchema);
