import { io, Socket } from 'socket.io-client';
import { ClientToServerEvents, ServerToClientEvents } from '../websocket/types';
import jwt from 'jsonwebtoken';
import config from '../config';
import mongoose from 'mongoose';
import User from '../models/User';
import Chat from '../models/Chat';

class WebSocketTester {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private token: string;
  private userId: string;
  private testChatId = '';
  private testUserId2 = '';

  constructor() {
    console.log('🔧 Инициализация Socket.IO клиента...');
    this.socket = io('http://localhost:3001', {
      transports: ['websocket'],
      autoConnect: false,
      timeout: 5000,
      reconnection: true,
      reconnectionAttempts: 3
    });

    // Обработчики событий сервера
    this.socket.on('connect_error', (error: any) => {
      console.log('❌ Ошибка подключения:', error.message);
      console.log('Детали ошибки:', {
        type: error.type,
        description: error.description,
        context: error.context
      });
    });

    this.socket.on('connect', () => {
      console.log('✅ Подключено к серверу');
      console.log('ID сокета:', this.socket.id);
    });

    this.socket.on('disconnect', (reason) => {
      console.log('❌ Отключено от сервера:', reason);
    });

    this.socket.on('error', (error) => {
      console.log('❌ Ошибка:', error.message);
    });

    this.socket.on('search:status', (data) => {
      console.log('✅ Статус поиска:', data.status);
    });

    this.socket.on('search:matched', (data) => {
      console.log('✅ Найден собеседник:', data.matchedUser);
      this.testChatId = data.matchedUser.chatId;
    });

    this.socket.on('chat:message', (data) => {
      console.log('✅ Новое сообщение:', data);
    });

    this.socket.on('chat:start_typing', (data) => {
      console.log('✅ Печатает:', data);
    });

    this.socket.on('chat:stop_typing', (data) => {
      console.log('✅ Перестал печатать:', data);
    });

    this.socket.on('chat:read', (data) => {
      console.log('✅ Сообщения прочитаны:', data);
    });
  }

  async connect(method: 'auth' | 'header' | 'bearer' = 'auth') {
    try {
      console.log(`\n🔌 Попытка подключения через ${method}...`);
      
      // Создаем тестового пользователя если нужно
      console.log('📡 Подключение к MongoDB...');
      await mongoose.connect(config.mongoUri, { dbName: "anoname" });
      console.log('✅ Подключено к MongoDB');

      console.log('🔍 Поиск тестового пользователя...');
      let user = await User.findOne({ telegramId: 127227574 }) as any;
      
      if (!user) {
        console.log('👤 Создание тестового пользователя...');
        user = await User.create({
          telegramId: 127227574,
          username: "testuser",
          firstName: "Test",
          lastName: "User",
          gender: "male",
          age: 25,
          isActive: true,
          preferences: {
            gender: "any",
            ageRange: { min: 18, max: 50 }
          }
        });
        console.log('✅ Тестовый пользователь создан');
      } else {
        console.log('✅ Тестовый пользователь найден');
      }

      this.userId = user._id.toString();
      this.token = jwt.sign({ userId: this.userId }, config.jwtSecret, { expiresIn: '30d' });
      console.log('🔑 Токен создан:', this.token.substring(0, 20) + '...');

      // Настраиваем способ аутентификации
      const socketOptions: any = {
        transports: ['websocket'],
        timeout: 5000,
        reconnection: true,
        reconnectionAttempts: 3,
        forceNew: true
      };

      switch (method) {
        case 'auth':
          socketOptions.auth = { token: this.token };
          break;
        case 'header':
          socketOptions.extraHeaders = { token: this.token };
          break;
        case 'bearer':
          socketOptions.extraHeaders = { Authorization: `Bearer ${this.token}` };
          break;
      }

      console.log('⚙️ Настройки Socket.IO:', JSON.stringify(socketOptions, null, 2));
      this.socket = io('http://localhost:3001', socketOptions);

      // Переподключаем обработчики событий
      this.setupEventHandlers();
      
      // Подключаемся
      console.log('🔌 Попытка подключения к серверу...');
      this.socket.connect();
      
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.log('⚠️ Таймаут подключения');
          resolve();
        }, 5000);

        this.socket.on('connect', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch (error) {
      console.error('❌ Ошибка при подключении:', error);
      throw error;
    }
  }

  private setupEventHandlers() {
    this.socket.on('connect', () => console.log('✅ Подключено к серверу'));
    this.socket.on('connect_error', (error) => console.log('❌ Ошибка подключения:', error.message));
    this.socket.on('disconnect', (reason) => console.log('❌ Отключено от сервера:', reason));
    this.socket.on('error', (error) => console.log('❌ Ошибка:', error.message));
    this.socket.on('search:status', (data) => console.log('✅ Статус поиска:', data.status));
    this.socket.on('search:matched', (data) => {
      console.log('✅ Найден собеседник:', data.matchedUser);
      this.testChatId = data.matchedUser.chatId;
    });
    this.socket.on('chat:message', (data) => console.log('✅ Новое сообщение:', data));
    this.socket.on('chat:start_typing', (data) => console.log('✅ Печатает:', data));
    this.socket.on('chat:stop_typing', (data) => console.log('✅ Перестал печатать:', data));
    this.socket.on('chat:read', (data) => console.log('✅ Сообщения прочитаны:', data));
  }

  async testSearch() {
    console.log('\n🔍 Тестирование поиска собеседника...');
    
    this.socket.emit('search:start', {
      criteria: {
        gender: 'male',
        age: 25,
        rating: 0,
        desiredGender: ['any'],
        desiredAgeMin: 18,
        desiredAgeMax: 50,
        useGeolocation: false
      }
    });

    // Ждем результатов поиска
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    this.socket.emit('search:cancel');
    console.log('✅ Поиск отменен');
    
    // Ждем подтверждения отмены
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  private async createTestChat() {
    console.log('\n📝 Создание тестового чата...');
    
    // Создаем второго тестового пользователя
    let user2 = await User.findOne({ telegramId: 127227575 }) as any;
    
    if (!user2) {
      console.log('👥 Создание второго тестового пользователя...');
      user2 = await User.create({
        telegramId: 127227575,
        username: "testuser2",
        firstName: "Test2",
        lastName: "User2",
        gender: "female",
        age: 25,
        isActive: true,
        preferences: {
          gender: "any",
          ageRange: { min: 18, max: 50 }
        }
      });
      console.log('✅ Второй тестовый пользователь создан');
    } else {
      console.log('✅ Второй тестовый пользователь найден');
    }

    this.testUserId2 = user2._id.toString();

    // Создаем тестовый чат
    const chat = await Chat.create({
      participants: [this.userId, this.testUserId2],
      type: 'anonymous',
      messages: []
    });

    this.testChatId = chat._id.toString();
    console.log('✅ Тестовый чат создан:', this.testChatId);
  }

  async testChat() {
    if (!this.testChatId) {
      console.log('📝 Нет активного чата, создаем новый...');
      await this.createTestChat();
    }

    console.log('\n💬 Тестирование чата...');
    
    // Присоединяемся к чату
    this.socket.emit('chat:join', this.testChatId);
    console.log('✅ Присоединились к чату:', this.testChatId);

    // Отправляем уведомление о наборе
    this.socket.emit('chat:start_typing', { chatId: this.testChatId });
    console.log('✅ Отправлено уведомление о наборе');

    // Ждем немного
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Отправляем сообщение
    this.socket.emit('chat:message', {
      chatId: this.testChatId,
      content: 'Тестовое сообщение'
    });
    console.log('✅ Отправлено тестовое сообщение');

    // Ждем немного (сервер должен автоматически послать stop_typing)
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Отправляем еще одно уведомление для теста stop_typing
    this.socket.emit('chat:start_typing', { chatId: this.testChatId });
    console.log('✅ Отправлено уведомление о наборе');
    await new Promise(resolve => setTimeout(resolve, 500));
    this.socket.emit('chat:stop_typing', { chatId: this.testChatId });
    console.log('✅ Отправлено уведомление о прекращении набора');

    // Ждем немного
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Отмечаем как прочитанное
    this.socket.emit('chat:read', {
      chatId: this.testChatId,
      timestamp: new Date()
    });
    console.log('✅ Сообщения отмечены как прочитанные');

    // Ждем немного
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Покидаем чат
    this.socket.emit('chat:leave', this.testChatId);
    console.log('✅ Покинули чат');
  }

  async testErrorHandling() {
    console.log('\n⚠️ Тестирование обработки ошибок...');

    // Тест с неверным ID чата
    this.socket.emit('chat:join', 'invalid_chat_id');
    this.socket.emit('chat:message', {
      chatId: 'invalid_chat_id',
      content: 'Это сообщение не должно быть отправлено'
    });

    // Тест с некорректными данными
    this.socket.emit('search:start', {
      criteria: {
        invalid: 'data'
      }
    } as any);
  }

  async disconnect() {
    if (this.socket.connected) {
      console.log('🔌 Отключение...');
      this.socket.disconnect();
      // Ждем подтверждения отключения
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('✅ Отключено от сервера');
    }
  }

  // Обновляем основную функцию тестирования
  static async runTests() {
    console.log('🚀 Начало тестирования WebSocket...\n');
    
    const tester = new WebSocketTester();

    try {
      // Тест подключения через auth
      console.log('1️⃣ Тестирование подключения через auth...');
      await tester.connect('auth');
      await new Promise(resolve => setTimeout(resolve, 2000));
      await tester.disconnect();

      // Пауза между тестами
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Тест подключения через header
      console.log('\n2️⃣ Тестирование подключения через header...');
      await tester.connect('header');
      await new Promise(resolve => setTimeout(resolve, 2000));
      await tester.disconnect();

      // Пауза между тестами
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Тест подключения через bearer
      console.log('\n3️⃣ Тестирование подключения через bearer...');
      await tester.connect('bearer');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Тестирование функциональности
      await tester.testSearch();
      await tester.testChat();
      await tester.testErrorHandling();

      await tester.disconnect();
    } catch (error) {
      console.error('❌ Ошибка при тестировании:', error);
    } finally {
      await mongoose.disconnect();
      process.exit(0);
    }
  }
}

WebSocketTester.runTests(); 