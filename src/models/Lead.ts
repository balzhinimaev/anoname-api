import mongoose, { Schema, Document } from 'mongoose';

export interface ILead extends Document {
  telegramId: string;
  createdAt: Date;
  isRegistered: boolean;
  prelaunched?: boolean;
  viewedPrelaunchStats?: boolean;
  viewedPrelaunchStatsAt?: Date;
}

const LeadSchema: Schema<ILead> = new Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: Date.now },
  isRegistered: { type: Boolean, default: false, index: true },
  prelaunched: { type: Boolean, default: false, index: true },
  viewedPrelaunchStats: { type: Boolean, default: false, index: true },
  viewedPrelaunchStatsAt: { type: Date }
}, {
  timestamps: false
});

export default mongoose.model<ILead>('Lead', LeadSchema);
