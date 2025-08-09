import { io, Socket } from 'socket.io-client';

// Интерфейсы для типизации
interface TestMessage {
  _id: string;
  content: string;
  sender: {
    _id: string;
    telegramId: string;
    firstName?: string;
  };
  timestamp: Date;
  replyTo?: {
    _id: string;
    content: string;
    sender: {
      _id: string;
      telegramId: string;
      firstName?: string;
    };
  };
}

interface ChatMessageEvent {
  chatId: string;
  message: TestMessage;
}

class ReplyMessageTester {
  private socket1: Socket | null = null;
  private socket2: Socket | null = null;
  private messages: TestMessage[] = [];

  async connect() {
    const serverUrl = `http://localhost:3000`; // Используем стандартный порт
    
    console.log('🔌 Подключение тестовых пользователей...');
    
    // Подключаем первого пользователя
    this.socket1 = io(serverUrl, {
      auth: {
        token: 'test_token_user1', // Тестовый токен
      },
      transports: ['websocket'],
    });

    // Подключаем второго пользователя  
    this.socket2 = io(serverUrl, {
      auth: {
        token: 'test_token_user2', // Тестовый токен
      },
      transports: ['websocket'],
    });

    // Настраиваем обработчики событий
    this.setupEventHandlers();

    return new Promise<void>((resolve) => {
      let connectedCount = 0;
      
      const checkConnection = () => {
        connectedCount++;
        if (connectedCount === 2) {
          console.log('✅ Оба пользователя подключены');
          resolve();
        }
      };

      this.socket1?.on('connect', checkConnection);
      this.socket2?.on('connect', checkConnection);
    });
  }

  private setupEventHandlers() {
    // Обработчики для первого пользователя
    this.socket1?.on('chat:message', (data: ChatMessageEvent) => {
      console.log('👤 Пользователь 1 получил сообщение:', {
        content: data.message.content,
        isReply: !!data.message.replyTo,
        replyToContent: data.message.replyTo?.content
      });
      this.messages.push(data.message);
    });

    // Обработчики для второго пользователя
    this.socket2?.on('chat:message', (data: ChatMessageEvent) => {
      console.log('👤 Пользователь 2 получил сообщение:', {
        content: data.message.content,
        isReply: !!data.message.replyTo,
        replyToContent: data.message.replyTo?.content
      });
      this.messages.push(data.message);
    });

    // Обработчики ошибок
    this.socket1?.on('error', (error) => {
      console.error('❌ Ошибка пользователя 1:', error);
    });

    this.socket2?.on('error', (error) => {
      console.error('❌ Ошибка пользователя 2:', error);
    });
  }

  async simulateChat(testChatId: string) {
    // сохранять chatId в состоянии не требуется для тестов
    
    // Подключаемся к чату
    console.log(`📱 Подключение к чату ${testChatId}...`);
    this.socket1?.emit('chat:join', testChatId);
    this.socket2?.emit('chat:join', testChatId);

    await this.delay(1000);

    // Тест 1: Обычное сообщение
    console.log('\n🧪 Тест 1: Отправка обычного сообщения');
    this.socket1?.emit('chat:message', {
      chatId: testChatId,
      content: 'Привет! Как дела?'
    });

    await this.delay(2000);

    // Тест 2: Ответ на сообщение
    console.log('\n🧪 Тест 2: Отправка ответа на сообщение');
    if (this.messages.length > 0) {
      const firstMessage = this.messages[0];
      this.socket2?.emit('chat:message', {
        chatId: testChatId,
        content: 'Отлично! А у тебя как?',
        replyTo: firstMessage._id
      });
    } else {
      console.log('❌ Не найдено сообщений для ответа');
    }

    await this.delay(2000);

    // Тест 3: Ответ на несуществующее сообщение
    console.log('\n🧪 Тест 3: Отправка ответа на несуществующее сообщение');
    this.socket1?.emit('chat:message', {
      chatId: testChatId,
      content: 'Это должно вызвать ошибку',
      replyTo: '507f1f77bcf86cd799439011' // Несуществующий ID
    });

    await this.delay(2000);

    // Тест 4: Цепочка ответов
    console.log('\n🧪 Тест 4: Цепочка ответов');
    if (this.messages.length > 1) {
      const replyMessage = this.messages[1];
      this.socket1?.emit('chat:message', {
        chatId: testChatId,
        content: 'Да, всё хорошо! Спасибо что спросил)',
        replyTo: replyMessage._id
      });
    }

    await this.delay(2000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async runTests() {
    try {
      console.log('🚀 Начинаем тестирование функциональности ответов на сообщения...\n');
      
      await this.connect();
      
      // Используем тестовый чат ID
      const testChatId = '507f1f77bcf86cd799439012';
      
      await this.simulateChat(testChatId);
      
      console.log('\n📊 Результаты тестирования:');
      console.log(`Всего получено сообщений: ${this.messages.length}`);
      console.log(`Сообщений с ответами: ${this.messages.filter(m => m.replyTo).length}`);
      
      this.messages.forEach((msg, index) => {
        console.log(`${index + 1}. "${msg.content}" ${msg.replyTo ? `(ответ на: "${msg.replyTo.content}")` : ''}`);
      });
      
      console.log('\n✅ Тестирование завершено!');
      
    } catch (error) {
      console.error('❌ Ошибка во время тестирования:', error);
    } finally {
      this.socket1?.disconnect();
      this.socket2?.disconnect();
    }
  }
}

// Запускаем тестирование если скрипт вызван напрямую
if (require.main === module) {
  const tester = new ReplyMessageTester();
  tester.runTests().catch(console.error);
}

export { ReplyMessageTester }; 