import { beforeEach, expect, it, jest } from '@jest/globals';
import { Request, Response } from 'express';
import mongoose from 'mongoose';

jest.mock('../src/server', () => ({ wsManager: {} }));
jest.mock('../src/models/Chat', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../src/models/User', () => ({ __esModule: true, default: { findById: jest.fn(), findOneAndUpdate: jest.fn() } }));
jest.mock('../src/models/Rating', () => ({ __esModule: true, default: { calculateAverageRating: jest.fn() } }));
jest.mock('../src/services/BlockService', () => ({ BlockService: { anyBlockBetween: jest.fn() } }));
jest.mock('../src/services/ReferralService', () => ({ ReferralService: { ensureReferralCode: jest.fn(async () => {}) } }));

import Chat from '../src/models/Chat';
import User from '../src/models/User';
import Rating from '../src/models/Rating';
import { BlockService } from '../src/services/BlockService';
import { getPartnerProfile } from '../src/controllers/partnerProfileController';
import { createOrUpdateUser } from '../src/controllers/userController';

const viewer = '000000000000000000000001';
const partner = '000000000000000000000002';
const chatId = '000000000000000000000003';
let active: boolean;
let participants: string[];
const profile = { firstName: 'Мира', age: 24, bio: 'Люблю книги', lookingFor: 'friendship', interests: ['Книги'], rating: 1, telegramId: 12345, username: 'private_handle', login: 'private_login', passwordHash: 'private_hash', lastName: 'private_surname', location: { latitude: 1 }, subscription: { type: 'gold' }, analytics: { totalMatches: 9 } };
function response() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
  return res;
}
async function request(userId: string | undefined = viewer, id = chatId) {
  const req = { params: { chatId: id }, user: userId ? { userId } : undefined } as unknown as Request;
  const res = response();
  await getPartnerProfile(req, res as unknown as Response);
  return res;
}
beforeEach(() => {
  active = true; participants = [viewer, partner];
  (Chat.findOne as jest.Mock<any>).mockImplementation((filter: any) => ({ select: () => ({ lean: async () => filter._id === chatId && filter.isActive === active && participants.includes(filter.participants) ? { participants } : null }) }));
  (User.findById as jest.Mock<any>).mockReturnValue({ select: () => ({ lean: async () => profile }) });
  (Rating.calculateAverageRating as jest.Mock<any>).mockResolvedValue({ averageRating: 4.75, totalRatings: 4 });
  (BlockService.anyBlockBetween as jest.Mock<any>).mockResolvedValue(false);
});
it('returns an explicit mini-profile projection and real aggregate rating, not private account fields', async () => {
  const res = await request();
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ firstName: 'Мира', age: 24, gender: undefined, profilePhoto: undefined, photos: [], bio: 'Люблю книги', lookingFor: 'friendship', interests: ['Книги'], rating: 4.75, ratingsCount: 4 });
  expect(Rating.calculateAverageRating).toHaveBeenCalledWith(new mongoose.Types.ObjectId(partner));
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
it('denies a logged-in stranger who guesses a valid chat ID', async () => {
  expect((await request('000000000000000000000004')).status).toHaveBeenCalledWith(404);
  expect(User.findById).not.toHaveBeenCalled();
});
it('denies access after the anonymous chat ends', async () => {
  active = false;
  expect((await request()).status).toHaveBeenCalledWith(404);
  expect(User.findById).not.toHaveBeenCalled();
});
it('honours a block in either direction', async () => {
  (BlockService.anyBlockBetween as jest.Mock<any>).mockResolvedValue(true);
  expect((await request()).status).toHaveBeenCalledWith(404);
  expect(User.findById).not.toHaveBeenCalled();
});
it('rejects invalid chat identifiers before querying data', async () => {
  expect((await request(viewer, 'not-an-id')).status).toHaveBeenCalledWith(400);
  expect(Chat.findOne).not.toHaveBeenCalled();
});
it('requires authentication', async () => {
  const res = response();
  await getPartnerProfile({ params: { chatId } } as unknown as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(401);
});
it('cannot confuse a group or malformed chat with a one-to-one match', async () => {
  participants.push('000000000000000000000004');
  expect((await request()).status).toHaveBeenCalledWith(404);
});
it('keeps a usable empty profile and distinguishes no ratings from a low rating', async () => {
  (User.findById as jest.Mock<any>).mockReturnValue({ select: () => ({ lean: async () => ({}) }) });
  (Rating.calculateAverageRating as jest.Mock<any>).mockResolvedValue({ averageRating: 0, totalRatings: 0 });
  expect((await request()).json).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Собеседник', bio: '', lookingFor: '', interests: [], rating: 0, ratingsCount: 0 }));
});
it('updates only the owner and ignores forged rating, subscription and target identifiers', async () => {
  (User.findOneAndUpdate as jest.Mock<any>).mockReturnValue({ select: async () => ({ firstName: 'Мира' }) });
  const req = { user: { userId: viewer, telegramId: -42 }, body: { telegramId: 999, userId: partner, firstName: 'Мира', bio: '', interests: [], lookingFor: '', rating: 5, subscription: { type: 'gold' } } } as unknown as Request;
  const res = response();
  await createOrUpdateUser(req, res as unknown as Response);
  expect(User.findOneAndUpdate).toHaveBeenCalledWith({ telegramId: -42 }, { $set: { telegramId: -42, firstName: 'Мира', bio: '', interests: [], lookingFor: '' } }, { new: true, upsert: true });
  expect(res.status).toHaveBeenCalledWith(200);
});
