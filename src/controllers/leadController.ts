import { Request, Response } from 'express';
import { LeadService } from '../services/LeadService';

export const addLead = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.body;

    if (!telegramId || typeof telegramId !== 'string') {
      res.status(400).json({ error: 'telegramId is required' });
      return;
    }

    const result = await LeadService.addLead(telegramId);
    
    res.json({
      success: true,
      added: result.added,
      isNew: result.isNew
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add lead' });
  }
};

export const getStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats = await LeadService.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get lead stats' });
  }
};

export const recordTmaOpen = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body ?? {};
    const telegramIdRaw = body.telegramId;

    if (telegramIdRaw === undefined || telegramIdRaw === null) {
      res.status(400).json({ error: 'telegramId is required' });
      return;
    }

    const telegramId = typeof telegramIdRaw === 'string' ? telegramIdRaw : String(telegramIdRaw);
    if (!telegramId.trim()) {
      res.status(400).json({ error: 'telegramId is required' });
      return;
    }

    const payload = body.payload ?? undefined;
    const campaign = typeof body.campaign === 'string' ? body.campaign : undefined;
    const campaignId = typeof body.campaignId === 'string' ? body.campaignId : undefined;

    const result = await LeadService.recordTmaOpen({
      telegramId: telegramId.trim(),
      payload,
      campaign: campaign ?? null,
      campaignId: campaignId ?? null
    });

    res.json({
      success: true,
      created: result.created,
      leadId: String(result.lead._id),
      telegramId: result.lead.telegramId,
      campaign: result.lead.campaign ?? null,
      campaignId: result.lead.campaignId ? String(result.lead.campaignId) : null,
      tmaOpenedAt: result.lead.tmaOpenedAt ?? null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to record TMA open' });
  }
};
