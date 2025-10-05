import mongoose, { Schema, Document } from 'mongoose';

export type LeadBroadcastMethod = 'sendMessage' | 'sendWebhook';
export type LeadBroadcastStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'skipped';

export interface ILeadBroadcastLog extends Document {
  jobId: string;
  telegramId: string;
  method: LeadBroadcastMethod;
  payload: Record<string, unknown>;
  status: LeadBroadcastStatus;
  attempts: number;
  deferredCount: number;
  lastError?: string;
  responseStatus?: number;
  responseBody?: unknown;
  queuedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  nextAttemptAt?: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const LeadBroadcastLogSchema = new Schema<ILeadBroadcastLog>({
  jobId: { type: String, required: true, index: true },
  telegramId: { type: String, required: true, index: true },
  method: { type: String, enum: ['sendMessage', 'sendWebhook'], required: true, index: true },
  payload: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['queued', 'processing', 'sent', 'failed', 'skipped'], required: true, index: true },
  attempts: { type: Number, default: 0 },
  deferredCount: { type: Number, default: 0 },
  lastError: { type: String },
  responseStatus: { type: Number },
  responseBody: { type: Schema.Types.Mixed },
  queuedAt: { type: Date, default: Date.now, index: true },
  startedAt: { type: Date },
  finishedAt: { type: Date },
  nextAttemptAt: { type: Date },
  metadata: { type: Schema.Types.Mixed },
}, {
  timestamps: true,
});

LeadBroadcastLogSchema.index({ status: 1, queuedAt: 1 });
LeadBroadcastLogSchema.index({ telegramId: 1, queuedAt: -1 });

export default mongoose.model<ILeadBroadcastLog>('LeadBroadcastLog', LeadBroadcastLogSchema);

