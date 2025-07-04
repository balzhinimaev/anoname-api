import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { socketAuth } from './middleware/auth';
import { ClientToServerEvents, ServerToClientEvents, SocketData, TypedSocket } from './types';
import { ChatService } from '../services/ChatService';
import { SearchService, SearchCriteria } from '../services/SearchService';
import { wsLogger } from '../utils/logger';
import { metricsCollector } from '../utils/metrics';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import User from '../models/User';
import { RatingService } from '../services/RatingService';

// Создаем статическую карту для хранения таймаутов
const pendingSearchCancellations = new Map<string, NodeJS.Timeout>();

export class WebSocketManager {
  public io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> Set of socketIds
  private userRooms: Map<string, Set<string>> = new Map(); // userId -> Set of room names
  private chatCircuitBreaker: CircuitBreaker;
  private searchCircuitBreaker: CircuitBreaker;

  constructor(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.CLIENT_URL || 'http://localhost:3001',
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['Authorization', 'Content-Type']
      },
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
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
        User.findByIdAndUpdate(userId, {
          lastActive: new Date()
        }).then(() => {
          // Обновляем статистику после каждого обновления активности
          SearchService.broadcastSearchStats().catch((error: unknown) => {
            wsLogger.error('update_stats', userId, error as Error);
          });
        }).catch((error: unknown) => {
          wsLogger.error('update_activity', userId, error as Error);
        });
      }, 10000); // Обновляем каждые 10 секунд

      // Логируем подключение
      wsLogger.connection(userId, socket.id, {
        isReconnection,
        telegramId: socket.data.user.telegramId
      });

      // Подписка на статистику
      socket.on('search:subscribe_stats', async () => {
        socket.join('search_stats_room');
        
        // Отправляем текущую статистику сразу после подписки
        try {
          // Получаем текущую статистику
          const stats = await SearchService.getSearchStats();
          
          // Проверяем, находится ли пользователь в активном поиске
          const userSearch = await SearchService.getUserActiveSearch(userId);
          
          // Если пользователь уже в поиске, но не включен в статистику - учитываем его
          if (userSearch && userSearch.status === 'searching') {
            const userGender = userSearch.gender || 'unknown';
            if (userGender === 'male') {
              stats.m += 1;
              stats.t += 1;
            } else if (userGender === 'female') {
              stats.f += 1;
              stats.t += 1;
            }
          }
          
          socket.emit('search:stats', stats);
        } catch (error) {
          wsLogger.error('stats_initial', userId, error as Error);
        }
      });

      socket.on('search:unsubscribe_stats', () => {
        socket.leave('search_stats_room');
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

      // При переподключении восстанавливаем комнаты
      if (isReconnection) {
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
        }
        
        socket.emit('connection:recovered');
      }

      // Обработчики поиска с логированием
      socket.on('search:start', (data) => {
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
      socket.on('chat:join', (chatId) => {
        const roomName = `chat:${chatId}`;
        socket.join(roomName);
        this.userRooms.get(userId)?.add(roomName);
        wsLogger.event('chat_join', userId, socket.id, { chatId });
      });
      
      socket.on('chat:leave', (chatId) => {
        const roomName = `chat:${chatId}`;
        socket.leave(roomName);
        this.userRooms.get(userId)?.delete(roomName);
        wsLogger.event('chat_leave', userId, socket.id, { chatId });
      });

      socket.on('chat:message', (data) => {
        const startTime = Date.now();
        wsLogger.event('chat_message', userId, socket.id, { chatId: data.chatId });
        this.handleChatMessage(socket, data).then(() => {
          const duration = Date.now() - startTime;
          metricsCollector.messageProcessed(duration);
        }).catch(error => {
          metricsCollector.errorOccurred(error as Error);
          wsLogger.error(userId, socket.id, error as Error, { 
            event: 'chat_message', 
            chatId: data.chatId 
          });
        });
      });

      socket.on('chat:start_typing', (data) => {
        wsLogger.event('chat_start_typing', userId, socket.id, { chatId: data.chatId });
        this.handleChatStartTyping(socket, data.chatId);
      });

      socket.on('chat:stop_typing', (data) => {
        wsLogger.event('chat_stop_typing', userId, socket.id, { chatId: data.chatId });
        this.handleChatStopTyping(socket, data.chatId);
      });

      socket.on('chat:read', (data) => {
        wsLogger.event('chat_read', userId, socket.id, { chatId: data.chatId });
        this.handleChatRead(socket, data).catch(error => {
          wsLogger.error(userId, socket.id, error as Error, { event: 'chat_read', chatId: data.chatId });
        });
      });

      // Новый обработчик завершения чата
      socket.on('chat:end', async (data) => {
        const startTime = Date.now();
        wsLogger.event('chat_end', userId, socket.id, { 
          chatId: data.chatId,
          reason: data.reason 
        });

        try {
          await ChatService.endChat(data.chatId, userId, data.reason);
          const duration = Date.now() - startTime;
          metricsCollector.messageProcessed(duration);
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

      // Обработчики контактов
      socket.on('contact:request', (data) => this.handleContactRequest(socket, data));
      socket.on('contact:respond', (data) => this.handleContactResponse(socket, data));

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
          
          // При отключении пользователя не только отменяем поиск, но и завершаем активный чат
          Promise.all([
            // Логика отмены поиска
            SearchService.getUserActiveSearch(userId).then(activeSearch => {
              if (activeSearch && activeSearch.status === 'searching') {
                wsLogger.info('search_disconnect_detected', 'Обнаружено отключение пользователя в поиске', {
                  userId,
                  searchId: activeSearch._id?.toString(),
                  disconnectReason: reason
                });
                const searchCancelTimeout = setTimeout(async () => {
                  if (!this.userSockets.has(userId)) {
                    try {
                      const currentSearch = await SearchService.getUserActiveSearch(userId);
                      if (currentSearch && currentSearch.status === 'searching') {
                        wsLogger.info('search_auto_cancel', 'Автоматическая отмена поиска после таймаута', {
                          userId,
                          searchId: currentSearch._id?.toString(),
                          disconnectReason: reason,
                          disconnectDuration: Date.now() - connectionStart
                        });
                        await SearchService.cancelSearch(userId);
                      }
                    } catch (error) {
                      wsLogger.error('search_auto_cancel', userId, error as Error);
                    }
                  }
                }, 10000);
                pendingSearchCancellations.set(userId, searchCancelTimeout);
              }
            }).catch(error => {
              wsLogger.error('get_active_search', userId, error as Error);
            }),
            // Новая логика завершения активного чата
            ChatService.endChatOnDisconnect(userId).catch(error => {
              wsLogger.error('end_chat_on_disconnect', userId, error as Error);
            })
          ]).catch(error => {
            wsLogger.error('disconnect_promises_failed', userId, error as Error);
          });
          
          // Обновляем статус активности
          User.findByIdAndUpdate(userId, {
            isOnline: false,
            lastActive: new Date()
          }).then(() => {
            // Обновляем статистику после изменения статуса
            SearchService.broadcastSearchStats().catch((error: unknown) => {
              wsLogger.error('update_stats_on_disconnect', userId, error as Error);
            });
          }).catch((error: unknown) => {
            wsLogger.error('update_activity', userId, error as Error);
          });
          
          // При полном отключении сохраняем состояние на 2 минуты
          setTimeout(() => {
            if (!this.userSockets.has(userId)) {
              this.userRooms.delete(userId);
            }
          }, 2 * 60 * 1000);
        }

        wsLogger.disconnection(userId, socket.id, reason, {
          duration,
          remainingSockets: this.userSockets.get(userId)?.size || 0
        });
      });
    });
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

  private async handleChatMessage(socket: TypedSocket, data: { chatId: string; content: string }) {
    try {
      await this.chatCircuitBreaker.execute(
        async () => {
          const userId = socket.data.user._id.toString();
          await ChatService.sendMessage(
            data.chatId,
            userId,
            data.content
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

  private async handleChatStartTyping(socket: TypedSocket, chatId: string) {
    const userId = socket.data.user._id.toString();
    socket.to(`chat:${chatId}`).emit('chat:start_typing', {
      chatId,
      userId: userId,
    });
  }

  private async handleChatStopTyping(socket: TypedSocket, chatId: string) {
    const userId = socket.data.user._id.toString();
    socket.to(`chat:${chatId}`).emit('chat:stop_typing', {
      chatId,
      userId: userId,
    });
  }

  private async handleChatRead(socket: TypedSocket, data: { chatId: string; timestamp: Date }) {
    try {
      await ChatService.markAsRead(
        data.chatId,
        socket.data.user._id.toString(),
        data.timestamp
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
      const result = await SearchService.startSearch(
        userId,
        socket.data.user.telegramId,
        data.criteria
      );

      if (result.status === 'searching') {
        socket.emit('search:status', { status: 'searching' });
      } else if (result.status === 'cancelled' || result.status === 'expired') {
        socket.emit('search:expired');
      }
    } catch (error) {
      wsLogger.error('handle_search_start_error', userId, error as Error);
      this.sendToUser(userId, 'search:error', {
        message: error instanceof Error ? error.message : 'An unknown error occurred during search.'
      });
    }
  }

  private async handleSearchCancel(socket: TypedSocket) {
    try {
      const userId = socket.data.user._id.toString();
      
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

  private async handleContactRequest(socket: TypedSocket, data: any) {
    const fromUserId = socket.data.user._id.toString();
    this.sendToUser(data.to, 'contact:request', {
      from: fromUserId,
      chatId: data.chatId
    });
  }

  private async handleContactResponse(socket: TypedSocket, data: any) {
    const responderId = socket.data.user._id.toString();
    this.sendToUser(data.userId, 'contact:status', {
      userId: responderId,
      status: data.status
    });
  }
} 