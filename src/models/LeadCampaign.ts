import mongoose, { Schema, Document } from 'mongoose';

export type LeadCampaignSegment =
  | 'all_leads'
  | 'prelaunch_only'
  | 'inactive_7_days'
  | 'inactive_30_days';

export type LeadCampaignTemplate =
  | 'welcome_sequence'
  | 'prelaunch_update'
  | 'reengagement'
  | 'promotion';

export type LeadCampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';

export interface ILeadCampaign extends Document {
  name: string;
  segment: LeadCampaignSegment;
  template: LeadCampaignTemplate;
  status: LeadCampaignStatus;
  metadata?: Record<string, unknown> | null;
  scheduledAt?: Date | null;
  sentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const LeadCampaignSchema: Schema<ILeadCampaign> = new Schema({
  name: { type: String, required: true },
  segment: {
    type: String,
    enum: ['all_leads', 'prelaunch_only', 'inactive_7_days', 'inactive_30_days'],
    required: true,
    index: true
  },
  template: {
    type: String,
    enum: ['welcome_sequence', 'prelaunch_update', 'reengagement', 'promotion'],
    required: true
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'sending', 'sent', 'cancelled'],
    default: 'draft',
    index: true
  },
  metadata: { type: Schema.Types.Mixed },
  scheduledAt: { type: Date, index: true },
  sentAt: { type: Date, index: true }
}, {
  timestamps: true
});

LeadCampaignSchema.index({ segment: 1, template: 1 });

export default mongoose.model<ILeadCampaign>('LeadCampaign', LeadCampaignSchema);
