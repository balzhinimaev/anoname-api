import { Request, Response } from 'express';
import mongoose from 'mongoose';
import User from '../models/User';
import Prelaunch from '../models/Prelaunch';
import Lead from '../models/Lead';
import { LeadService } from '../services/LeadService';
import LeadCampaignService from '../services/LeadCampaignService';

export const searchUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const q = (req.query.query as string | undefined)?.trim();
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '20', 10)));

    const filter: any = {};
    if (q && q.length > 0) {
      // Экранируем regex-метасимволы — иначе catastrophic backtracking (ReDoS) по всей коллекции.
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const or: any[] = [
        { username: { $regex: safe, $options: 'i' } },
        { firstName: { $regex: safe, $options: 'i' } },
        { lastName: { $regex: safe, $options: 'i' } },
      ];
      if (/^\d+$/.test(q)) {
        or.push({ telegramId: Number(q) });
      }
      filter.$or = or;
    }

    const [total, items] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('telegramId username firstName lastName age gender rating role isOnline lastActive createdAt')
        .lean(),
    ]);

    res.json({
      items,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось выполнить поиск пользователей' });
  }
};

export const getUserById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    let user = null as any;

    if (mongoose.isValidObjectId(id)) {
      user = await User.findById(id).lean();
    } else if (/^\d+$/.test(id)) {
      user = await User.findOne({ telegramId: Number(id) }).lean();
    } else {
      res.status(400).json({ error: 'Некорректный формат идентификатора' });
      return;
    }

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить пользователя' });
  }
};

export const getPrelaunchStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const total = await Prelaunch.countDocuments({});
    res.json({ total });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось получить статистику предстартовой очереди' });
  }
};

export const getPrelaunchList = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || '100'), 10)));
    const sort = String(req.query.sort || 'desc'); // 'asc' | 'desc' по joinedAt

    const [total, items] = await Promise.all([
      Prelaunch.countDocuments({}),
      Prelaunch.find({})
        .sort({ joinedAt: sort === 'asc' ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items
    });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось получить список предстартовой очереди' });
  }
};

export const exportPrelaunchCsv = async (_req: Request, res: Response): Promise<void> => {
  try {
    const items = await Prelaunch.find({}).sort({ joinedAt: 1 }).lean();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prelaunch_export.csv"');
    const header = 'telegramId,userId,joinedAt\n';
    const rows = items.map((i: any) => `${i.telegramId},${i.userId},${new Date(i.joinedAt).toISOString()}`).join('\n');
    res.send(header + rows + (rows ? '\n' : ''));
  } catch (e) {
    res.status(500).json({ error: 'Не удалось экспортировать CSV' });
  }
};

export const getLeadStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats = await LeadService.getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Не удалось получить статистику лидов' });
  }
};

export const getLeadList = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || '100'), 10)));
    const sort = String(req.query.sort || 'desc'); // 'asc' | 'desc' по createdAt

    const [total, items] = await Promise.all([
      Lead.countDocuments({}),
      Lead.find({})
        .sort({ createdAt: sort === 'asc' ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items
    });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось получить список лидов' });
  }
};

export const exportLeadCsv = async (_req: Request, res: Response): Promise<void> => {
  try {
    const items = await Lead.find({}).sort({ createdAt: 1 }).lean();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_export.csv"');
    const header = 'telegramId,createdAt,isRegistered\n';
    const rows = items.map((i: any) => `${i.telegramId},${new Date(i.createdAt).toISOString()},${i.isRegistered}`).join('\n');
    res.send(header + rows + (rows ? '\n' : ''));
  } catch (e) {
    res.status(500).json({ error: 'Не удалось экспортировать CSV лидов' });
  }
};

export const listLeadCampaigns = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10)));
    const { total, items } = await LeadCampaignService.list(page, limit);
    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items,
    });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить кампании лидов' });
  }
};

export const createLeadCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, segment, template, metadata } = req.body || {};
    if (!name || !segment || !template) {
      res.status(400).json({ error: 'name, segment и template обязательны' });
      return;
    }

    const campaign = await LeadCampaignService.create({ name, segment, template, metadata });
    const segmentTotal = await LeadCampaignService.countSegmentLeads(segment);

    res.status(201).json({ campaign, segmentTotal });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось создать кампанию' });
  }
};

export const getLeadCampaignById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaign = await LeadCampaignService.getById(id);
    if (!campaign) {
      res.status(404).json({ error: 'Кампания не найдена' });
      return;
    }
    const segmentTotal = await LeadCampaignService.countSegmentLeads(campaign.segment);
    res.json({ campaign, segmentTotal });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить кампанию' });
  }
};

export const updateLeadCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, segment, template, metadata, status, scheduledAt, sentAt } = req.body || {};
    const campaign = await LeadCampaignService.update(id, { name, segment, template, metadata, status, scheduledAt, sentAt });
    if (!campaign) {
      res.status(404).json({ error: 'Кампания не найдена' });
      return;
    }
    const segmentTotal = await LeadCampaignService.countSegmentLeads(campaign.segment);
    res.json({ campaign, segmentTotal });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось обновить кампанию' });
  }
};

export const deleteLeadCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const deleted = await LeadCampaignService.remove(id);
    if (!deleted) {
      res.status(404).json({ error: 'Кампания не найдена' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось удалить кампанию' });
  }
};

export const previewLeadCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10)));
    const preview = await LeadCampaignService.previewCampaign(id, limit);
    if (!preview) {
      res.status(404).json({ error: 'Кампания не найдена' });
      return;
    }
    res.json(preview);
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить предварительный просмотр кампании' });
  }
};

export const launchLeadCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const dryRunRaw = req.body?.dryRun ?? req.query?.dryRun ?? false;
    const dryRun = String(dryRunRaw).toLowerCase() === 'true';
    const result = await LeadCampaignService.launchCampaign(id, { dryRun });
    res.json(result);
  } catch (error: any) {
    if (error?.message === 'Campaign not found') {
      res.status(404).json({ error: 'Кампания не найдена' });
      return;
    }
    res.status(500).json({ error: 'Не удалось запустить кампанию' });
  }
};



/**
 * Сводка по монетизации: выручка, платежи, конверсия в платящих.
 * GET /api/admin/monetization/stats?days=30
 */
export const getMonetizationStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.days || '30'), 10)));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const PaymentLog = (await import('../models/Payment')).default;

    const [byStatus, revenueByDay, byItem, totalUsers, premiumActive, payingUsers] = await Promise.all([
      PaymentLog.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      PaymentLog.aggregate([
        { $match: { status: 'applied', createdAt: { $gte: since }, 'payload.test': { $ne: true } } },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: { $toDouble: { $ifNull: ['$payload.amount.value', '0'] } } },
          payments: { $sum: 1 }
        } },
        { $sort: { _id: 1 } }
      ]),
      PaymentLog.aggregate([
        { $match: { status: 'applied', createdAt: { $gte: since } } },
        { $group: { _id: '$itemKey', count: { $sum: 1 } } }
      ]),
      User.countDocuments({}),
      User.countDocuments({ 'subscription.isActive': true, 'subscription.type': { $ne: 'basic' } }),
      PaymentLog.distinct('userId', { status: 'applied' }).then((ids) => ids.filter(Boolean).length)
    ]);

    const totalRevenue = revenueByDay.reduce((s: number, d: any) => s + (d.revenue || 0), 0);
    res.json({
      success: true,
      data: {
        periodDays: days,
        totalRevenue,
        revenueByDay,
        paymentsByStatus: byStatus,
        appliedByItem: byItem,
        totalUsers,
        premiumActive,
        payingUsers,
        payingConversion: totalUsers ? +(payingUsers / totalUsers * 100).toFixed(2) : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить статистику монетизации' });
  }
};

/**
 * Глобальные рантайм-тумблеры продукта (лимиты поиска / ИИ-собеседники /
 * авто-разрыв ИИ-чата / фиктивная статистика).
 * GET /api/admin/settings — текущее состояние + метаданные.
 * PUT /api/admin/settings — частичное обновление флагов (body: { <flag>: boolean }).
 */
export const getGlobalSettings = async (_req: Request, res: Response): Promise<void> => {
  try {
    const { SettingsService } = await import('../services/SettingsService');
    const config = (await import('../config')).default;
    await SettingsService.refresh().catch(() => {});
    res.json({
      success: true,
      flags: SettingsService.flags,
      meta: {
        // HONEST_MODE=true в .env принудительно выключает фикцию независимо от тумблеров
        honestMode: config.honestMode,
        searchHourlyLimit: Number(process.env.SEARCH_HOURLY_LIMIT || 2),
        aiChatTtlSec: [
          Math.round(Number(process.env.AI_CHAT_TTL_MIN_MS || 40000) / 1000),
          Math.round(Number(process.env.AI_CHAT_TTL_MAX_MS || 70000) / 1000),
        ],
        aiModel: process.env.AI_COMPANION_MODEL || 'gpt-4o',
        updatedAt: SettingsService.updatedInfo.updatedAt || null,
        updatedBy: SettingsService.updatedInfo.updatedBy || null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить настройки' });
  }
};

export const updateGlobalSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { SettingsService } = await import('../services/SettingsService');
    const { GLOBAL_SETTINGS_FLAG_KEYS } = await import('../models/GlobalSettings');
    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Record<string, boolean> = {};
    for (const k of GLOBAL_SETTINGS_FLAG_KEYS) {
      if (typeof body[k] === 'boolean') patch[k] = body[k] as boolean;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Нет валидных флагов в теле запроса' });
      return;
    }
    const updatedBy = (req as any)._keyOk
      ? 'admin-key'
      : String((req as any).user?.telegramId || (req as any).user?.userId || 'admin');
    const flags = await SettingsService.update(patch, updatedBy);
    res.json({ success: true, flags });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось обновить настройки' });
  }
};
