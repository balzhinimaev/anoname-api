import { afterEach, describe, expect, it, jest } from '@jest/globals';

const countDocumentsMock = jest.fn();

jest.mock('../../src/services/LeadBroadcastService', () => {
  const mockInstance = {
    enqueueWebhook: jest.fn(),
    enqueueMessage: jest.fn(),
  };

  class MockLeadBroadcastService {
    static getInstance() {
      return mockInstance;
    }
  }

  return {
    __esModule: true,
    LeadBroadcastService: MockLeadBroadcastService,
    default: MockLeadBroadcastService,
    leadBroadcastService: mockInstance,
  };
});

jest.mock('../../src/models/Lead', () => ({
  __esModule: true,
  default: {
    countDocuments: countDocumentsMock,
  },
}));

jest.mock('../../src/utils/metrics', () => ({
  metricsCollector: {
    leadCampaignLaunchStarted: jest.fn(),
    leadCampaignMessageQueued: jest.fn(),
  },
}));

import LeadCampaignService from '../../src/services/LeadCampaignService';

describe('LeadCampaignService.countSegmentLeads', () => {
  afterEach(() => {
    countDocumentsMock.mockReset();
  });

  const prepareMock = () => {
    countDocumentsMock.mockImplementation((() => Promise.resolve(0)) as any);
    return countDocumentsMock;
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
