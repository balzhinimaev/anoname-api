import mongoose, { Document, Schema } from 'mongoose';

export interface IAnalyticsEvent extends Document {
  userId?: mongoose.Types.ObjectId;
  telegramId?: string;
  cohort?: 'A' | 'B';
  name: string;
  props?: Record<string, any>;
  deviceId?: string;
  platform?: string; // telegram, web, mobile
  userAgent?: string;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AnalyticsEventSchema: Schema = new Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  telegramId: { type: String, index: true },
  cohort: { type: String, enum: ['A', 'B'], index: true },
  name: { type: String, required: true, index: true },
  props: { type: Schema.Types.Mixed },
  deviceId: { type: String },
  platform: { type: String },
  userAgent: { type: String },
  ip: { type: String }
}, {
  timestamps: true
});

// Частые запросы: по пользователю/событию/дате
AnalyticsEventSchema.index({ userId: 1, name: 1, createdAt: -1 });
AnalyticsEventSchema.index({ cohort: 1, name: 1, createdAt: -1 });
AnalyticsEventSchema.index({ createdAt: -1 });

// TTL по окружению (в днях)
const ttlDays = Number(process.env.ANALYTICS_TTL_DAYS || 0);
if (ttlDays > 0) {
  AnalyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 });
}

export default mongoose.model<IAnalyticsEvent>('AnalyticsEvent', AnalyticsEventSchema);


