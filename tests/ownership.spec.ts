import { describe, expect, it, jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';
import { ensureOwnerOrAdminByParam } from '../src/middleware/ownership';

function mockCtx(opts: { paramTelegramId?: string; user?: { telegramId: string | number; userId?: string; isAdmin?: boolean } }) {
  const req = { params: { telegramId: opts.paramTelegramId }, user: opts.user } as unknown as Request;
  const status = jest.fn().mockReturnThis();
  const json = jest.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

describe('ensureOwnerOrAdminByParam', () => {
  it('владелец (telegramId совпадает) → next, без ответа', () => {
    const { req, res, next, status } = mockCtx({ paramTelegramId: '12345', user: { telegramId: 12345 } });
    ensureOwnerOrAdminByParam(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('синтетический ОТРИЦАТЕЛЬНЫЙ telegramId: строка из URL === число из токена → owner', () => {
    const { req, res, next } = mockCtx({ paramTelegramId: '-170645808066628', user: { telegramId: -170645808066628 } });
    ensureOwnerOrAdminByParam(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('чужой ресурс, не админ → 403 (именно тот баг коллизии сессий)', () => {
    const { req, res, next, status, json } = mockCtx({ paramTelegramId: '-111', user: { telegramId: -222 } });
    ensureOwnerOrAdminByParam(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('чужой ресурс, но админ → next', () => {
    const { req, res, next, status } = mockCtx({ paramTelegramId: '999', user: { telegramId: 111, isAdmin: true } });
    ensureOwnerOrAdminByParam(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('нет req.user → 401', () => {
    const { req, res, next, status } = mockCtx({ paramTelegramId: '12345' });
    ensureOwnerOrAdminByParam(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});
