import { beforeEach, expect, it, jest } from '@jest/globals';
jest.mock('../../src/server', () => ({ wsManager: { io: { to: jest.fn(() => ({ emit: jest.fn() })) }, noteChatMessage: jest.fn() } }));
jest.mock('../../src/config', () => ({ __esModule: true, default: { voice: { mediaDir: '/virtual', maxPerChat: 0, minIntervalMs: 5000, maxDurationSec: 60 } } }));
jest.mock('fs/promises', () => ({ __esModule: true, default: { mkdir: jest.fn(async () => {}), unlink: jest.fn(async () => {}), stat: jest.fn(async () => ({ size: 100 })) } }));
jest.mock('../../src/models/Chat', () => ({ __esModule: true, default: { findById: jest.fn(), updateOne: jest.fn() } }));
jest.mock('../../src/models/User', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/Message', () => ({ __esModule: true, default: { findOne: jest.fn(), countDocuments: jest.fn(), create: jest.fn() } }));
jest.mock('../../src/models/Report', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/BlockService', () => ({ BlockService: { anyBlockBetween: jest.fn(async () => false) } }));
jest.mock('../../src/services/GamificationService', () => ({ GamificationService: { award: jest.fn(async () => {}) } }));
jest.mock('../../src/utils/logger', () => ({ wsLogger: { info: jest.fn(), warn: jest.fn() } }));

import config from '../../src/config';
import Chat from '../../src/models/Chat';
import Message from '../../src/models/Message';
import User from '../../src/models/User';
import { VoiceService } from '../../src/services/VoiceService';

const userId = '000000000000000000000001';
const chatId = '000000000000000000000002';
const recipientId = '000000000000000000000003';
const upload = () => VoiceService.handleUpload({ tmpPath: '/virtual/input', userId, chatId, clientId: 'voice-test', voiceChanged: false, waveform: [] });

beforeEach(() => {
  jest.restoreAllMocks();
  config.voice.maxPerChat = 0;
  (VoiceService as any).lastVoiceAt.clear();
  (Chat.findById as jest.Mock<any>).mockReturnValue({ select: async () => ({ isActive: true, participants: [userId, recipientId] }) });
  (User.findById as jest.Mock<any>).mockReturnValue({ select: () => ({ lean: async () => ({ preferences: { acceptVoice: true } }) }) });
  (Message.findOne as jest.Mock<any>).mockReturnValue({ populate: async () => null });
  (Message.countDocuments as jest.Mock<any>).mockResolvedValue(30);
  (Message.create as jest.Mock<any>).mockImplementation(async (data: any) => ({ ...data, populate: async () => data }));
  jest.spyOn(VoiceService as any, 'transcode').mockResolvedValue(undefined);
  jest.spyOn(VoiceService as any, 'probeDuration').mockResolvedValue(10);
});

it('unlimited mode permits further voice messages without counting conversation history', async () => {
  expect((await upload()).created).toBe(true);
  expect(Message.countDocuments).not.toHaveBeenCalled();
  expect(Message.create).toHaveBeenCalledTimes(1);
});

it('restoring a positive quota rejects uploads at the boundary', async () => {
  config.voice.maxPerChat = 30;
  await expect(upload()).rejects.toMatchObject({ status: 429, message: 'Voice message limit for this chat reached' });
  expect(Message.create).not.toHaveBeenCalled();
});

it('a positive quota allows the last available voice message', async () => {
  config.voice.maxPerChat = 30;
  (Message.countDocuments as jest.Mock<any>).mockResolvedValue(29);
  expect((await upload()).created).toBe(true);
});

it('unlimited conversations retain the anti-flood interval', async () => {
  await upload();
  await expect(upload()).rejects.toMatchObject({ status: 429, message: 'Too many voice messages, slow down' });
  expect(Message.create).toHaveBeenCalledTimes(1);
});

it('unlimited conversations still respect the recipient voice preference', async () => {
  (User.findById as jest.Mock<any>).mockReturnValue({ select: () => ({ lean: async () => ({ preferences: { acceptVoice: false } }) }) });
  await expect(upload()).rejects.toMatchObject({ status: 403 });
  expect(Message.create).not.toHaveBeenCalled();
});

it('per-recording duration remains bounded in unlimited conversations', async () => {
  (VoiceService as any).probeDuration.mockResolvedValue(70);
  await expect(upload()).rejects.toMatchObject({ status: 400, message: 'Recording too long' });
  expect(Message.create).not.toHaveBeenCalled();
});
