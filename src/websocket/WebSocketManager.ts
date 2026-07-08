import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { socketAuth } from './middleware/auth';
import { ClientToServerEvents, ServerToClientEvents, SocketData, TypedSocket } from './types';
import { ChatService } from '../services/ChatService';
import { SearchService, SearchCriteria, SearchStatsSnapshot } from '../services/SearchService';
import { MonetizationService } from '../services/MonetizationService';
import { wsLogger } from '../utils/logger';
import { metricsCollector } from '../utils/metrics';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import User from '../models/User';
import { RatingService } from '../services/RatingService';
import config from '../config';
import Chat from '../models/Chat';
import mongoose from 'mongoose';
import { chatEndSchema, chatMessageSchema, chatRateSchema, chatReadSchema, searchCriteriaSchema } from '../validation/wsSchemas';
import Report from '../models/Report';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { BlockService } from '../services/BlockService';
import { gameManager, OutEvent } from '../services/GameService';
import { IcebreakerService } from '../services/IcebreakerService';
import { AICompanionService } from '../services/AICompanionService';

// Создаем статическую карту для хранения таймаутов
const pendingSearchCancellations = new Map<string, NodeJS.Timeout>();
const pendingChatEndTimers: Map<string, NodeJS.Timeout> = new Map(); // chatId -> timer
const pendingChatEndDeadlines: Map<string, number> = new Map(); // chatId -> expiresAt timestamp
const CHAT_GRACE_MS = 30000; // льготный период на переподключение

function mapDisconnectReason(reason: string): 'tma_closed' | 'network' | 'unknown' {
  const r = (reason || '').toLowerCase();
  if (r.includes('ping timeout')) return 'network';
  if (r.includes('transport close')) return 'network';
  if (r.includes('client namespace disconnect')) return 'tma_closed';
  return 'unknown';
}

export class WebSocketManager {
  public io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> Set of socketIds
  private userRooms: Map<string, Set<string>> = new Map(); // userId -> Set of room names
  private chatCircuitBreaker: CircuitBreaker;
  private searchCircuitBreaker: CircuitBreaker;
  // Простые лимитеры: token bucket per userId для анти-спама событий
  private wsRateBuckets: Map<string, { tokens: number; lastRefill: number }> = new Map();
  private readonly WS_BUCKET_CAPACITY = 20; // максимум событий за окно
  private readonly WS_BUCKET_REFILL_MS = 10_000; // окно 10 сек
  // Sweep «зомби»-чатов (active с обоими офлайн после потери in-memory таймеров при рестарте).
  // Чат завершается, только если он кандидат (оба офлайн + нет grace-таймера) ДВА прохода
  // подряд — это переживает окно переподключения после рестарта.
  private zombieSuspects = new Set<string>();
  private readonly ZOMBIE_SWEEP_MS = 60_000;
  // Айсбрейкеры: состояние «тишины» по чатам. eligible = с момента последней
  // подсказки было хотя бы одно живое сообщение (защита от спама каждые 20с).
  private icebreakerState: Map<string, {
    timer?: NodeJS.Timeout;
    typing: Set<string>;
    eligible: boolean;
    lastManualAt: number;
  }> = new Map();
  // Чаты, для которых стартовый айсбрейкер уже отправлен/запущен
  private icebreakerStartSent = new Set<string>();
  // Таймеры «подключить ИИ-собеседника, если поиск висит без живого матча»
  private aiMatchTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly AI_MATCH_DELAY_MS = Number(process.env.AI_COMPANION_DELAY_MS) || 20_000;

  constructor(httpServer: HttpServer) {
    const socketCorsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);
      if (origin === config.clientUrl) return callback(null, true);
      if (config.corsWhitelist.includes(origin)) return callback(null, true);
      if (config.corsRegexps.some((re) => re.test(origin))) return callback(null, true);
      return callback(null, false);
    };

    this.io = new Server(httpServer, {
      cors: {
        origin: socketCorsOrigin as any,
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['Authorization', 'Content-Type']
      },
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: false, // повторная аутентификация на восстановлении
      },
      pingTimeout: 20000,
      pingInterval: 25000,
      transports: ['websocket'],
      allowEIO3: true,
      path: '/socket.io/',
      serveClient: false,
      maxHttpBufferSize: 1e6, // 1MB
      httpCompression: {
        threshold: 1024 // Сжимать данные больше 1KB
      }
    });

    // Добавляем обработчик ошибок соединения
    this.io.engine.on('connection_error', (err) => {
      wsLogger.error('system', 'socket.io', new Error(err.message), {
        code: err.code,
        context: err.context
      });
    });

    this.chatCircuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000,
      halfOpenMaxAttempts: 3
    });

    this.searchCircuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 60000,
      halfOpenMaxAttempts: 2
    });

    this.io.use(socketAuth);
    this.initializeEventHandlers();
    this.startZombieSweep();
    // Асинхронные игровые события (истечение таймера раунда) — тем же адресным каналом.
    gameManager.setDispatcher((events) => this.dispatchGameEvents(events));
    // Геймификация: XP/ачивки за доигранные партии
    gameManager.setFinishListener(({ players, winnerId, gameId, quizMatches }) => {
      import('../services/GamificationService').then(({ GamificationService }) => {
        for (const p of players) {
          GamificationService.award(p, 'game_played').catch(() => {});
          if (gameId === 'match-quiz' && (quizMatches || 0) >= 8) {
            GamificationService.award(p, 'quiz_soulmates').catch(() => {});
          }
        }
        if (winnerId) GamificationService.award(winnerId, 'game_won').catch(() => {});
      }).catch(() => {});
    });
  }

  /**
   * Периодически завершает «зомби»-чаты: active с обоими участниками оффлайн и без
   * grace-таймера (например, после рестарта сервера, когда in-memory таймеры потеряны).
   * Безопасность: чат завершается только если он остаётся кандидатом ДВА прохода подряд
   * (~60–120с) — это переживает окно переподключения пользователей после рестарта.
   */
  private startZombieSweep(): void {
    setInterval(() => {
      this.sweepStaleChats().catch((e) => wsLogger.error('zombie_sweep', 'system', e as Error));
      // Аналитика: durable-событие для истёкших поисков до их удаления по TTL
      SearchService.sweepExpiredSearches().catch(() => {});
    }, this.ZOMBIE_SWEEP_MS);
  }

  private async sweepStaleChats(): Promise<void> {
    const active = await Chat.find({ isActive: true }).select('participants').lean();
    const stillSuspect = new Set<string>();
    for (const chat of active) {
      const chatId = String(chat._id);
      // Нормальный grace-флоу сам разберётся — не вмешиваемся.
      if (pendingChatEndTimers.has(chatId)) continue;
      const allOffline = (chat.participants as any[]).every((p) => !this.userSockets.has(p.toString()));
      if (!allOffline) continue;
      if (this.zombieSuspects.has(chatId)) {
        // Кандидат второй проход подряд → это зомби, завершаем.
        try {
          await ChatService.endChat(chatId, (chat.participants as any[])[0].toString(), 'partner_disconnected');
          wsLogger.info('zombie_chat_ended', `Swept stale active chat ${chatId} (both offline, no timer)`, { chatId });
        } catch (e) {
          // 'already ended' и т.п. — игнорируем
          wsLogger.warn('zombie_sweep_end', (e as Error).message, { chatId });
        }
      } else {
        stillSuspect.add(chatId); // первый раз кандидат → проверим в следующий проход
      }
    }
    this.zombieSuspects = stillSuspect;
  }

  // Простой токен-бакет per userId
  private wsRateAllow(userId: string): boolean {
    const now = Date.now();
    let bucket = this.wsRateBuckets.get(userId);
    if (!bucket) {
      bucket = { tokens: this.WS_BUCKET_CAPACITY, lastRefill: now };
      this.wsRateBuckets.set(userId, bucket);
    }
    // Непрерывное пополнение (token bucket) вместо hard-reset раз в окно —
    // убирает burst ×2 на границе окна. Скорость: CAPACITY токенов за REFILL_MS.
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      const refill = (elapsed / this.WS_BUCKET_REFILL_MS) * this.WS_BUCKET_CAPACITY;
      bucket.tokens = Math.min(this.WS_BUCKET_CAPACITY, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  // Отправка снимка сессии при подключении/восстановлении
  private async emitSessionState(socket: TypedSocket) {
    const userId = socket.data.user._id.toString();
    try {
      // Реконнект во время поиска: если поиск пережил обрыв и есть ждущий
      // совместимый собеседник — соединяем сразу (иначе матч «не происходил»).
      await SearchService.retryMatchForUser(userId).catch(() => false);

      const activeChat = await Chat.findOne({ participants: new mongoose.Types.ObjectId(userId), isActive: true });
      if (!activeChat) {
        socket.emit('session:state', {});
        return;
      }
      const chatId = activeChat._id.toString();
      const otherParticipant = activeChat.participants.find(p => p.toString() !== userId)?.toString();

      let partnerStatusPayload: any = undefined;
      let matchedUser: any = undefined;
      if (otherParticipant) {
        // ИИ-персона всегда «онлайн» (у неё нет сокета) — иначе на реконнекте бот
        // показывается «оффлайн/переподключается», что нелогично.
        const isOtherOnline = this.userSockets.has(otherParticipant) || AICompanionService.isPersona(otherParticipant);
        const deadline = pendingChatEndDeadlines.get(chatId);
        partnerStatusPayload = {
          chatId,
          userId: otherParticipant,
          status: isOtherOnline ? 'online' : 'offline',
          reconnectExpiresAt: !isOtherOnline && deadline ? new Date(deadline).toISOString() : undefined,
          serverNow: new Date().toISOString(),
        };

        // Попробуем отдать минимальные данные собеседника для гидратации UI
        // Берем из User: telegramId, gender, age, rating, username/имя/фото, премиум статус
        try {
          // PII: НЕ раскрываем telegramId/@username/фамилию партнёра при гидратации сессии.
          const [other, me] = await Promise.all([
            User.findById(otherParticipant).select('gender age rating firstName profilePhoto photos subscription preferences'),
            User.findById(userId).select('preferences.acceptCupid').lean(),
          ]);
          if (other) {
            matchedUser = {
              gender: other.gender as any,
              age: other.age,
              rating: other.rating,
              firstName: other.firstName,
              profilePhoto: other.profilePhoto,
              photos: other.photos,
              isPremium: !!(other.subscription?.isActive && other.subscription?.type && other.subscription?.type !== 'basic'),
              chatId,
              acceptsVoice: other.preferences?.acceptVoice !== false,
              acceptsGames: other.preferences?.acceptGames !== false,
              // Купидон в чате: блок любого из двоих выключает его для обоих
              cupidAvailable:
                other.preferences?.acceptCupid !== false &&
                (me as { preferences?: { acceptCupid?: boolean } } | null)?.preferences?.acceptCupid !== false,
              // Грубое расстояние из чата — бейдж «📍 ~N км» переживает реконнект
              ...(typeof (activeChat as { distanceKm?: number }).distanceKm === 'number'
                ? { distanceKm: (activeChat as { distanceKm?: number }).distanceKm }
                : {})
            };
          }
        } catch (e) {
          // мягко игнорируем, чтобы не ломать сессию
        }
      }

      socket.emit('session:state', {
        activeChatId: chatId,
        partnerStatus: partnerStatusPayload,
        matchedUser
      });

      // Ресинк мини-игры для переподключившегося: активная партия → снапшот
      // game:start (роль/счёт/остаток таймера, без пере-арма); завершившаяся —
      // game:end закрывает «зависший» оверлей. Иначе холст/таймер/фаза терялись.
      try {
        this.dispatchGameEvents(gameManager.syncEvents(chatId, userId));
      } catch (e) {
        wsLogger.error('game_sync_on_connect', userId, e as Error);
      }
    } catch (error) {
      wsLogger.error('emit_session_state', userId, error as Error);
    }
  }

  private initializeEventHandlers() {
    this.io.on('connection', (socket: TypedSocket) => {
      const userId = socket.data.user._id.toString();
      const isReconnection = socket.recovered;
      const connectionStart = Date.now();
      
      // Метрики подключения
      metricsCollector.connectionOpened();
      
      // Обновляем статус активности пользователя
      User.findByIdAndUpdate(userId, {
        isOnline: true,
        lastActive: new Date()
      }).then(() => {
        // Обновляем статистику после изменения статуса
        SearchService.broadcastSearchStats().catch((error: unknown) => {
          wsLogger.error('update_stats', userId, error as Error);
        });
      }).catch((error: unknown) => {
        wsLogger.error('update_activity', userId, error as Error);
      });

      // Устанавливаем интервал обновления активности
      const activityInterval = setInterval(() => {
        // только обновляем lastActive; isOnline не трогаем здесь, им управляет connect/disconnect + TTL
        User.findByIdAndUpdate(userId, {
          lastActive: new Date()
        }).catch((error: unknown) => {
          wsLogger.error('update_activity', userId, error as Error);
        });
      }, 10000); // Обновляем каждые 10 секунд

      // Логируем подключение
      wsLogger.connection(userId, socket.id, {
        isReconnection,
        telegramId: socket.data.user.telegramId
      });

      // Аналитика: ws_connect (первичное/восстановленное)
      // используем промис без await и логируем ошибки, не мешая потоку
      AnalyticsEvent.create({
        userId: new mongoose.Types.ObjectId(userId),
        telegramId: String(socket.data.user.telegramId),
        cohort: (socket.data.user as any).cohort,
        name: 'ws_connect',
        props: { recovered: isReconnection },
        userAgent: String((socket.handshake.headers as any)['user-agent'] || ''),
        ip: String((socket.handshake.address || ''))
      } as any).catch((err: unknown) => {
        try { wsLogger.warn('ws_connect_analytics_fail', String(err)); } catch {}
      });

      // Снимок сессии после подключения
      this.emitSessionState(socket).catch((error) => {
        wsLogger.error('session_state_emit_error', userId, error as Error);
      });

      // Подписка на статистику поиска
      socket.on('search:subscribe_stats', async () => {
        socket.join('search_stats_room');

        // Отправляем текущую статистику сразу после подписки.
        // Никаких «коррекций себя»: подписчик уже учтён в счётчиках БД,
        // а мутация возвращённого объекта раньше отравляла общий кэш.
        try {
          const stats = await SearchService.getSearchStats();
          socket.emit('search:stats', SearchService.personalizeStats(stats, userId));
        } catch (error) {
          wsLogger.error('stats_initial', userId, error as Error);
        }
        // Счётчик оставшихся поисков при открытии экрана поиска
        void this.sendSearchQuota(userId);
      });

      socket.on('search:unsubscribe_stats', () => {
        socket.leave('search_stats_room');
      });

      // Предстартовая очередь: подписка/отписка
      socket.on('prelaunch:subscribe', async () => {
        try {
          socket.join('prelaunch_room');
          const { PrelaunchService } = await import('../services/PrelaunchService');
          const count = await PrelaunchService.getCount();
          socket.emit('prelaunch:stats', { count });
        } catch (error) {
          wsLogger.error('prelaunch_subscribe', userId, error as Error);
        }
      });

      socket.on('prelaunch:unsubscribe', () => {
        try { socket.leave('prelaunch_room'); } catch {}
      });

      // Добавляем сокет в мапу пользователя
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)?.add(socket.id);

      // Инициализируем хранилище комнат пользователя при первом подключении
      if (!this.userRooms.has(userId)) {
        this.userRooms.set(userId, new Set());
      }

      // При переподключении восстанавливаем комнаты и отменяем таймеры
      if (isReconnection) {
        this.handleReconnection(socket);
      }

      // Проверяем присутствие собеседника и синхронизируем статусы/таймеры после любого подключения (в т.ч. после рестарта)
      this.handlePostConnectPresence(socket).catch((error) => {
        wsLogger.error('post_connect_presence_call', userId, error as Error);
      });

      // Обработчики поиска с логированием
      socket.on('search:start', (data) => {
        if (!this.wsRateAllow(userId)) {
          metricsCollector.wsRateLimited('search:start');
          socket.emit('error', { message: 'Too many requests' });
          return;
        }
        const parsed = searchCriteriaSchema.safeParse(data?.criteria);
        if (!parsed.success) {
          metricsCollector.wsValidationFailed('search:start');
          socket.emit('search:error', { message: 'Invalid payload' });
          return;
        }
        try {
          const startTime = Date.now();
          metricsCollector.searchStarted();
          wsLogger.event('search_start', userId, socket.id, { criteria: data.criteria });
          this.handleSearchStart(socket, data).then(() => {
            const duration = Date.now() - startTime;
            metricsCollector.messageProcessed(duration);
            metricsCollector.searchCompleted(true);
          }).catch(error => {
            metricsCollector.errorOccurred(error as Error);
            metricsCollector.searchCompleted(false);
            wsLogger.error('search_start_handler_promise', userId, error as Error, { event: 'search:start' });
          });
        } catch (error) {
            wsLogger.error('search_start_handler_sync', userId, error as Error, { event: 'search:start' });
            socket.emit('error', { message: 'Critical error during search initiation.' });
        }
      });

      socket.on('search:cancel', () => {
        if (!this.wsRateAllow(userId)) {
          metricsCollector.wsRateLimited('search:cancel');
          socket.emit('error', { message: 'Too many requests' });
          return;
        }
        const startTime = Date.now();
        wsLogger.event('search_cancel', userId, socket.id);
        
        this.handleSearchCancel(socket).then(() => {
          const duration = Date.now() - startTime;
          metricsCollector.messageProcessed(duration);
          metricsCollector.searchCompleted(false);
        }).catch(error => {
          metricsCollector.errorOccurred(error as Error);
          wsLogger.error(userId, socket.id, error as Error, { event: 'search_cancel' });
        });
      });

      // Обработчики чатов с сохранением комнат
      socket.on('chat:join', async (chatId) => {
        try {
          const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
          if (!chatId || !isObjectId(chatId)) {
            socket.emit('error', { message: 'Invalid chatId' });
            return;
          }

          // Проверяем, что пользователь действительно участник чата
          const chat = await Chat.findById(chatId).select('participants isActive');
          if (!chat || !chat.isActive) {
            socket.emit('error', { message: 'Chat not found or inactive' });
            return;
          }
          const isParticipant = chat.participants.some((p) => p.toString() === userId);
          if (!isParticipant) {
            socket.emit('error', { message: 'Forbidden: not a participant of this chat' });
            return;
          }

          const roomName = `chat:${chatId}`;
          socket.join(roomName);
          this.userRooms.get(userId)?.add(roomName);
          wsLogger.event('chat_join', userId, socket.id, { chatId });

          const otherParticipant = chat.participants.find((p) => p.toString() !== userId)?.toString();
          if (otherParticipant) {
            if (this.userSockets.has(otherParticipant)) {
              // Оба онлайн → снимаем grace-таймер и уведомляем партнёра.
              this.disarmChatEndTimer(chatId);
              this.sendToUser(otherParticipant, 'chat:partner_status', { chatId, userId, status: 'online' });
              wsLogger.info('chat_end_timer_cleared_on_join', `Both online for chat ${chatId} after join by ${userId}`, { userId, chatId });
              // Свежий матч: оба в комнате и сообщений ещё нет → стартовый айсбрейкер
              this.maybeSendStartIcebreaker(chatId, [userId, otherParticipant]).catch((e) =>
                wsLogger.error('icebreaker_start_on_join', userId, e as Error, { chatId })
              );
            } else if (AICompanionService.isPersona(otherParticipant)) {
              // Партнёр — ИИ-персона: всегда «онлайн», чат НЕ завершаем по таймеру.
              this.disarmChatEndTimer(chatId);
              this.sendToUser(userId, 'chat:partner_status', { chatId, userId: otherParticipant, status: 'online' });
            } else {
              // Партнёр оффлайн → НЕ снимаем его grace, держим/обновляем таймер на обоих.
              this.armChatEndTimer(chatId, [userId, otherParticipant]);
            }
          } else {
            this.disarmChatEndTimer(chatId);
          }
        } catch (error) {
          wsLogger.error('chat_join_handler', userId, error as Error, { chatId });
          socket.emit('error', { message: 'Failed to join chat' });
        }
      });
      
      socket.on('chat:leave', (chatId) => {
        const roomName = `chat:${chatId}`;
        socket.leave(roomName);
        this.userRooms.get(userId)?.delete(roomName);
        wsLogger.event('chat_leave', userId, socket.id, { chatId });
      });

      socket.on('chat:message', (data) => {
        if (!this.wsRateAllow(userId)) {
          metricsCollector.wsRateLimited('chat:message');
          socket.emit('error', { message: 'Too many requests' });
          return;
        }
        const parsed = chatMessageSchema.safeParse(data);
        if (!parsed.success) {
          metricsCollector.wsValidationFailed('chat:message');
          socket.emit('error', { message: 'Invalid payload' });
          return;
        }
        const startTime = Date.now();
        wsLogger.event('chat_message', userId, socket.id, { chatId: data.chatId });
        this.handleChatMessage(socket, data).then(() => {
          const duration = Date.now() - startTime;
          metricsCollector.messageProcessed(duration);

          // Фактическое сообщение уже разослано всем участникам комнаты в ChatService;
          // дополнительный пустой эмит отправителю не нужен (создавал пустой пузырь на клиенте).
        }).catch(error => {
          metricsCollector.errorOccurred(error as Error);
          wsLogger.error(userId, socket.id, error as Error, { 
            event: 'chat_message', 
            chatId: data.chatId 
          });
        });
      });

      socket.on('chat:start_typing', (data) => {
        if (!this.wsRateAllow(userId)) { metricsCollector.wsRateLimited('chat:start_typing'); return; }
        // допустим только формат с корректным chatId
        const ok = typeof data?.chatId === 'string' && /^[a-f\d]{24}$/i.test(data.chatId);
        if (!ok) return;
        // mode: 'voice' → собеседник видит «записывает голосовое…» (иначе обычное «печатает»)
        const mode = (data as { mode?: string })?.mode === 'voice' ? 'voice' as const : undefined;
        wsLogger.event('chat_start_typing', userId, socket.id, { chatId: data.chatId, mode });
        this.handleChatStartTyping(socket, data.chatId, mode);
      });

      socket.on('chat:stop_typing', (data) => {
        if (!this.wsRateAllow(userId)) { metricsCollector.wsRateLimited('chat:stop_typing'); return; }
        const ok = typeof data?.chatId === 'string' && /^[a-f\d]{24}$/i.test(data.chatId);
        if (!ok) return;
        wsLogger.event('chat_stop_typing', userId, socket.id, { chatId: data.chatId });
        this.handleChatStopTyping(socket, data.chatId);
      });

      // Ручной запрос темы/вопроса для оживления диалога
      socket.on('chat:suggest_topic', (data) => {
        if (!this.wsRateAllow(userId)) { metricsCollector.wsRateLimited('chat:suggest_topic'); return; }
        const ok = typeof data?.chatId === 'string' && /^[a-f\d]{24}$/i.test(data.chatId);
        if (!ok) return;
        this.handleSuggestTopic(socket, data.chatId).catch((error) => {
          wsLogger.error(userId, socket.id, error as Error, { event: 'chat_suggest_topic', chatId: data.chatId });
        });
      });

      socket.on('chat:read', (data) => {
        if (!this.wsRateAllow(userId)) { metricsCollector.wsRateLimited('chat:read'); return; }
        const parsed = chatReadSchema.safeParse(data);
        if (!parsed.success) { metricsCollector.wsValidationFailed('chat:read'); return; }
        wsLogger.event('chat_read', userId, socket.id, { chatId: data.chatId });
        this.handleChatRead(socket, data).catch(error => {
          wsLogger.error(userId, socket.id, error as Error, { event: 'chat_read', chatId: data.chatId });
        });
      });

      // Новый обработчик завершения чата
      socket.on('chat:end', async (data) => {
        if (!this.wsRateAllow(userId)) {
          metricsCollector.wsRateLimited('chat:end');
          socket.emit('error', { message: 'Too many requests' });
          return;
        }
        const parsed = chatEndSchema.safeParse(data);
        if (!parsed.success) {
          metricsCollector.wsValidationFailed('chat:end');
          socket.emit('error', { message: 'Invalid payload' });
          return;
        }
        const startTime = Date.now();
        wsLogger.event('chat_end', userId, socket.id, { 
          chatId: data.chatId,
          reason: data.reason 
        });

        try {
          await ChatService.endChat(data.chatId, userId, data.reason);
          const duration = Date.now() - startTime;
          metricsCollector.messageProcessed(duration);

          // Очистку комнаты и локального состояния выполняем централизованно в ChatService.endChat
        } catch (error) {
          metricsCollector.errorOccurred(error as Error);
          wsLogger.error(userId, socket.id, error as Error, { 
            event: 'chat_end', 
            chatId: data.chatId 
          });
          socket.emit('error', { message: 'Failed to end chat' });
        }
      });

      // Новый обработчик оценки чата
      socket.on('chat:rate', async (data) => {
        if (!this.wsRateAllow(userId)) {
          metricsCollector.wsRateLimited('chat:rate');
          socket.emit('error', { message: 'Too many requests' });
          return;
        }
        const parsed = chatRateSchema.safeParse(data);
        if (!parsed.success) {
          metricsCollector.wsValidationFailed('chat:rate');
          socket.emit('error', { message: 'Invalid payload' });
          return;
        }
        const startTime = Date.now();
        wsLogger.event('chat_rate', userId, socket.id, { 
          chatId: data.chatId,
          score: data.score 
        });

        try {
          await RatingService.rateUser(
            data.chatId,
            userId,
            data.score,
            data.comment
          );
          const duration = Date.now() - startTime;
          metricsCollector.messageProcessed(duration);
        } catch (error) {
          metricsCollector.errorOccurred(error as Error);
          wsLogger.error(userId, socket.id, error as Error, { 
            event: 'chat_rate', 
            chatId: data.chatId 
          });
          socket.emit('error', { message: 'Failed to rate chat' });
        }
      });

      // Жалоба на собеседника в активном чате
      socket.on('chat:report', async (data) => {
        if (!this.wsRateAllow(userId)) {
          metricsCollector.wsRateLimited('chat:report');
          socket.emit('error', { message: 'Too many requests' });
          return;
        }
        try {
          const chatId = String((data as any)?.chatId || '');
          const reason = (data as any)?.reason;
          const comment = (data as any)?.comment;
          const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
          if (!chatId || !isObjectId(chatId)) {
            wsLogger.error('chat_report_invalid', userId, new Error('Invalid chatId'), { chatId, reason });
            socket.emit('error', { message: 'Invalid chatId' });
            return;
          }
          if (!['spam', 'insult', 'scam', 'sexual', 'illegal', 'other'].includes(reason)) {
            wsLogger.error('chat_report_invalid', userId, new Error('Invalid reason'), { chatId, reason });
            socket.emit('error', { message: 'Invalid reason' });
            return;
          }
          const chat = await Chat.findById(chatId).select('participants isActive');
          if (!chat || !chat.isActive) {
            wsLogger.error('chat_report_chat_missing', userId, new Error('Chat not found or inactive'), { chatId, reason });
            socket.emit('error', { message: 'Chat not found or inactive' });
            return;
          }
          const isParticipant = chat.participants.some((p) => p.toString() === userId);
          if (!isParticipant) {
            wsLogger.error('chat_report_forbidden', userId, new Error('Not participant'), { chatId, reason });
            socket.emit('error', { message: 'Forbidden' });
            return;
          }
          const reportedUserId = chat.participants.find((p) => p.toString() !== userId)?.toString();
          if (!reportedUserId) {
            wsLogger.error('chat_report_no_reported', userId, new Error('Reported user not found'), { chatId, reason });
            socket.emit('error', { message: 'Reported user not found' });
            return;
          }
          wsLogger.info('chat_report_attempt', `Report attempt by ${userId}`, { chatId, reason, comment, socketId: socket.id });
          const report = await Report.create({
            reporterUserId: new mongoose.Types.ObjectId(userId),
            reportedUserId: new mongoose.Types.ObjectId(reportedUserId),
            chatId: new mongoose.Types.ObjectId(chatId),
            reason,
            comment,
            status: 'open'
          } as any);
          metricsCollector.reportSubmitted(reason);
          wsLogger.info('chat_report_created', `Report created by ${userId}`, { chatId, reason, reportId: report._id?.toString(), socketId: socket.id });
          socket.emit('report:submitted', { chatId, reportId: report._id?.toString() });
          // Обратная совместимость: ранее фронт слушал error
          socket.emit('error', { message: 'Report submitted' });
        } catch (error) {
          // Дубль жалобы (тот же reporter/chat/reason) — это не ошибка, а анти-флуд.
          if ((error as { code?: number })?.code === 11000) {
            socket.emit('report:submitted', { chatId: String((data as any)?.chatId || '') });
            socket.emit('error', { message: 'Report already submitted' });
            return;
          }
          metricsCollector.reportErrored((data as any)?.reason || 'unknown');
          wsLogger.error('chat_report_failed', userId, error as Error, { payload: data });
          socket.emit('error', { message: 'Failed to submit report' });
        }
      });

      // ── Мини-игры ────────────────────────────────────────────────────────────
      // Приглашение: проверяем участие в чате (DB) один раз, заводим сессию.
      socket.on('game:invite', async (data) => {
        try {
          if (!this.wsRateAllow(userId)) { socket.emit('error', { message: 'Too many requests' }); return; }
          const chatId = String((data as any)?.chatId || '');
          const gameId = String((data as any)?.gameId || '');
          if (!/^[a-f\d]{24}$/i.test(chatId)) { socket.emit('error', { message: 'Invalid chatId' }); return; }
          const chat = await Chat.findById(chatId).select('participants isActive');
          if (!chat || !chat.isActive || !chat.participants.some((p) => p.toString() === userId)) {
            socket.emit('error', { message: 'Forbidden' }); return;
          }
          const players = chat.participants.map((p) => p.toString()) as [string, string];
          // Приватность получателя: запрет на приглашения в игры (кнопка у
          // отправителя скрыта по acceptsGames, но сервер — источник истины)
          const inviteeId = players.find((p) => p !== userId);
          if (inviteeId) {
            const invitee = await User.findById(inviteeId).select('preferences.acceptGames').lean();
            if ((invitee as { preferences?: { acceptGames?: boolean } } | null)?.preferences?.acceptGames === false) {
              socket.emit('error', { message: 'Собеседник отключил приглашения в игры' });
              // Сбрасываем «Ждём ответа…» у приглашающего
              this.sendToUser(userId, 'game:end', { reason: 'declined' });
              return;
            }
          }
          this.dispatchGameEvents(gameManager.invite(chatId, userId, gameId, players));
        } catch (e) {
          wsLogger.error('game_invite', userId, e as Error);
        }
      });
      socket.on('game:respond', (data) => {
        try {
          this.dispatchGameEvents(gameManager.respond(String((data as any)?.chatId || ''), userId, Boolean((data as any)?.accept)));
        } catch (e) { wsLogger.error('game_respond', userId, e as Error); }
      });
      socket.on('game:event', (data) => {
        try {
          // draw/guess/clear/skip — авторизация по in-memory сессии (без DB на каждый штрих)
          this.dispatchGameEvents(gameManager.event(String((data as any)?.chatId || ''), userId, String((data as any)?.type || ''), (data as any)?.payload));
        } catch (e) { wsLogger.error('game_event', userId, e as Error); }
      });
      socket.on('game:leave', (data) => {
        try {
          this.dispatchGameEvents(gameManager.leave(String((data as any)?.chatId || ''), userId));
        } catch (e) { wsLogger.error('game_leave', userId, e as Error); }
      });

      // Обработчики контактов
      socket.on('contact:request', (data) => {
        if (!this.wsRateAllow(userId)) { metricsCollector.wsRateLimited('contact:request'); return; }
        this.handleContactRequest(socket, data);
      });
      socket.on('contact:respond', (data) => {
        if (!this.wsRateAllow(userId)) { metricsCollector.wsRateLimited('contact:respond'); return; }
        this.handleContactResponse(socket, data);
      });

      // Обработчики блокировок
      socket.on('user:block', async (data) => {
        try {
          const targetId = String((data as any)?.userId || '');
          const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
          if (!isObjectId(targetId)) {
            socket.emit('error', { message: 'Invalid userId' });
            return;
          }
          await BlockService.blockUser(userId, targetId, (data as any)?.reason, (data as any)?.expiresAt ? new Date((data as any).expiresAt) : undefined);
          this.sendToUser(userId, 'user:blocked', { userId: targetId });

          // Если между пользователями есть активный чат — завершаем его
          try {
            const activeChat = await Chat.findOne({
              participants: { $all: [new mongoose.Types.ObjectId(userId), new mongoose.Types.ObjectId(targetId)] },
              isActive: true
            }).select('_id');
            if (activeChat && activeChat._id) {
              await ChatService.endChat(activeChat._id.toString(), userId, 'blocked');
            }
          } catch (endError) {
            wsLogger.warn('chat_end_on_block_failed', (endError as Error).message, { userId, targetId });
          }
        } catch (error) {
          wsLogger.error('user_block_failed', userId, error as Error, { payload: data });
          socket.emit('error', { message: 'Failed to block user' });
        }
      });

      socket.on('user:unblock', async (data) => {
        try {
          const targetId = String((data as any)?.userId || '');
          const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
          if (!isObjectId(targetId)) {
            socket.emit('error', { message: 'Invalid userId' });
            return;
          }
          await BlockService.unblockUser(userId, targetId);
          this.sendToUser(userId, 'user:unblocked', { userId: targetId });
        } catch (error) {
          wsLogger.error('user_unblock_failed', userId, error as Error, { payload: data });
          socket.emit('error', { message: 'Failed to unblock user' });
        }
      });

      // Обработка отключения
      socket.on('disconnect', (reason) => {
        // Очищаем интервал обновления активности
        clearInterval(activityInterval);

        const duration = Date.now() - connectionStart;
        metricsCollector.connectionClosed();
        
        this.userSockets.get(userId)?.delete(socket.id);
        
        // Если это последний сокет пользователя
        if (!this.userSockets.get(userId)?.size) {
          this.userSockets.delete(userId);
          
          this.handleFullDisconnect(userId, reason, duration);
        }

        wsLogger.disconnection(userId, socket.id, reason, {
          duration,
          remainingSockets: this.userSockets.get(userId)?.size || 0
        });

        // Аналитика: ws_disconnect
        AnalyticsEvent.create({
          userId: new mongoose.Types.ObjectId(userId),
          telegramId: String(socket.data.user.telegramId),
          name: 'ws_disconnect',
          props: { reason: mapDisconnectReason(reason), durationMs: duration },
          userAgent: String((socket.handshake.headers as any)['user-agent'] || ''),
          ip: String((socket.handshake.address || ''))
        } as any).catch((err: unknown) => {
          try { wsLogger.warn('ws_disconnect_analytics_fail', String(err)); } catch {}
        });
      });
    });
  }

  private async handlePostConnectPresence(socket: TypedSocket) {
    const userId = socket.data.user._id.toString();
    try {
      const activeChat = await Chat.findOne({ participants: new mongoose.Types.ObjectId(userId), isActive: true });
      if (!activeChat) return;

      const chatId = activeChat._id.toString();
      const otherParticipant = activeChat.participants.find(p => p.toString() !== userId)?.toString();
      if (!otherParticipant) return;

      // Авто-присоединяем текущий сокет к комнате активного чата, чтобы гарантировать доставку событий
      const roomName = `chat:${chatId}`;
      try {
        socket.join(roomName);
        this.userRooms.get(userId)?.add(roomName);
        wsLogger.event('chat_auto_join_on_connect', userId, socket.id, { chatId });
      } catch (joinError) {
        wsLogger.warn('chat_auto_join_on_connect_failed', (joinError as Error).message, { userId, chatId });
      }

      if (this.userSockets.has(otherParticipant)) {
        // Оба онлайн → снимаем grace-таймер и сообщаем партнёру, что пользователь вернулся.
        this.disarmChatEndTimer(chatId);
        this.sendToUser(otherParticipant, 'chat:partner_status', {
          chatId,
          userId,
          status: 'online',
          serverNow: new Date().toISOString()
        });
        wsLogger.info('chat_end_timer_cleared_on_connect', `Both online for chat ${chatId} after user ${userId} connected`, { userId, chatId });
      } else if (AICompanionService.isPersona(otherParticipant)) {
        // Партнёр — ИИ-персона: всегда «онлайн», не завершаем чат и показываем её онлайн.
        this.disarmChatEndTimer(chatId);
        this.sendToUser(userId, 'chat:partner_status', {
          chatId, userId: otherParticipant, status: 'online', serverNow: new Date().toISOString(),
        });
      } else {
        // Партнёр всё ещё оффлайн → (пере)ставим grace-таймер на ОБОИХ участников и
        // отдаём корректный отсчёт текущему пользователю (раньше тут терялся deadline,
        // а реконнект ошибочно снимал таймер партнёра).
        const expiresAt = this.armChatEndTimer(chatId, [userId, otherParticipant]);
        this.sendToUser(userId, 'chat:partner_status', {
          chatId,
          userId: otherParticipant,
          status: 'offline',
          reconnectExpiresAt: new Date(expiresAt).toISOString(),
          serverNow: new Date().toISOString(),
          reason: 'unknown'
        });
      }
    } catch (error) {
      wsLogger.error('post_connect_presence', userId, error as Error);
    }
  }

  private async handleReconnection(socket: TypedSocket) {
    const userId = socket.data.user._id.toString();

    // Восстанавливаем комнаты
    const rooms = this.userRooms.get(userId);
    if (rooms) {
      rooms.forEach(room => {
        socket.join(room);
        wsLogger.event('room_rejoin', userId, socket.id, { room });
      });
    }

    // Очищаем таймер отмены поиска, если пользователь переподключился
    const cancelTimeout = pendingSearchCancellations.get(userId);
    if (cancelTimeout) {
      clearTimeout(cancelTimeout);
      pendingSearchCancellations.delete(userId);
      wsLogger.info('search_cancel_timer_cleared', `Cleared search cancellation timer for user ${userId}`, { userId });
    }

    // Проверяем, был ли пользователь в чате, и отменяем его завершение
    try {
      const activeChat = await Chat.findOne({ participants: new mongoose.Types.ObjectId(userId), isActive: true });
      if (activeChat) {
        const chatId = activeChat._id.toString();
        const endTimer = pendingChatEndTimers.get(chatId);
        if (endTimer) {
          clearTimeout(endTimer);
          pendingChatEndTimers.delete(chatId);
          pendingChatEndDeadlines.delete(chatId);
          wsLogger.info('chat_end_timer_cleared', `Cleared chat end timer for user ${userId} in chat ${chatId}`, { userId, chatId });
          
          // Уведомляем другого участника, что пользователь вернулся
          const otherParticipant = activeChat.participants.find(p => p.toString() !== userId);
          if (otherParticipant) {
            this.sendToUser(otherParticipant.toString(), 'chat:partner_status', {
              chatId,
              userId,
              status: 'online',
              serverNow: new Date().toISOString()
            });
          }
        }
      }
    } catch (error) {
      wsLogger.error('reconnection_chat_check', userId, error as Error);
    }
    
    socket.emit('connection:recovered');
  }

  /**
   * Ставит/обновляет grace-таймер чата. Чистит существующий (без таймеров-сирот),
   * и при срабатывании завершает чат, если ХОТЯ БЫ ОДИН участник всё ещё оффлайн
   * (надёжно при дисконнекте обоих и независимо от того, кто поставил таймер).
   */
  private armChatEndTimer(chatId: string, participants: string[]): number {
    const existing = pendingChatEndTimers.get(chatId);
    if (existing) clearTimeout(existing);
    const expiresAt = Date.now() + CHAT_GRACE_MS;
    pendingChatEndDeadlines.set(chatId, expiresAt);
    const timeout = setTimeout(async () => {
      pendingChatEndTimers.delete(chatId);
      pendingChatEndDeadlines.delete(chatId);
      // ИИ-персона всегда «онлайн» (у неё нет сокета) — не завершаем чат из-за неё
      const offline = participants.filter((p) => !this.userSockets.has(p) && !AICompanionService.isPersona(p));
      if (offline.length > 0) {
        try {
          await ChatService.endChat(chatId, offline[0], 'partner_disconnected');
        } catch (error) {
          wsLogger.error('chat_end_on_timeout_error', offline[0], error as Error, { chatId });
        }
      }
    }, CHAT_GRACE_MS);
    pendingChatEndTimers.set(chatId, timeout);
    return expiresAt;
  }

  /** Снимает grace-таймер чата (оба участника снова онлайн). */
  private disarmChatEndTimer(chatId: string): void {
    const existing = pendingChatEndTimers.get(chatId);
    if (existing) clearTimeout(existing);
    pendingChatEndTimers.delete(chatId);
    pendingChatEndDeadlines.delete(chatId);
  }

  private async handleFullDisconnect(userId: string, reason: string, duration: number) {
    // Пользователь ушёл не попрощавшись (без chat:stop_typing) — снимаем его
    // из typing-наборов, иначе idle-айсбрейкеры чата заглохнут навсегда
    for (const [icChatId, st] of this.icebreakerState) {
      if (st.typing.delete(userId) && st.typing.size === 0) {
        this.armIcebreakerIdleTimer(icChatId);
      }
    }

    // Отключился во время ожидания — снимаем таймер ИИ-собеседника
    this.clearAiMatch(userId);
    // #8: чистим rate-bucket отключившегося (иначе Map растёт на каждый userId)
    this.wsRateBuckets.delete(userId);

    // Логика отмены поиска
    SearchService.getUserActiveSearch(userId).then(activeSearch => {
      if (activeSearch && activeSearch.status === 'searching') {
        wsLogger.info('search_disconnect_detected', 'User in search disconnected', { userId, searchId: activeSearch._id?.toString(), reason, duration });
        const searchCancelTimeout = setTimeout(async () => {
          pendingSearchCancellations.delete(userId); // #13: не оставляем отработавший таймер в Map
          if (!this.userSockets.has(userId)) {
            try {
              const currentSearch = await SearchService.getUserActiveSearch(userId);
              if (currentSearch && currentSearch.status === 'searching') {
                await SearchService.cancelSearch(userId, 'disconnect');
                wsLogger.info('search_auto_cancelled', 'Search automatically cancelled after timeout', { userId, searchId: currentSearch._id?.toString() });
              }
            } catch (error) {
              wsLogger.error('search_auto_cancel_error', userId, error as Error);
            }
          }
        }, 45000); // Грейс 45 сек: переживаем обрыв/перезагрузку сети, поиск не теряется
        pendingSearchCancellations.set(userId, searchCancelTimeout);
      }
    }).catch(error => {
      wsLogger.error('get_active_search_error', userId, error as Error);
    });

    // Новая логика завершения активного чата с таймаутом
    Chat.findOne({ participants: new mongoose.Types.ObjectId(userId), isActive: true }).then(activeChat => {
      if (activeChat) {
        const chatId = activeChat._id.toString();
        const otherParticipantId = activeChat.participants.find(p => p.toString() !== userId)?.toString();
        
        if (otherParticipantId) {
          // Ставим единый grace-таймер на ОБОИХ участников (чистит сироты, при срабатывании
          // завершает чат, если хотя бы один всё ещё оффлайн) и уведомляем партнёра.
          const expiresAt = this.armChatEndTimer(chatId, [userId, otherParticipantId]);
          this.sendToUser(otherParticipantId, 'chat:partner_status', {
            chatId,
            userId,
            status: 'offline',
            reconnectExpiresAt: new Date(expiresAt).toISOString(),
            serverNow: new Date().toISOString(),
            reason: mapDisconnectReason(reason)
          });
          wsLogger.info('chat_disconnect_detected', `User ${userId} disconnected from active chat ${chatId}. Starting ${CHAT_GRACE_MS}ms end timer.`, { userId, chatId, otherParticipantId });
        }
      }
    }).catch(error => {
      wsLogger.error('find_active_chat_on_disconnect_error', userId, error as Error);
    });
    
    // Обновляем статус активности: помечаем оффлайн, чтобы не держать "зависших" при полном дисконнекте
    User.findByIdAndUpdate(userId, {
      isOnline: false,
      lastActive: new Date()
    }).then(() => {
      SearchService.broadcastSearchStats().catch((error: unknown) => {
        wsLogger.error('update_stats_on_disconnect', userId, error as Error);
      });
    }).catch((error: unknown) => {
      wsLogger.error('update_activity_on_disconnect', userId, error as Error);
    });
    
    // При полном отключении сохраняем состояние на 2 минуты
    setTimeout(() => {
      if (!this.userSockets.has(userId)) {
        this.userRooms.delete(userId);
      }
    }, 2 * 60 * 1000);
  }

  // Методы для отправки событий конкретному пользователю
  public sendToUser<E extends keyof ServerToClientEvents>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ) {
    const userSocketIds = this.userSockets.get(userId);
    if (userSocketIds) {
      userSocketIds.forEach(socketId => {
        this.io.to(socketId).emit(event, ...args);
      });
    }
  }

  /** Рассылка адресных игровых событий (из GameManager) по сокетам пользователей. */
  private dispatchGameEvents(events: OutEvent[]): void {
    for (const e of events) {
      this.sendToUser(e.toUserId, e.event as keyof ServerToClientEvents, e.data as never);
    }
  }

  // Принудительное отключение всех сокетов пользователя (после logout/logoutAll)
  public async disconnectUser(userId: string) {
    const userSocketIds = this.userSockets.get(userId);
    if (userSocketIds && userSocketIds.size) {
      userSocketIds.forEach((socketId) => {
        try {
          this.io.sockets.sockets.get(socketId)?.disconnect(true);
        } catch {}
      });
      this.userSockets.delete(userId);
    }
  }

  // ===== Айсбрейкеры (оживление диалога) =====

  private getIcebreakerState(chatId: string) {
    let st = this.icebreakerState.get(chatId);
    if (!st) {
      st = { typing: new Set<string>(), eligible: false, lastManualAt: 0 };
      this.icebreakerState.set(chatId, st);
    }
    return st;
  }

  // Участники чата, реально находящиеся в комнате (открыт экран чата)
  private participantUserIdsInRoom(chatId: string): Set<string> {
    const result = new Set<string>();
    const room = this.io.sockets.adapter.rooms.get(`chat:${chatId}`);
    if (!room) return result;
    for (const socketId of room) {
      const s = this.io.sockets.sockets.get(socketId);
      const uid = s?.data?.user?._id?.toString();
      if (uid) result.add(uid);
    }
    return result;
  }

  /**
   * Вызывается из ChatService после каждого живого сообщения: сообщение
   * делает чат «eligible» для авто-подсказки и перезапускает таймер тишины.
   */
  public noteChatMessage(chatId: string, userId: string): void {
    const st = this.getIcebreakerState(chatId);
    st.typing.delete(userId);
    st.eligible = true;
    this.armIcebreakerIdleTimer(chatId);
  }

  private noteTypingStart(chatId: string, userId: string): void {
    const st = this.icebreakerState.get(chatId);
    if (!st) return;
    st.typing.add(userId);
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
  }

  private noteTypingStop(chatId: string, userId: string): void {
    const st = this.icebreakerState.get(chatId);
    if (!st) return;
    st.typing.delete(userId);
    if (st.typing.size === 0) {
      this.armIcebreakerIdleTimer(chatId);
    }
  }

  private armIcebreakerIdleTimer(chatId: string): void {
    const st = this.getIcebreakerState(chatId);
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
    if (!st.eligible || st.typing.size > 0) return;
    st.timer = setTimeout(() => {
      st.timer = undefined;
      this.fireIdleIcebreaker(chatId).catch((e) =>
        wsLogger.error('icebreaker_idle_fire', 'system', e as Error, { chatId })
      );
    }, config.openai.icebreakerIdleMs);
  }

  private async fireIdleIcebreaker(chatId: string): Promise<void> {
    const st = this.icebreakerState.get(chatId);
    if (!st || !st.eligible || st.typing.size > 0) return;
    // Подсказка имеет смысл, только когда оба собеседника в чате
    const chat = await Chat.findById(chatId).select('participants isActive');
    if (!chat || !chat.isActive) return;
    const inRoom = this.participantUserIdsInRoom(chatId);
    const bothPresent = chat.participants.every((p) => inRoom.has(p.toString()));
    if (!bothPresent) return; // eligibility сохраняем — сработает при следующей активности
    st.eligible = false;
    const sent = await IcebreakerService.sendIcebreaker(chatId, 'idle');
    if (!sent) st.eligible = true;
  }

  // Стартовый айсбрейкер: оба участника зашли в комнату, сообщений ещё нет
  private async maybeSendStartIcebreaker(chatId: string, participants: string[]): Promise<void> {
    if (this.icebreakerStartSent.has(chatId)) return;
    const inRoom = this.participantUserIdsInRoom(chatId);
    if (!participants.every((p) => inRoom.has(p))) return;
    this.icebreakerStartSent.add(chatId);
    try {
      if (await IcebreakerService.chatHasMessages(chatId)) return;
      await IcebreakerService.sendIcebreaker(chatId, 'start');
    } catch (error) {
      wsLogger.error('icebreaker_start', 'system', error as Error, { chatId });
    }
  }

  private async handleSuggestTopic(socket: TypedSocket, chatId: string): Promise<void> {
    const userId = socket.data.user._id.toString();
    const chat = await Chat.findById(chatId).select('participants isActive');
    if (!chat || !chat.isActive) {
      socket.emit('error', { message: 'Chat not found or inactive' });
      return;
    }
    if (!chat.participants.some((p) => p.toString() === userId)) {
      socket.emit('error', { message: 'Forbidden: not a participant of this chat' });
      return;
    }
    // Полная блокировка Купидона любым из участников — кнопка не работает
    const cupidBlocked = await User.exists({
      _id: { $in: chat.participants },
      'preferences.acceptCupid': false,
    });
    if (cupidBlocked) {
      socket.emit('error', { message: 'Купидон отключён в этом чате' });
      return;
    }

    const st = this.getIcebreakerState(chatId);
    if (Date.now() - st.lastManualAt < config.openai.icebreakerManualCooldownMs) {
      socket.emit('error', { message: 'Подсказка уже недавно была — подождите немного 😉' });
      return;
    }
    wsLogger.event('chat_suggest_topic', userId, socket.id, { chatId });
    // Метку кулдауна ставим ТОЛЬКО при успехе: параллельные запросы отсекает
    // inFlight-замок в IcebreakerService, а «проигравший» раньше обнулял
    // кулдаун только что выданной подсказки (гонка)
    const sent = await IcebreakerService.sendIcebreaker(chatId, 'manual');
    if (sent) {
      st.lastManualAt = Date.now();
      // Свежая подсказка уже в чате — авто-таймер не нужен до нового сообщения
      st.eligible = false;
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = undefined;
      }
    }
  }

  private cleanupIcebreakerState(chatId: string): void {
    const st = this.icebreakerState.get(chatId);
    if (st?.timer) clearTimeout(st.timer);
    this.icebreakerState.delete(chatId);
    this.icebreakerStartSent.delete(chatId);
    IcebreakerService.forgetChat(chatId);
    AICompanionService.forgetChat(chatId);
  }

  // Очистка комнаты чата и локального состояния после завершения
  public cleanupChatRoom(chatId: string, participantIds?: string[]) {
    try {
      const roomName = `chat:${chatId}`;

      // Сбрасываем таймер завершения, если есть
      const timer = pendingChatEndTimers.get(chatId);
      if (timer) {
        clearTimeout(timer);
        pendingChatEndTimers.delete(chatId);
      }
      pendingChatEndDeadlines.delete(chatId);
      wsLogger.info('chat_end_timer_cleared_on_cleanup', `Cleared chat end timer for chat ${chatId} during cleanup`, { chatId });

      // Сбрасываем состояние айсбрейкеров
      this.cleanupIcebreakerState(chatId);

      // Выводим всех сокетов из комнаты
      this.io.in(roomName).socketsLeave(roomName);

      // Чистим локальные userRooms для участников (если переданы)
      if (participantIds && participantIds.length > 0) {
        participantIds.forEach((pid) => {
          this.userRooms.get(pid)?.delete(roomName);
        });
      } else {
        // Если участников не передали — очищаем у всех где встречается
        this.userRooms.forEach((rooms) => rooms.delete(roomName));
      }
    } catch (error) {
      wsLogger.warn('cleanup_chat_room', (error as Error).message, { chatId });
    }
  }

  private async handleChatMessage(socket: TypedSocket, data: { chatId: string; content: string; replyTo?: string }) {
    try {
      // Валидация payload
      const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
      if (!data || typeof data !== 'object') {
        socket.emit('error', { message: 'Invalid payload' });
        return;
      }
      if (!data.chatId || !isObjectId(data.chatId)) {
        socket.emit('error', { message: 'Invalid chatId' });
        return;
      }
      if (typeof data.content !== 'string' || data.content.trim().length === 0) {
        socket.emit('error', { message: 'Message cannot be empty' });
        return;
      }
      if (data.content.length > 2000) {
        socket.emit('error', { message: 'Message too long' });
        return;
      }
      if (data.replyTo && !isObjectId(data.replyTo)) {
        socket.emit('error', { message: 'Invalid replyTo id' });
        return;
      }
      await this.chatCircuitBreaker.execute(
        async () => {
          const userId = socket.data.user._id.toString();
          await ChatService.sendMessage(
            data.chatId,
            userId,
            data.content,
            data.replyTo
          );
          // After sending message, broadcast stop_typing to others
          socket.to(`chat:${data.chatId}`).emit('chat:stop_typing', {
            chatId: data.chatId,
            userId: userId,
          });
          wsLogger.info('auto_stop_typing', `Sent stop_typing for user ${userId} in chat ${data.chatId} after message`, {
              chatId: data.chatId,
              userId: userId
          });
        },
        async () => {
          // Fallback: сохраняем сообщение локально и пытаемся отправить позже
          socket.emit('error', { 
            message: 'Message queued for delivery due to service degradation'
          });
          // TODO: Добавить механизм очереди сообщений
        }
      );
    } catch (error) {
      socket.emit('error', { message: 'Failed to send message' });
    }
  }

  private async handleChatStartTyping(socket: TypedSocket, chatId: string, mode?: 'voice') {
    const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
    if (!chatId || !isObjectId(chatId)) {
      socket.emit('error', { message: 'Invalid chatId' });
      return;
    }
    const userId = socket.data.user._id.toString();
    // Запись голосового — тоже «активность»: idle-таймер Купидона ставится на паузу
    this.noteTypingStart(chatId, userId);
    socket.to(`chat:${chatId}`).emit('chat:start_typing', {
      chatId,
      userId: userId,
      ...(mode ? { mode } : {}),
    });
  }

  private async handleChatStopTyping(socket: TypedSocket, chatId: string) {
    const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
    if (!chatId || !isObjectId(chatId)) {
      socket.emit('error', { message: 'Invalid chatId' });
      return;
    }
    const userId = socket.data.user._id.toString();
    this.noteTypingStop(chatId, userId);
    socket.to(`chat:${chatId}`).emit('chat:stop_typing', {
      chatId,
      userId: userId,
    });
  }

  private async handleChatRead(socket: TypedSocket, data: { chatId: string; timestamp: Date }) {
    try {
      const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
      if (!data || !isObjectId(data.chatId)) {
        socket.emit('error', { message: 'Invalid chatId' });
        return;
      }
      const ts = new Date(data.timestamp);
      if (isNaN(ts.getTime())) {
        socket.emit('error', { message: 'Invalid timestamp' });
        return;
      }
      await ChatService.markAsRead(
        data.chatId,
        socket.data.user._id.toString(),
        ts
      );
    } catch (error) {
      socket.emit('error', { message: 'Failed to mark messages as read' });
    }
  }

  private async handleSearchStart(socket: TypedSocket, data: { criteria: SearchCriteria }) {
    const userId = socket.data.user._id.toString();
    wsLogger.info('handle_search_start', `Handling search start for user ${userId}`, { userId });

    // Проверяем Circuit Breaker
    if (this.searchCircuitBreaker.getState() === 'OPEN') {
      wsLogger.warn('circuit_open', `Search rejected for user ${userId} because circuit breaker is open`, {
        userId,
        state: this.searchCircuitBreaker.getState()
      });

      this.sendToUser(userId, 'search:error', {
        message: 'Search service is temporarily unavailable. Please try again later.'
      });
      return;
    }

    wsLogger.info('pre_search_service_call', `Circuit breaker is closed. Calling SearchService.startSearch for user ${userId}.`, { userId });

    try {
      // Минимальная валидация критериев
      const c = data?.criteria as any;
      const isGender = (g: any) => g === 'male' || g === 'female';
      const isDesiredGender = (arr: any) => Array.isArray(arr) && arr.every((g) => g === 'male' || g === 'female' || g === 'any');
      if (!c || !isGender(c.gender) || typeof c.age !== 'number' || c.age < 18 || c.age > 100) {
        this.sendToUser(userId, 'search:error', { message: 'Invalid basic criteria' });
        return;
      }
      if (!isDesiredGender(c.desiredGender)) {
        this.sendToUser(userId, 'search:error', { message: 'Invalid desiredGender' });
        return;
      }
      if (typeof c.desiredAgeMin !== 'number' || typeof c.desiredAgeMax !== 'number' || c.desiredAgeMin < 18 || c.desiredAgeMax > 100 || c.desiredAgeMin > c.desiredAgeMax) {
        this.sendToUser(userId, 'search:error', { message: 'Invalid desired age range' });
        return;
      }
      if (typeof c.useGeolocation !== 'boolean') {
        this.sendToUser(userId, 'search:error', { message: 'Invalid geolocation flag' });
        return;
      }
      if (c.useGeolocation) {
        if (!c.location || typeof c.location.longitude !== 'number' || typeof c.location.latitude !== 'number') {
          this.sendToUser(userId, 'search:error', { message: 'Location required when useGeolocation is true' });
          return;
        }
        if (c.maxDistance && (typeof c.maxDistance !== 'number' || c.maxDistance < 1 || c.maxDistance > 100)) {
          this.sendToUser(userId, 'search:error', { message: 'Invalid maxDistance' });
          return;
        }
      }
      // Часовой лимит поиска (бесплатно): при исчерпании — структурное событие
      // search:limit, чтобы клиент показал окно оплаты Premium (а не просто ошибку).
      const limit = await MonetizationService.canUserSearch(userId);
      if (!limit.canSearch) {
        this.sendToUser(userId, 'search:limit', { message: limit.reason, resetInMin: limit.resetInMin });
        this.sendToUser(userId, 'search:error', { message: limit.reason || 'Лимит поисков исчерпан' });
        void this.sendSearchQuota(userId);
        return;
      }

      const result = await SearchService.startSearch(
        userId,
        socket.data.user.telegramId,
        data.criteria
      );

      if (result.status === 'searching') {
        socket.emit('search:status', { status: 'searching' });
        this.armAiMatch(userId);
      } else if (result.status === 'cancelled' || result.status === 'expired') {
        socket.emit('search:expired');
      }
      // Обновляем счётчик оставшихся бесплатных поисков (списание уже произошло)
      void this.sendSearchQuota(userId);
    } catch (error) {
      wsLogger.error('handle_search_start_error', userId, error as Error);
      this.sendToUser(userId, 'search:error', {
        message: error instanceof Error ? error.message : 'An unknown error occurred during search.'
      });
    }
  }

  /** Через AI_MATCH_DELAY_MS без живого матча — подключаем ИИ-собеседника. */
  private armAiMatch(userId: string): void {
    this.clearAiMatch(userId);
    if (!AICompanionService.enabled) return;
    // Разброс вокруг базовой задержки (0.5x–1.5x): фиксированные 20с были палевом.
    const base = this.AI_MATCH_DELAY_MS;
    const delay = Math.round(base * 0.5 + Math.random() * base);
    const t = setTimeout(() => {
      this.aiMatchTimers.delete(userId);
      AICompanionService.createAiMatch(userId).catch(() => {});
    }, delay);
    this.aiMatchTimers.set(userId, t);
  }

  public clearAiMatch(userId: string): void {
    const t = this.aiMatchTimers.get(userId);
    if (t) { clearTimeout(t); this.aiMatchTimers.delete(userId); }
  }

  /** Отправляет пользователю его квоту поиска (для счётчика «осталось N»). */
  public async sendSearchQuota(userId: string): Promise<void> {
    try {
      const q = await MonetizationService.getSearchQuota(userId);
      this.sendToUser(userId, 'search:quota', q);
    } catch { /* noop */ }
  }

  /** Рассылка статистики поиска с пер-юзерным сдвигом (цифры не одинаковы для всех). */
  public async emitPersonalizedStats(stats: SearchStatsSnapshot): Promise<void> {
    try {
      const sockets = await this.io.in('search_stats_room').fetchSockets();
      for (const s of sockets) {
        const uid = String((s.data as any)?.user?._id || s.id);
        s.emit('search:stats', SearchService.personalizeStats(stats, uid));
      }
    } catch {
      this.io.to('search_stats_room').emit('search:stats', stats);
    }
  }

  private async handleSearchCancel(socket: TypedSocket) {
    try {
      const userId = socket.data.user._id.toString();
      this.clearAiMatch(userId);

      // Отменяем поиск через сервис
      const cancelledSearch = await SearchService.cancelSearch(userId);
      
      if (cancelledSearch) {
        // Удаляем пользователя из комнаты поиска
        socket.leave(`search:${userId}`);
        socket.emit('search:status', { status: 'cancelled' });
        
        // Обновляем статус активности пользователя, чтобы убедиться что он остается активным
        User.findByIdAndUpdate(userId, {
          isOnline: true,
          lastActive: new Date()
        }).catch((error: unknown) => {
          wsLogger.error('update_activity_after_cancel', userId, error as Error);
        });
      }

    } catch (error) {
      socket.emit('error', { 
        message: error instanceof Error ? error.message : 'Failed to cancel search'
      });
    }
  }

  // Проверяет, что fromUserId и targetId состоят в одном активном чате.
  // Возвращает _id чата или null. Защищает contact:* от спама/фишинга произвольным userId.
  private async sharedActiveChat(fromUserId: string, targetId: string): Promise<string | null> {
    const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
    if (!isObjectId(fromUserId) || !isObjectId(targetId) || fromUserId === targetId) return null;
    const chat = await Chat.findOne({
      participants: { $all: [new mongoose.Types.ObjectId(fromUserId), new mongoose.Types.ObjectId(targetId)] },
      isActive: true,
    }).select('_id');
    return chat ? chat._id.toString() : null;
  }

  private async handleContactRequest(socket: TypedSocket, data: any) {
    try {
      const fromUserId = socket.data.user._id.toString();
      const targetId = String(data?.to || '');
      const chatId = await this.sharedActiveChat(fromUserId, targetId);
      if (!chatId) { socket.emit('error', { message: 'Forbidden' }); return; }
      this.sendToUser(targetId, 'contact:request', { from: fromUserId, chatId });
    } catch (e) {
      wsLogger.error('contact_request', socket.data.user?._id?.toString() || '', e as Error);
    }
  }

  private async handleContactResponse(socket: TypedSocket, data: any) {
    try {
      const responderId = socket.data.user._id.toString();
      const targetId = String(data?.userId || '');
      const status = data?.status === 'accepted' ? 'accepted' : 'declined';
      const chatId = await this.sharedActiveChat(responderId, targetId);
      if (!chatId) { socket.emit('error', { message: 'Forbidden' }); return; }
      this.sendToUser(targetId, 'contact:status', { userId: responderId, status });
    } catch (e) {
      wsLogger.error('contact_respond', socket.data.user?._id?.toString() || '', e as Error);
    }
  }
} 