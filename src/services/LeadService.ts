import mongoose, { PipelineStage } from 'mongoose';
import Lead, { ILead } from '../models/Lead';
import User from '../models/User';
import { TelegramNotificationService } from './TelegramNotificationService';
import logger from '../utils/logger';
import { metricsCollector } from '../utils/metrics';

const { Types } = mongoose;

export interface LeadCampaignConversionStats {
  campaign: string | null;
  campaignId: string | null;
  leads: number;
  tmaOpens: number;
  registrations: number;
  conversionToTmaOpen: number;
  conversionToRegistration: number;
}

export class LeadService {
  static async addLead(telegramId: string): Promise<{ added: boolean; isNew: boolean }> {
    try {
      logger.info('lead_add_attempt', { telegramId });
      const existingLead = await Lead.findOne({ telegramId });

      if (existingLead) {
        metricsCollector.leadAddDuplicate();
        logger.info('lead_add_duplicate', { telegramId });
        return { added: false, isNew: false };
      }

      // Check if user already exists in User collection
      const existingUser = await User.findOne({ telegramId: Number(telegramId) });
      const isRegistered = !!existingUser;

      const lead = await Lead.create({
        telegramId,
        createdAt: new Date(),
        isRegistered
      });

      metricsCollector.leadAddCreated();
      logger.info('lead_add_success', { telegramId, leadId: lead._id, isRegistered });

      // Send notification to Telegram channel
      try {
        await TelegramNotificationService.sendLeadNotification({
          telegramId,
          isRegistered,
          createdAt: lead.createdAt
        });
        metricsCollector.leadNotificationSent();
        logger.info('lead_notification_sent', { telegramId, leadId: lead._id });
      } catch (notificationError) {
        // Log error but don't fail the lead creation
        metricsCollector.leadNotificationFailed();
        logger.error('lead_notification_error', {
          telegramId,
          leadId: lead._id,
          error: notificationError instanceof Error ? notificationError.message : String(notificationError)
        });
      }

      return { added: true, isNew: true };
    } catch (error) {
      metricsCollector.leadAddFailed();
      logger.error('lead_add_error', {
        telegramId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error('Failed to add lead');
    }
  }

  static async getCount(): Promise<number> {
    const count = await Lead.countDocuments();
    return count;
  }

  static async getStats(): Promise<{
    total: number;
    registered: number;
    unregistered: number;
    campaignStats: LeadCampaignConversionStats[];
  }> {
    const [total, registered, campaignStats] = await Promise.all([
      Lead.countDocuments(),
      Lead.countDocuments({ isRegistered: true }),
      this.getCampaignConversionStats()
    ]);

    return {
      total,
      registered,
      unregistered: total - registered,
      campaignStats
    };
  }

  static async markAsRegistered(telegramId: string): Promise<boolean> {
    try {
      const now = new Date();
      const result = await Lead.updateOne(
        { telegramId },
        {
          $set: {
            isRegistered: true,
            campaignStatus: 'unsubscribed',
            campaignStatusUpdatedAt: now,
            unsubscribedAt: now,
          },
        }
      );
      const success = result.modifiedCount > 0;
      metricsCollector.leadRegistered(success);
      if (success) {
        logger.info('lead_mark_registered_success', { telegramId });
      } else {
        logger.debug('lead_mark_registered_noop', { telegramId });
      }
      return success;
    } catch (error) {
      metricsCollector.leadRegistered(false);
      logger.error('lead_mark_registered_error', {
        telegramId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  static async assignCampaign(
    telegramId: string,
    campaign?: string | null,
    campaignId?: string | null
  ): Promise<void> {
    const update: Record<string, unknown> = {};

    if (campaign && campaign.trim() !== '') {
      update.campaign = campaign.trim();
    }

    const normalizedCampaignId = this.normalizeCampaignId(campaignId);
    if (normalizedCampaignId) {
      update.campaignId = normalizedCampaignId;
    }

    if (Object.keys(update).length === 0) {
      return;
    }

    await Lead.updateOne({ telegramId }, { $set: update });
    logger.info('lead_assign_campaign', {
      telegramId,
      campaign: update.campaign ?? null,
      campaignId: update.campaignId ? String(update.campaignId) : null
    });
  }

  static extractCampaignFromPayload(payload: unknown): {
    campaign?: string;
    campaignId?: string;
  } {
    if (!payload) {
      return {};
    }

    if (typeof payload === 'object') {
      const payloadObj = payload as Record<string, unknown>;
      const candidateCampaign = typeof payloadObj.campaign === 'string'
        ? payloadObj.campaign
        : typeof payloadObj.campaignCode === 'string'
          ? payloadObj.campaignCode
          : undefined;
      const candidateCampaignId = typeof payloadObj.campaignId === 'string'
        ? payloadObj.campaignId
        : typeof (payloadObj as Record<string, unknown>)['campaign_id'] === 'string'
          ? String((payloadObj as Record<string, unknown>)['campaign_id'])
          : undefined;
      return {
        campaign: candidateCampaign,
        campaignId: candidateCampaignId
      };
    }

    if (typeof payload !== 'string') {
      return {};
    }

    let raw = payload.trim();
    if (!raw) {
      return {};
    }

    try {
      raw = decodeURIComponent(raw);
    } catch {}

    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return this.extractCampaignFromPayload(parsed as Record<string, unknown>);
        }
      } catch {}
    }

    const startAppMatch = raw.match(/startapp=([^&]+)/i);
    if (startAppMatch) {
      raw = startAppMatch[1];
    }

    const leadIndex = raw.toLowerCase().indexOf('lead');
    if (leadIndex >= 0) {
      raw = raw.slice(leadIndex);
    }

    if (raw.toLowerCase().startsWith('lead')) {
      raw = raw.replace(/^lead[:_\-]?/i, '');
    }

    const parts = raw.split(/[_:\-]/).filter(Boolean);
    if (parts.length === 0) {
      return {};
    }

    const candidate = parts[0]?.trim();
    return {
      campaign: candidate || undefined,
      campaignId: candidate || undefined
    };
  }

  static async recordTmaOpen(params: {
    telegramId: string;
    payload?: unknown;
    campaign?: string | null;
    campaignId?: string | null;
  }): Promise<{ lead: ILead; created: boolean }> {
    const telegramId = params.telegramId.trim();
    if (!telegramId) {
      logger.warn('lead_tma_open_missing_telegram_id');
      metricsCollector.leadTmaOpenFailed();
      throw new Error('telegramId is required');
    }

    const { payload } = params;
    const fromPayload = this.extractCampaignFromPayload(payload);
    const campaign = (params.campaign || fromPayload.campaign || null)?.trim() || null;
    const campaignId = params.campaignId || fromPayload.campaignId || null;
    const normalizedCampaignId = this.normalizeCampaignId(campaignId);

    logger.info('lead_tma_open_attempt', {
      telegramId,
      campaign,
      campaignId: normalizedCampaignId ? String(normalizedCampaignId) : null
    });

    try {
      const update: Record<string, unknown> = {
        tmaOpenedAt: new Date(),
        tmaPayload: payload ?? null,
        payload: payload ?? null,
        campaignLastInteractionAt: new Date()
      };

      if (campaign) {
        update.campaign = campaign;
      }
      if (normalizedCampaignId) {
        update.campaignId = normalizedCampaignId;
      }

      const existingLead = await Lead.findOneAndUpdate(
        { telegramId },
        { $set: update },
        { new: true }
      );

      if (existingLead) {
        metricsCollector.leadTmaOpened(false);
        logger.info('lead_tma_open_updated', {
          telegramId,
          leadId: existingLead._id,
          campaign: update.campaign ?? null,
          campaignId: normalizedCampaignId ? String(normalizedCampaignId) : null
        });
        return { lead: existingLead, created: false };
      }

      const lead = await Lead.create({
        telegramId,
        createdAt: new Date(),
        isRegistered: false,
        tmaOpenedAt: update.tmaOpenedAt,
        tmaPayload: update.tmaPayload,
        payload: update.payload,
        campaign: campaign ?? undefined,
        campaignId: normalizedCampaignId ?? undefined,
        campaignLastInteractionAt: update.campaignLastInteractionAt
      });

      metricsCollector.leadAddCreated();
      metricsCollector.leadTmaOpened(true);
      logger.info('lead_tma_open_created', {
        telegramId,
        leadId: lead._id,
        campaign: campaign ?? null,
        campaignId: normalizedCampaignId ? String(normalizedCampaignId) : null
      });

      return { lead, created: true };
    } catch (error) {
      metricsCollector.leadTmaOpenFailed();
      logger.error('lead_tma_open_error', {
        telegramId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  static async getCampaignConversionStats(): Promise<LeadCampaignConversionStats[]> {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          $or: [
            { campaign: { $exists: true, $nin: [null, ''] } },
            { campaignId: { $exists: true, $ne: null } }
          ]
        }
      },
      {
        $group: {
          _id: {
            campaign: '$campaign',
            campaignId: '$campaignId'
          },
          leads: { $sum: 1 },
          tmaOpens: {
            $sum: {
              $cond: [{ $gt: ['$tmaOpenedAt', null] }, 1, 0]
            }
          },
          registrations: {
            $sum: {
              $cond: [{ $eq: ['$isRegistered', true] }, 1, 0]
            }
          }
        }
      },
      {
        $sort: { leads: -1 }
      }
    ];

    const rawStats = await Lead.aggregate(pipeline);

    return rawStats.map((item: any) => {
      const leads: number = item.leads ?? 0;
      const tmaOpens: number = item.tmaOpens ?? 0;
      const registrations: number = item.registrations ?? 0;

      const conversionToTmaOpen = leads > 0 ? tmaOpens / leads : 0;
      const conversionToRegistration = leads > 0 ? registrations / leads : 0;

      const campaignIdValue = item._id?.campaignId ? String(item._id.campaignId) : null;
      const campaignValue = item._id?.campaign ?? null;

      return {
        campaign: campaignValue,
        campaignId: campaignIdValue,
        leads,
        tmaOpens,
        registrations,
        conversionToTmaOpen,
        conversionToRegistration
      } as LeadCampaignConversionStats;
    });
  }

  static async markViewedPrelaunchStats(telegramId: string): Promise<{ updated: boolean; isNew: boolean }> {
    try {
      const existingLead = await Lead.findOne({ telegramId });

      if (existingLead) {
        // Update existing lead
        const result = await Lead.updateOne(
          { telegramId },
          { 
            $set: { 
              viewedPrelaunchStats: true,
              viewedPrelaunchStatsAt: new Date()
            } 
          }
        );
        return { updated: result.modifiedCount > 0, isNew: false };
      } else {
        // Create new lead with viewed stats
        await Lead.create({
          telegramId,
          createdAt: new Date(),
          isRegistered: false,
          viewedPrelaunchStats: true,
          viewedPrelaunchStatsAt: new Date()
        });
        return { updated: true, isNew: true };
      }
    } catch (error) {
      throw new Error('Failed to mark viewed prelaunch stats');
    }
  }

  private static normalizeCampaignId(campaignId?: string | null): mongoose.Types.ObjectId | null {
    if (!campaignId || typeof campaignId !== 'string') {
      return null;
    }

    const trimmed = campaignId.trim();
    if (!trimmed) {
      return null;
    }

    if (!Types.ObjectId.isValid(trimmed)) {
      return null;
    }

    return new Types.ObjectId(trimmed);
  }
}
