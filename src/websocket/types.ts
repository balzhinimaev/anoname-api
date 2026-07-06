import { Socket } from 'socket.io';
import { IMessage } from '../models/Message';

export interface ServerToClientEvents {
  // Состояние соединения
  'connection:recovered': () => void;

  // Поиск и мэтчинг
  'search:matched': (data: {
    matchedUser: {
      // PII (telegramId/username/lastName) намеренно не передаётся в анонимном чате — поля опциональны.
      telegramId?: string;
      gender: 'male' | 'female';
      age: number;
      rating: number;
      username?: string;
      firstName?: string;
      lastName?: string;
      profilePhoto?: string;
      photos?: string[];
      isPremium: boolean;
      chatId: string;
      // Принимает ли собеседник голосовые сообщения (privacy-настройка)
      acceptsVoice?: boolean;
      // Принимает ли собеседник приглашения в мини-игры (privacy-настройка)
      acceptsGames?: boolean;
      // Доступен ли Купидон в чате (false, если любой из двоих его заблокировал)
      cupidAvailable?: boolean;
      // Грубое расстояние (км, ступенчатое округление) — только если оба делились гео
      distanceKm?: number;
    };
  }) => void;
  'search:expired': () => void;
  'search:status': (data: {
    status: 'searching' | 'cancelled' | 'expired' | 'matched'
  }) => void;
  'search:stats': (data: {
    t: number;  // total searching
    m: number;  // male searching
    f: number;  // female searching
    inChat: number;  // людей в активных чатах (чаты × 2)
    online: {
      t: number;  // total online
      m: number;  // male online
      f: number;  // female online
    };
    avgSearchTime: {
      t: number;  // average search time total
      m: number;  // average search time male
      f: number;  // average search time female
      matches24h: number;  // matches in last 24h
    };
  }) => void;

  // Чаты и сообщения
  'chat:message': (data: {
    chatId: string;
    message: IMessage;
  }) => void;
  'chat:start_typing': (data: {
    chatId: string;
    userId: string;
    // 'voice' → собеседник записывает голосовое (иначе печатает текст)
    mode?: 'voice';
  }) => void;
  'chat:stop_typing': (data: {
    chatId: string;
    userId: string;
  }) => void;
  'chat:read': (data: {
    chatId: string;
    userId: string;
    timestamp: Date;
  }) => void;
  'chat:ended': (data: {
    chatId: string;
    endedBy: string;
    reason?: string;
  }) => void;
  'chat:rated': (data: {
    chatId: string;
    ratedBy: string;
    score: number;
  }) => void;
  'chat:partner_status': (data: {
    chatId: string;
    userId: string;
    status: 'online' | 'offline';
    reconnectExpiresAt?: string; // ISO: конец grace-периода
    serverNow?: string;          // ISO: текущее время сервера
    reason?: 'tma_closed' | 'network' | 'unknown';
  }) => void;

  // Подтверждение отправки жалобы
  'report:submitted': (data: { chatId: string; reportId?: string }) => void;

  // Снимок сессии после connect/restore
  'session:state': (data: {
    activeChatId?: string;
    partnerStatus?: {
      chatId: string;
      userId: string; // партнёр, чей статус описан
      status: 'online' | 'offline';
      reconnectExpiresAt?: string;
      serverNow?: string;
      reason?: 'tma_closed' | 'network' | 'unknown';
    };
    matchedUser?: {
      telegramId?: string;
      gender?: 'male' | 'female';
      age?: number;
      rating?: number;
      username?: string;
      firstName?: string;
      lastName?: string;
      profilePhoto?: string;
      photos?: string[];
      isPremium?: boolean;
      chatId: string;
      acceptsVoice?: boolean;
      acceptsGames?: boolean;
      cupidAvailable?: boolean;
      distanceKm?: number;
    }
  }) => void;

  // Контакты
  'contact:request': (data: {
    from: string;
    chatId: string;
  }) => void;
  'contact:status': (data: {
    userId: string;
    status: 'accepted' | 'declined' | 'blocked';
  }) => void;

  // Блокировки
  'user:blocked': (data: { userId: string }) => void;
  'user:unblocked': (data: { userId: string }) => void;

  'error': (data: { message: string }) => void;

  'search:error': (data: { message: string }) => void;

  // Предстартовая очередь
  'prelaunch:stats': (data: { count: number }) => void;

  // Мини-игры (generic игровой слой)
  'game:invite': (data: { gameId: string; by: string; title: string }) => void;
  'game:start': (data: { gameId: string; role: 'drawer' | 'guesser'; word?: string; myScore: number; opponentScore: number; round: number; roundSeconds: number; targetScore: number }) => void;
  'game:event': (data: { type: string; payload?: any }) => void;
  'game:end': (data: { reason?: string; youWon?: boolean; myScore?: number; opponentScore?: number }) => void;
}

export interface ClientToServerEvents {
  // Поиск
  'search:start': (data: {
    criteria: {
      gender: 'male' | 'female';
      age: number;
      rating?: number;
      desiredGender: ('male' | 'female' | 'any')[];
      desiredAgeMin: number;
      desiredAgeMax: number;
      minAcceptableRating?: number;
      useGeolocation: boolean;
      location?: {
        longitude: number;
        latitude: number;
      };
      maxDistance?: number;
    };
  }) => void;
  'search:cancel': () => void;

  // Чаты
  'chat:join': (chatId: string) => void;
  'chat:leave': (chatId: string) => void;
  'chat:message': (data: {
    chatId: string;
    content: string;
    replyTo?: string;  // ID сообщения, на которое отвечаем
  }) => void;
  'chat:start_typing': (data: { chatId: string; mode?: 'voice' }) => void;
  'chat:stop_typing': (data: { chatId: string }) => void;
  // Запросить у AI тему/вопрос для оживления диалога (айсбрейкер)
  'chat:suggest_topic': (data: { chatId: string }) => void;
  'chat:read': (data: {
    chatId: string;
    timestamp: Date;
  }) => void;
  'chat:end': (data: {
    chatId: string;
    reason?: string;
  }) => void;
  'chat:rate': (data: {
    chatId: string;
    score: number;
    comment?: string;
  }) => void;

  // Жалоба на собеседника в активном чате
  'chat:report': (data: {
    chatId: string;
    reason: 'spam' | 'insult' | 'scam' | 'sexual' | 'illegal' | 'other';
    comment?: string;
  }) => void;

  // Контакты
  'contact:request': (data: {
    to: string;
    chatId: string;
  }) => void;
  'contact:respond': (data: {
    userId: string;
    status: 'accepted' | 'declined' | 'blocked';
  }) => void;

  // Блокировки
  'user:block': (data: { userId: string; reason?: string; expiresAt?: string }) => void;
  'user:unblock': (data: { userId: string }) => void;

  // Подписка на статистику
  'search:subscribe_stats': () => void;
  'search:unsubscribe_stats': () => void;

  // Предстартовая очередь
  'prelaunch:subscribe': () => void;
  'prelaunch:unsubscribe': () => void;

  // Мини-игры
  'game:invite': (data: { chatId: string; gameId: string }) => void;
  'game:respond': (data: { chatId: string; accept: boolean }) => void;
  'game:event': (data: { chatId: string; type: string; payload?: any }) => void;
  'game:leave': (data: { chatId: string }) => void;
}

export interface SocketData {
  user: {
    _id: string | { toString(): string };
    telegramId: string;
    isAdmin?: boolean;
    cohort?: 'A' | 'B';
  };
  searchCriteria?: {
    desiredGender: ('male' | 'female' | 'any')[];
    desiredAgeRanges: string[];
    useGeolocation: boolean;
    location?: {
      longitude: number;
      latitude: number;
    };
  };
  recovered?: boolean; // флаг восстановления соединения
}

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>, // InterServerEvents - пока не используем
  SocketData
>; 