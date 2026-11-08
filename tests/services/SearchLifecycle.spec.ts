import { beforeEach, expect, it, jest } from '@jest/globals';
import mongoose from 'mongoose';

jest.mock('../../src/server', () => ({ wsManager: {} }));
jest.mock('../../src/models/Search', () => ({ __esModule: true, default: { findOne: jest.fn(), findById: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() } }));
jest.mock('../../src/models/Chat', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/User', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/AnalyticsEvent', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { debug: jest.fn() }, wsLogger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../src/services/MonetizationService', () => ({ MonetizationService: { canUserSearch: jest.fn(), consumeSearch: jest.fn(), isBoostActive: jest.fn() } }));
jest.mock('../../src/services/SettingsService', () => ({ SettingsService: {} }));
jest.mock('../../src/services/BlockService', () => ({ BlockService: {} }));
jest.mock('../../src/services/ReferralService', () => ({ ReferralService: { markQualified: jest.fn(), rewardReferrer: jest.fn() } }));
jest.mock('../../src/services/GamificationService', () => ({ GamificationService: {} }));

import Search from '../../src/models/Search';
import Chat from '../../src/models/Chat';
import User from '../../src/models/User';
import AnalyticsEvent from '../../src/models/AnalyticsEvent';
import { MonetizationService } from '../../src/services/MonetizationService';
import { SearchService, SearchLimitError, SearchCriteria } from '../../src/services/SearchService';

const userId = new mongoose.Types.ObjectId().toString();
const criteria: SearchCriteria = { gender: 'male', age: 25, desiredGender: ['any'], desiredAgeMin: 18, desiredAgeMax: 100, useGeolocation: false };
let searches: any[];
const start = (id = userId) => SearchService.startSearch(id, '-42', criteria);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  jest.restoreAllMocks();
  searches = [];
  (Search.findOne as jest.Mock<any>).mockImplementation(async ({ userId: id, status }: any) => searches.find(s => String(s.userId) === String(id) && s.status === status) || null);
  (Search.create as jest.Mock<any>).mockImplementation(async (data: any) => {
    const doc = { ...data, _id: new mongoose.Types.ObjectId() };
    searches.push(doc);
    return { ...doc };
  });
  (Search.findById as jest.Mock<any>).mockImplementation(async (id: any) => searches.find(s => String(s._id) === String(id)) || null);
  (Search.findOneAndUpdate as jest.Mock<any>).mockImplementation(async ({ userId: id, status }: any, update: any) => {
    const doc = searches.find(s => String(s.userId) === String(id) && s.status === status);
    if (doc) Object.assign(doc, update);
    return doc || null;
  });
  (Chat.findOne as jest.Mock<any>).mockResolvedValue(null);
  (User.findById as jest.Mock<any>).mockReturnValue({ select: () => ({ lean: async () => ({ authProvider: 'web' }) }) });
  (AnalyticsEvent.create as jest.Mock<any>).mockResolvedValue({});
  (MonetizationService.canUserSearch as jest.Mock<any>).mockResolvedValue({ canSearch: true });
  (MonetizationService.consumeSearch as jest.Mock<any>).mockResolvedValue(undefined);
  jest.spyOn(SearchService, 'broadcastSearchStats').mockResolvedValue(undefined);
  jest.spyOn(SearchService as any, 'findMatches').mockResolvedValue([]);
});

it('a cancel arriving while start is awaiting quota leaves no ghost search', async () => {
  const entered = gate(); const blocked = gate();
  (MonetizationService.canUserSearch as jest.Mock<any>).mockImplementationOnce(async () => { entered.release(); await blocked.promise; return { canSearch: true }; });
  const pending = start();
  await entered.promise;
  const cancel = SearchService.cancelSearch(userId);
  blocked.release();
  await Promise.all([pending, cancel]);
  expect(searches).toHaveLength(1);
  expect(searches[0].status).toBe('cancelled');
});

it('concurrent duplicate starts preserve queue position and charge once', async () => {
  const results = await Promise.all([start(), start(), start()]);
  expect(searches).toHaveLength(1);
  expect(MonetizationService.consumeSearch).toHaveBeenCalledTimes(1);
  expect(results.map(r => r.status)).toEqual(['searching', 'searching', 'searching']);
});

it('start/cancel/start are ordered and the final intentional search survives', async () => {
  await Promise.all([start(), SearchService.cancelSearch(userId), start()]);
  expect(searches.map(s => s.status)).toEqual(['cancelled', 'searching']);
  expect(MonetizationService.consumeSearch).toHaveBeenCalledTimes(2);
});

it('slow start for one user does not block another user', async () => {
  const entered = gate(); const blocked = gate();
  (MonetizationService.canUserSearch as jest.Mock<any>).mockImplementationOnce(async () => { entered.release(); await blocked.promise; return { canSearch: true }; });
  const pending = start();
  await entered.promise;
  try { expect((await start(new mongoose.Types.ObjectId().toString())).status).toBe('searching'); }
  finally { blocked.release(); await pending; }
});

it('failed start does not poison subsequent commands and preserves quota metadata', async () => {
  (MonetizationService.canUserSearch as jest.Mock<any>).mockResolvedValueOnce({ canSearch: false, reason: 'limit', resetInMin: 12 });
  await expect(start()).rejects.toMatchObject({ name: 'SearchLimitError', resetInMin: 12 });
  expect(SearchLimitError.prototype).toBeInstanceOf(Error);
  await SearchService.cancelSearch(userId);
  expect((await start()).status).toBe('searching');
});

it('returns committed matched state, not the stale pre-transaction document', async () => {
  jest.spyOn(SearchService as any, 'findMatches').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
  jest.spyOn(SearchService as any, 'selectBestMatch').mockImplementation(async (_s: any, matches: any) => matches[0]);
  jest.spyOn(SearchService as any, 'createMatch').mockImplementation(async () => { searches[0].status = 'matched'; });
  expect((await start()).status).toBe('matched');
});

it('start during an active chat resumes the chat without charging or creating a search', async () => {
  (Chat.findOne as jest.Mock<any>).mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
  expect((await start()).status).toBe('matched');
  expect(searches).toHaveLength(0);
  expect(MonetizationService.consumeSearch).not.toHaveBeenCalled();
});

it('disconnect inspection waits for an in-flight start instead of missing it', async () => {
  const pending = start();
  const active = SearchService.getUserActiveSearch(userId);
  await pending;
  expect(await active).toMatchObject({ status: 'searching' });
});
