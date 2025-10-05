import mongoose, { Schema, Document } from 'mongoose';

export type LeadCampaignStatus = 'idle' | 'queued' | 'sent' | 'failed' | 'unsubscribed';

export interface ILead extends Document {
  telegramId: string;
  createdAt: Date;
  isRegistered: boolean;
  prelaunched?: boolean;
  viewedPrelaunchStats?: boolean;
  viewedPrelaunchStatsAt?: Date;
  tmaOpenedAt?: Date | null;
  unsubscribedAt?: Date | null;
  tmaPayload?: Record<string, unknown> | string | null;
  payload?: Record<string, unknown> | string | null;
  campaign?: string | null;
  campaignId?: mongoose.Types.ObjectId | null;
  campaignStatus: LeadCampaignStatus;
  campaignStatusUpdatedAt?: Date;
  campaignLastSentAt?: Date | null;
  campaignLastInteractionAt?: Date | null;
}

const LeadSchema: Schema<ILead> = new Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: Date.now },
  isRegistered: { type: Boolean, default: false, index: true },
  prelaunched: { type: Boolean, default: false, index: true },
  viewedPrelaunchStats: { type: Boolean, default: false, index: true },
  viewedPrelaunchStatsAt: { type: Date },
  tmaOpenedAt: { type: Date, index: true },
  unsubscribedAt: { type: Date, index: true },
  tmaPayload: { type: Schema.Types.Mixed },
  payload: { type: Schema.Types.Mixed },
  campaign: { type: String, index: true },
  campaignId: { type: Schema.Types.ObjectId, ref: 'LeadCampaign', index: true },
  campaignStatus: {
    type: String,
    enum: ['idle', 'queued', 'sent', 'failed', 'unsubscribed'],
    default: 'idle',
    index: true
  },
  campaignStatusUpdatedAt: { type: Date, default: Date.now, index: true },
  campaignLastSentAt: { type: Date, index: true },
  campaignLastInteractionAt: { type: Date, index: true }
}, {
  timestamps: false
});

export default mongoose.model<ILead>('Lead', LeadSchema);
