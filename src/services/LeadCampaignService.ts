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
import config from '../config';

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

type BroadcastMessageOptions = Parameters<LeadBroadcastService['enqueueMessage']>[2];

type CampaignMessage = {
  text: string;
  options?: BroadcastMessageOptions;
};

interface CampaignTemplateMetadata {
  text?: unknown;
  headline?: unknown;
  body?: unknown;
  valueProp?: unknown;
  socialProof?: unknown;
  points?: unknown;
  ctaText?: unknown;
  ctaUrl?: unknown;
  campaignCode?: unknown;
  disableLinkPreview?: unknown;
}

type TemplateDefaults = {
  headline: (campaign: ILeadCampaign) => string;
  body: string;
  valueProp: string;
  socialProof: string;
  ctaText: string;
};

const DEFAULT_TEMPLATE_CONTENT: Record<LeadCampaignTemplate, TemplateDefaults> = {
  welcome_sequence: {
    headline: (campaign) => `Привет! 👋 Мы подготовили кампанию «${campaign.name}».`,
    body: 'Спасибо, что присоединились — рассказываем, что вас ждёт внутри.',
    valueProp: 'Завершите регистрацию и получите персональные рекомендации.',
    socialProof: '⚡️ Уже сотни участников нашли здесь пару — присоединяйтесь!',
    ctaText: 'Открыть в приложении',
  },
  prelaunch_update: {
    headline: () => 'Апдейт по запуску 🚀',
    body: 'Мы почти готовы открыть доступ и хотим поделиться новостями.',
    valueProp: 'Первые пользователи смогут попасть внутрь без очереди.',
    socialProof: 'Станьте одним из первых и получите бонусы на старте.',
    ctaText: 'Проверить статус',
  },
  reengagement: {
    headline: () => 'Мы скучаем! 🙌',
    body: 'Похоже, вы давно не заглядывали — за это время появилось много нового.',
    valueProp: 'Вернитесь и посмотрите, кто уже готов познакомиться.',
    socialProof: 'Каждую неделю добавляются сотни новых профилей.',
    ctaText: 'Вернуться сейчас',
  },
  promotion: {
    headline: () => 'Специальное предложение только для вас 🎁',
    body: 'Мы подготовили персональную акцию с ограниченным сроком действия.',
    valueProp: 'Активируйте предложение и получите дополнительные привилегии.',
    socialProof: 'Предложение действует для ограниченного числа участников.',
    ctaText: 'Забрать бонус',
  },
};

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
        const message = this.buildCampaignMessage(campaign, lead);
        await broadcastService.enqueueMessage(lead.telegramId, message.text, message.options);
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

  private static buildCampaignMessage(campaign: ILeadCampaign, lead: Pick<ILead, 'telegramId'>): CampaignMessage {
    const metadata = ((campaign.metadata ?? {}) as CampaignTemplateMetadata) || {};
    const defaults = DEFAULT_TEMPLATE_CONTENT[campaign.template];

    const pickString = (value: unknown): string | undefined => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const baseSections: string[] = [];
    const explicitText = pickString(metadata.text);

    if (!explicitText) {
      const headline = pickString(metadata.headline) ?? defaults.headline(campaign);
      const body = pickString(metadata.body) ?? defaults.body;
      const valueProp = pickString(metadata.valueProp) ?? defaults.valueProp;
      const socialProof = pickString(metadata.socialProof) ?? defaults.socialProof;

      const sections = [headline, body, valueProp, socialProof].filter((section): section is string => Boolean(section));
      baseSections.push(...sections);

      const pointsRaw = metadata.points;
      if (Array.isArray(pointsRaw)) {
        const bulletLines = pointsRaw
          .map((point) => pickString(point))
          .filter((point): point is string => Boolean(point));
        if (bulletLines.length > 0) {
          baseSections.push(bulletLines.map((line) => `• ${line}`).join('\n'));
        }
      }
    }

    let text = explicitText ?? baseSections.join('\n\n');

    const rawCtaText = pickString(metadata.ctaText) ?? defaults.ctaText;
    const normalizedCtaText = rawCtaText.trim();

    const resolvedCampaignCode = this.normalizeCampaignCode(pickString(metadata.campaignCode))
      ?? this.slugifyCampaignName(campaign.name)
      ?? String(campaign._id);

    const ctaUrl = pickString(metadata.ctaUrl) ?? this.buildDeepLink(resolvedCampaignCode, lead.telegramId);

    if (ctaUrl || normalizedCtaText) {
      const label = normalizedCtaText || 'Открыть';
      const ctaLine = ctaUrl ? `👉 ${label}: ${ctaUrl}` : `👉 ${label}`;
      text = text ? `${text}\n\n${ctaLine}` : ctaLine;
    }

    const cleanedText = text.trim();
    if (!cleanedText) {
      throw new Error('Failed to build campaign message: empty text');
    }

    const disableLinkPreviewMetadata = typeof metadata.disableLinkPreview === 'boolean' ? metadata.disableLinkPreview : undefined;
    const shouldDisableLinkPreview = disableLinkPreviewMetadata ?? Boolean(ctaUrl);

    const options: BroadcastMessageOptions = {};
    if (shouldDisableLinkPreview) {
      options.disableLinkPreview = true;
    }

    if (ctaUrl && normalizedCtaText) {
      options.extra = {
        ...(options.extra ?? {}),
        reply_markup: {
          inline_keyboard: [[{ text: normalizedCtaText, url: ctaUrl }]],
        },
      };
    } else if (ctaUrl) {
      const fallbackLabel = 'Открыть';
      options.extra = {
        ...(options.extra ?? {}),
        reply_markup: {
          inline_keyboard: [[{ text: fallbackLabel, url: ctaUrl }]],
        },
      };
    }

    return {
      text: cleanedText,
      options: Object.keys(options).length > 0 ? options : undefined,
    };
  }

  private static buildDeepLink(campaignCode: string | undefined, telegramId: string): string | undefined {
    const botUsername = config.botUsername?.trim();
    if (!botUsername) {
      return undefined;
    }
    if (!campaignCode) {
      return undefined;
    }
    const normalizedUsername = botUsername.replace(/^@+/, '');
    return `https://t.me/${normalizedUsername}?startapp=lead_${campaignCode}_${telegramId}`;
  }

  private static normalizeCampaignCode(raw: string | undefined): string | undefined {
    if (!raw) {
      return undefined;
    }
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return sanitized.length > 0 ? sanitized : undefined;
  }

  private static slugifyCampaignName(name: string | undefined): string | undefined {
    if (!name) {
      return undefined;
    }
    const slug = name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
      .slice(0, 64);
    return slug.length > 0 ? slug : undefined;
  }

  private static buildSegmentFilter(segment: LeadCampaignSegment): FilterQuery<ILead> {
    const baseFilter: FilterQuery<ILead> = {
      $or: [
        { unsubscribedAt: { $exists: false } },
        { unsubscribedAt: null },
      ],
      campaignStatus: { $ne: 'unsubscribed' },
    };

    const segmentsAllowingRegistered: LeadCampaignSegment[] = [
      // Add registered-only segments here once they are available.
    ];
    const restrictToUnregistered = !segmentsAllowingRegistered.includes(segment);

    const withRegistrationFilter = restrictToUnregistered
      ? { ...baseFilter, isRegistered: false }
      : baseFilter;

    switch (segment) {
      case 'all_leads':
        return withRegistrationFilter;
      case 'prelaunch_only':
        // Только лиды из предстартовой очереди (раньше сегмент был no-op = all_leads)
        return { ...withRegistrationFilter, prelaunched: true };
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
