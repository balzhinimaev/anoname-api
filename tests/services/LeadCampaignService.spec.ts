import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const leadBroadcastMock = {
  enqueueMessage: jest.fn() as jest.MockedFunction<
    (telegramId: string, text: string, options?: any) => Promise<any>
  >,
};

const leadModelMock = {
  countDocuments: jest.fn() as jest.MockedFunction<(filter: any) => Promise<number>>,
  find: jest.fn() as jest.MockedFunction<(filter: any) => any>,
  updateMany: jest.fn() as jest.MockedFunction<(filter: any, update: any) => Promise<any>>,
};

const leadCampaignModelMock = {
  countDocuments: jest.fn() as jest.MockedFunction<(filter: any) => Promise<number>>,
  find: jest.fn() as jest.MockedFunction<(filter: any) => any>,
  findById: jest.fn() as jest.MockedFunction<(id: string) => Promise<any>>,
  findByIdAndUpdate: jest.fn() as jest.MockedFunction<(id: string, update: any) => Promise<any>>,
  deleteOne: jest.fn() as jest.MockedFunction<(filter: any) => Promise<any>>,
  create: jest.fn() as jest.MockedFunction<(payload: any) => Promise<any>>,
};

jest.mock('../../src/services/LeadBroadcastService', () => {
  class MockLeadBroadcastService {
    static getInstance() {
      return leadBroadcastMock;
    }
  }

  return {
    __esModule: true,
    LeadBroadcastService: MockLeadBroadcastService,
    default: MockLeadBroadcastService,
    leadBroadcastService: leadBroadcastMock,
  };
});

jest.mock('../../src/models/Lead', () => ({
  __esModule: true,
  default: leadModelMock,
}));

jest.mock('../../src/models/LeadCampaign', () => ({
  __esModule: true,
  default: leadCampaignModelMock,
}));

jest.mock('../../src/utils/metrics', () => ({
  metricsCollector: {
    leadCampaignLaunchStarted: jest.fn(),
    leadCampaignMessageQueued: jest.fn(),
  },
}));

import LeadCampaignService from '../../src/services/LeadCampaignService';

beforeEach(() => {
  jest.resetAllMocks();
});

describe('LeadCampaignService.countSegmentLeads', () => {
  const prepareMock = () => {
    leadModelMock.countDocuments.mockImplementation((() => Promise.resolve(0)) as any);
    return leadModelMock.countDocuments;
  };

  it('excludes registered leads for segments that require unregistered status', async () => {
    const spy = prepareMock();

    await LeadCampaignService.countSegmentLeads('prelaunch_only');

    expect(spy).toHaveBeenCalledTimes(1);
    const [filter] = spy.mock.calls[0] as [any];

    expect(filter).toHaveProperty('isRegistered', false);
    expect(filter).toHaveProperty('campaignStatus', { $ne: 'unsubscribed' });
    expect(filter).toHaveProperty('$or');
    expect(filter.$or).toEqual([
      { unsubscribedAt: { $exists: false } },
      { unsubscribedAt: null },
    ]);
  });

  it('keeps registered leads excluded for inactive segments', async () => {
    const spy = prepareMock();

    await LeadCampaignService.countSegmentLeads('inactive_7_days');

    expect(spy).toHaveBeenCalledTimes(1);
    const [filter] = spy.mock.calls[0] as [any];

    expect(filter).toHaveProperty('isRegistered', false);
    expect(filter).toHaveProperty('$and');
    expect(filter.$and).toHaveLength(2);
  });

  it('allows registered leads only for permitted segments', async () => {
    const spy = prepareMock();

    await LeadCampaignService.countSegmentLeads('all_leads');

    expect(spy).toHaveBeenCalledTimes(1);
    const [filter] = spy.mock.calls[0] as [any];

    expect(filter).not.toHaveProperty('isRegistered');
    expect(filter).toHaveProperty('$or');
  });
});

describe('LeadCampaignService.launchCampaign', () => {
  const campaignId = '507f1f77bcf86cd799439011';

  beforeEach(() => {
    const saveMock = jest.fn(async () => undefined);

    leadCampaignModelMock.findById.mockResolvedValue({
      _id: campaignId,
      name: 'Autumn Promo',
      segment: 'all_leads',
      template: 'promotion',
      status: 'draft',
      metadata: {
        headline: '🔥 Осенняя распродажа',
        body: 'Получите доступ к новым функциям первыми.',
        valueProp: 'Бонусы для первых 100 участников.',
        socialProof: 'Уже 42 человека в листе ожидания.',
        points: ['Обновлённый профиль', 'Новые фильтры поиска'],
        ctaText: 'Запустить приложение',
        ctaUrl: 'https://example.com/deeplink',
      },
      scheduledAt: null,
      sentAt: null,
      save: saveMock,
    });

    const leanMock = jest.fn(async () => [
      { _id: 'lead-1', telegramId: '100500' },
    ]);
    const selectMock = jest.fn(() => ({
      lean: leanMock,
    }));

    leadModelMock.find.mockImplementation(() => ({ select: selectMock }));
    leadModelMock.updateMany.mockResolvedValue({ acknowledged: true });
    leadBroadcastMock.enqueueMessage.mockResolvedValue({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('queues Telegram sendMessage payload with rendered template text', async () => {
    await LeadCampaignService.launchCampaign(campaignId, {});

    expect(leadBroadcastMock.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(leadBroadcastMock.enqueueMessage).toHaveBeenCalledWith(
      '100500',
      '🔥 Осенняя распродажа\n\nПолучите доступ к новым функциям первыми.\n\nБонусы для первых 100 участников.\n\nУже 42 человека в листе ожидания.\n\n• Обновлённый профиль\n• Новые фильтры поиска\n\n👉 Запустить приложение: https://example.com/deeplink',
      {
        disableLinkPreview: true,
        extra: {
          reply_markup: {
            inline_keyboard: [[{ text: 'Запустить приложение', url: 'https://example.com/deeplink' }]],
          },
        },
      },
    );
  });
});
