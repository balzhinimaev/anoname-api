import jwt from 'jsonwebtoken';
import User, { IUser } from '../../models/User';
import { ExtendedError } from 'socket.io/dist/namespace';
import config from '../../config';
import { TypedSocket } from '../types';
import mongoose from 'mongoose';
import { wsLogger } from '../../utils/logger';

export const socketAuth = async (
  socket: TypedSocket,
  next: (err?: ExtendedError | undefined) => void
) => {
  try {
    wsLogger.info('auth_attempt', 'WebSocket authentication attempt', {
      origin: socket.handshake.headers?.origin,
      userAgent: (socket.handshake.headers as any)['user-agent'],
      hasAuthToken: Boolean((socket.handshake as any).auth?.token || (socket.handshake.headers as any).token || (socket.handshake.headers as any).authorization)
    });

    // Пытаемся получить токен из разных источников
    let token = socket.handshake.auth.token || 
                socket.handshake.headers.token || 
                socket.handshake.headers.authorization;

    // Проверяем и очищаем токен от префикса Bearer
    if (token && typeof token === 'string' && token.startsWith('Bearer ')) {
      token = token.slice(7);
    }
    
    if (!token) {
      wsLogger.error('system', 'socket-auth', new Error('Token not provided'), {
        reason: 'no_token_provided',
        origin: socket.handshake.headers?.origin,
        userAgent: (socket.handshake.headers as any)['user-agent']
      });
      return next(new Error('Authentication error: Token not provided'));
    }

    const decoded = jwt.verify(token, config.jwtSecret) as { userId?: string; telegramId?: string };
    
    let user: (IUser & { _id: mongoose.Types.ObjectId }) | null = null;
    
    // Пробуем найти пользователя по userId или telegramId
    if (decoded.userId) {
      user = await User.findById(decoded.userId) as IUser & { _id: mongoose.Types.ObjectId };
    } else if (decoded.telegramId) {
      user = await User.findOne({ telegramId: decoded.telegramId }) as IUser & { _id: mongoose.Types.ObjectId };
    }

    if (!user) {
      wsLogger.error('system', 'socket-auth', new Error('User not found'), {
        userId: decoded.userId,
        telegramId: decoded.telegramId
      });
      return next(new Error('Authentication error: User not found'));
    }

    // Проверяем восстановление соединения
    if (socket.handshake.auth.serverOffset && socket.recovered) {
      socket.data.recovered = true;
      wsLogger.info('connection_recovered', 'Connection recovered', {
        userId: user._id.toString(),
        telegramId: user.telegramId
      });
    }

    // Сохраняем информацию о пользователе в socket.data
    socket.data.user = {
      _id: user._id.toString(),
      telegramId: user.telegramId.toString()
    };

    wsLogger.info('auth_success', 'WebSocket authentication successful', {
      userId: user._id.toString(),
      telegramId: user.telegramId,
      authSource: token === socket.handshake.auth.token ? 'auth' : 
                 token === socket.handshake.headers.token ? 'header_token' : 'header_authorization'
    });

    next();
  } catch (error) {
    wsLogger.error('system', 'socket-auth', error as Error, {
      origin: socket.handshake.headers?.origin,
      userAgent: (socket.handshake.headers as any)['user-agent']
    });
    next(new Error('Authentication error: Invalid token'));
  }
}; 