import { beforeEach, expect, it, jest } from '@jest/globals';
import { Request, Response } from 'express';
jest.mock('../src/models/User', () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn() } }));
jest.mock('../src/controllers/authController', () => ({ createAndSaveToken: jest.fn() }));
jest.mock('../src/config', () => ({ __esModule: true, default: { botBackendSecret: 'test-bot-secret', adminBackendSecret: '' } }));
import User from '../src/models/User';
import Token from '../src/models/Token';
import { createAndSaveToken } from '../src/controllers/authController';
import { createBotSession } from '../src/controllers/botSessionController';
import { botAuth } from '../src/middleware/botAuth';
const user = { _id: '012345678901234567890123', gender: 'male', age: 25, username: 'PRIVATE', passwordHash: 'PRIVATE', telegramId: 123 };
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() });
beforeEach(() => {
  (User.findOneAndUpdate as jest.Mock<any>).mockResolvedValue(user);
  (createAndSaveToken as jest.Mock<any>).mockResolvedValue('test-jwt');
});
it('requires a trusted bot secret; missing and forged headers cannot create a session', () => {
  for (const headers of [{}, { 'x-bot-secret': 'wrong' }]) {
    const res = response(), next = jest.fn();
    botAuth({ headers } as Request, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
  }
  const next = jest.fn(); botAuth({ headers: { 'x-bot-secret': 'test-bot-secret' } } as unknown as Request, response() as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
});
it('rejects invalid identities before touching the database', async () => {
  for (const telegramId of [0, -1, 1.2, '123', null, Number.MAX_SAFE_INTEGER + 1]) {
    const res = response(); await createBotSession({ body: { telegramId } } as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  }
  expect(User.findOneAndUpdate).not.toHaveBeenCalled();
});
it('isolates bot tokens from Mini App and web tokens and does not overwrite profiles', async () => {
  const req = { body: { telegramId: 123, role: 'admin', username: 'injected', age: 99 } } as Request;
  const res = response(); await createBotSession(req, res as unknown as Response);
  expect(User.findOneAndUpdate).toHaveBeenCalledWith({ telegramId: 123 }, { $setOnInsert: { telegramId: 123, role: 'user', cohort: expect.any(String) } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  expect(createAndSaveToken).toHaveBeenCalledWith(user, req, 'telegram_bot');
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.json).toHaveBeenCalledWith({ token: 'test-jwt', user: { id: user._id, gender: 'male', age: 25 } });
  const token = new Token({ token: 'test', userId: user._id, telegramId: '123', expiresAt: new Date(Date.now() + 1000), platform: 'telegram_bot' });
  expect(token.validateSync()).toBeUndefined();
});
it('fails closed without exposing internal errors', async () => {
  (User.findOneAndUpdate as jest.Mock<any>).mockRejectedValue(new Error('private database detail'));
  const res = response(); await createBotSession({ body: { telegramId: 123 } } as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({ error: 'Bot session unavailable' });
});
