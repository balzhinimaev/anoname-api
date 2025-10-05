import mongoose, { FilterQuery } from 'mongoose';

import LeadCampaign, {
  ILeadCampaign,
  LeadCampaignSegment,
  LeadCampaignStatus,
  LeadCampaignTemplate,
} from '../models/LeadCampaign';
import Lead, { ILead } from '../models/Lead';
import { LeadBroadcastService } from './LeadBroadcastService';
import logger from '../utils/logger';
import { metricsCollector } from '../utils/metrics';

type CampaignInput = {
  name: string;
  segment: LeadCampaignSegment;
  template: LeadCampaignTemplate;
  metadata?: Record<string, unknown> | null;
};

export interface LaunchOptions {
  dryRun?: boolean;
}

export interface LaunchResult {
  campaign: ILeadCampaign;
  matched: number;
  queued: number;
  failed: number;
  failedLeads: Array<{ leadId: string; telegramId: string; error: string }>;
}

export class LeadCampaignService {
  static async list(page = 1, limit = 25): Promise<{ total: number; items: ILeadCampaign[] }> {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safePage = Math.max(1, page);

    const [total, items] = await Promise.all([
      LeadCampaign.countDocuments({}),
      LeadCampaign.find({})
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit),
    ]);

    return { total, items };
  }

  static async getById(id: string): Promise<ILeadCampaign | null> {
    if (!mongoose.isValidObjectId(id)) {
      return null;
    }
    return LeadCampaign.findById(id);
  }

  static async create(payload: CampaignInput): Promise<ILeadCampaign> {
    const created = await LeadCampaign.create({
      name: payload.name,
      segment: payload.segment,
      template: payload.template,
      metadata: payload.metadata ?? null,
    });
    return created;
  }

  static async update(id: string, payload: Partial<CampaignInput> & { status?: LeadCampaignStatus | null; scheduledAt?: Date | null; sentAt?: Date | null; }): Promise<ILeadCampaign | null> {
    if (!mongoose.isValidObjectId(id)) {
      return null;
    }

    const updatePayload: Record<string, unknown> = {};
    if (payload.name !== undefined) updatePayload.name = payload.name;
    if (payload.segment !== undefined) updatePayload.segment = payload.segment;
    if (payload.template !== undefined) updatePayload.template = payload.template;
    if (payload.metadata !== undefined) updatePayload.metadata = payload.metadata ?? null;
    if (payload.status !== undefined) updatePayload.status = payload.status;
    if (payload.scheduledAt !== undefined) updatePayload.scheduledAt = payload.scheduledAt;
    if (payload.sentAt !== undefined) updatePayload.sentAt = payload.sentAt;

    if (Object.keys(updatePayload).length === 0) {
      return LeadCampaign.findById(id);
    }

    return LeadCampaign.findByIdAndUpdate(id, updatePayload, { new: true });
  }

  static async remove(id: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) {
      return false;
    }
    const result = await LeadCampaign.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  static async countSegmentLeads(segment: LeadCampaignSegment): Promise<number> {
    const filter = this.buildSegmentFilter(segment);
    return Lead.countDocuments(filter);
  }

  static async previewSegment(segment: LeadCampaignSegment, limit = 25): Promise<{ total: number; samples: Array<Pick<ILead, 'telegramId' | 'isRegistered' | 'tmaOpenedAt' | 'unsubscribedAt'>> }>
  {
    const filter = this.buildSegmentFilter(segment);
    const [total, samples] = await Promise.all([
      Lead.countDocuments(filter),
      Lead.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(100, Math.max(1, limit)))
        .select('telegramId isRegistered tmaOpenedAt unsubscribedAt')
        .lean(),
    ]);

    return { total, samples };
  }

  static async previewCampaign(id: string, limit = 25): Promise<{ campaign: ILeadCampaign; total: number; samples: Array<Pick<ILead, 'telegramId' | 'isRegistered' | 'tmaOpenedAt' | 'unsubscribedAt'>> } | null> {
    const campaign = await this.getById(id);
    if (!campaign) {
      return null;
    }
    const preview = await this.previewSegment(campaign.segment, limit);
    return {
      campaign,
      total: preview.total,
      samples: preview.samples,
    };
  }

  static async launchCampaign(id: string, options: LaunchOptions = {}): Promise<LaunchResult> {
    if (!mongoose.isValidObjectId(id)) {
      logger.warn('lead_campaign_launch_invalid_id', { campaignId: id });
      throw new Error('Campaign not found');
    }

    const campaign = await LeadCampaign.findById(id);
    if (!campaign) {
      logger.warn('lead_campaign_launch_not_found', { campaignId: id });
      throw new Error('Campaign not found');
    }

    if (campaign.status === 'sending') {
      logger.warn('lead_campaign_launch_already_in_progress', { campaignId: id });
      throw new Error('Campaign is already in progress');
    }

    const isDryRun = Boolean(options.dryRun);
    logger.info('lead_campaign_launch_attempt', {
      campaignId: id,
      dryRun: isDryRun,
      segment: campaign.segment,
      template: campaign.template,
    });

    const filter = this.buildSegmentFilter(campaign.segment);
    const leads = await Lead.find(filter)
      .select('_id telegramId')
      .lean();

    const matched = leads.length;

    metricsCollector.leadCampaignLaunchStarted(isDryRun);

    if (options.dryRun) {
      logger.info('lead_campaign_launch_dry_run', {
        campaignId: id,
        matched,
      });
      return {
        campaign,
        matched,
        queued: 0,
        failed: 0,
        failedLeads: [],
      };
    }

    const now = new Date();
    campaign.status = 'sending';
    campaign.scheduledAt = now;
    campaign.sentAt = null;
    await campaign.save();

    if (matched === 0) {
      campaign.status = 'sent';
      campaign.sentAt = now;
      await campaign.save();
      logger.info('lead_campaign_launch_no_matches', {
        campaignId: id,
      });
      return {
        campaign,
        matched,
        queued: 0,
        failed: 0,
        failedLeads: [],
      };
    }

    const leadIds = leads.map((lead) => lead._id);
    if (leadIds.length > 0) {
      await Lead.updateMany(
        { _id: { $in: leadIds } },
        {
          $set: {
            campaignId: campaign._id,
            campaignStatus: 'queued',
            campaignStatusUpdatedAt: now,
          },
        },
      );
    }

    const broadcastService = LeadBroadcastService.getInstance();
    const failedLeads: Array<{ leadId: string; telegramId: string; error: string }> = [];
    let queued = 0;

    for (const lead of leads) {
      try {
        await broadcastService.enqueueWebhook(lead.telegramId, {
          type: 'lead_campaign',
          campaignId: String(campaign._id),
          template: campaign.template,
          name: campaign.name,
          metadata: campaign.metadata ?? {},
        });
        queued += 1;
        metricsCollector.leadCampaignMessageQueued(true);
        logger.debug('lead_campaign_enqueue_success', {
          campaignId: id,
          leadId: lead._id,
          telegramId: lead.telegramId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        failedLeads.push({ leadId: String(lead._id), telegramId: lead.telegramId, error: message });
        metricsCollector.leadCampaignMessageQueued(false);
        logger.error('lead_campaign_enqueue_failed', {
          campaignId: id,
          leadId: lead._id,
          telegramId: lead.telegramId,
          error: message,
        });
      }
    }

    if (failedLeads.length > 0) {
      const failedIds = failedLeads
        .map((item) => {
          try {
            return new mongoose.Types.ObjectId(item.leadId);
          } catch {
            return null;
          }
        })
        .filter((value): value is mongoose.Types.ObjectId => Boolean(value));

      if (failedIds.length > 0) {
        await Lead.updateMany(
          { _id: { $in: failedIds } },
          {
            $set: {
              campaignStatus: 'failed',
              campaignStatusUpdatedAt: new Date(),
            },
          },
        );
      }
    }

    campaign.status = queued > 0 ? 'sent' : 'cancelled';
    campaign.sentAt = queued > 0 ? new Date() : null;
    await campaign.save();

    logger.info('lead_campaign_launch_completed', {
      campaignId: id,
      matched,
      queued,
      failed: failedLeads.length,
    });

    return {
      campaign,
      matched,
      queued,
      failed: failedLeads.length,
      failedLeads,
    };
  }

  private static buildSegmentFilter(segment: LeadCampaignSegment): FilterQuery<ILead> {
    const baseFilter: FilterQuery<ILead> = {
      $or: [
        { unsubscribedAt: { $exists: false } },
        { unsubscribedAt: null },
      ],
      campaignStatus: { $ne: 'unsubscribed' },
    };

    const segmentsAllowingRegistered: LeadCampaignSegment[] = ['all_leads'];
    const restrictToUnregistered = !segmentsAllowingRegistered.includes(segment);

    const withRegistrationFilter = restrictToUnregistered
      ? { ...baseFilter, isRegistered: false }
      : baseFilter;

    switch (segment) {
      case 'all_leads':
        return withRegistrationFilter;
      case 'prelaunch_only':
        return withRegistrationFilter;
      case 'inactive_7_days':
        return {
          ...withRegistrationFilter,
          $and: [
            {
              $or: [
                { tmaOpenedAt: { $exists: false } },
                { tmaOpenedAt: null },
                { tmaOpenedAt: { $lt: this.daysAgo(7) } },
              ],
            },
            {
              $or: [
                { campaignLastInteractionAt: { $exists: false } },
                { campaignLastInteractionAt: null },
                { campaignLastInteractionAt: { $lt: this.daysAgo(7) } },
              ],
            },
          ],
        };
      case 'inactive_30_days':
        return {
          ...withRegistrationFilter,
          $and: [
            {
              $or: [
                { tmaOpenedAt: { $exists: false } },
                { tmaOpenedAt: null },
                { tmaOpenedAt: { $lt: this.daysAgo(30) } },
              ],
            },
            {
              $or: [
                { campaignLastInteractionAt: { $exists: false } },
                { campaignLastInteractionAt: null },
                { campaignLastInteractionAt: { $lt: this.daysAgo(30) } },
              ],
            },
          ],
        };
      default:
        return withRegistrationFilter;
    }
  }

  private static daysAgo(days: number): Date {
    const now = new Date();
    now.setUTCDate(now.getUTCDate() - days);
    return now;
  }
}

export default LeadCampaignService;
