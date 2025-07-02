# WebSocket API Документация

## Подключение

**URL:** `ws://localhost:3000/socket.io/` (или ваш домен)  
**Библиотека:** Socket.IO  
**Аутентификация:** JWT токен в поле `auth.token`

```javascript
const socket = io('ws://localhost:3000', {
  transports: ['websocket'],
  auth: {
    token: 'your_jwt_token_here'
  }
});
```

---

## События от клиента к серверу

### 🔍 Поиск партнеров

#### `search:start`
Начать поиск партнера

**Параметры:**
```javascript
socket.emit('search:start', {
  criteria: {
    gender: 'male' | 'female',           // Ваш пол
    age: number,                         // Ваш возраст
    rating?: number,                     // Ваш рейтинг (опционально)
    desiredGender: Array<'male' | 'female' | 'any'>, // Кого ищете
    desiredAgeMin: number,               // Мин. возраст партнера
    desiredAgeMax: number,               // Макс. возраст партнера
    minAcceptableRating?: number,        // Мин. рейтинг партнера (опционально)
    useGeolocation: boolean,             // Использовать геолокацию
    location?: {                         // Только если useGeolocation: true
      longitude: number,
      latitude: number
    },
    maxDistance?: number                 // Макс. расстояние в км
  }
});
```

**Пример:**
```javascript
socket.emit('search:start', {
  criteria: {
    gender: 'male',
    age: 25,
    desiredGender: ['any'],
    desiredAgeMin: 18,
    desiredAgeMax: 50,
    useGeolocation: false
  }
});
```

#### `search:cancel`
Отменить поиск
```javascript
socket.emit('search:cancel');
```

#### `search:subscribe_stats`
Подписаться на статистику активных пользователей
```javascript
socket.emit('search:subscribe_stats');
```

#### `search:unsubscribe_stats`
Отписаться от статистики
```javascript
socket.emit('search:unsubscribe_stats');
```

### 💬 Чат и сообщения

#### `chat:join`
Присоединиться к чату
```javascript
socket.emit('chat:join', chatId);
```

#### `chat:leave`
Покинуть чат
```javascript
socket.emit('chat:leave', chatId);
```

#### `chat:message`
Отправить сообщение
```javascript
socket.emit('chat:message', {
  chatId: string,
  content: string
});
```

**Пример:**
```javascript
socket.emit('chat:message', {
  chatId: '656f1784f4e322b83fb88291',
  content: 'Привет! Как дела?'
});
```

#### `chat:typing`
Уведомить о наборе текста
```javascript
socket.emit('chat:typing', chatId);
```

#### `chat:read`
Отметить сообщения как прочитанные
```javascript
socket.emit('chat:read', {
  chatId: string,
  timestamp: Date
});
```

#### `chat:end`
Завершить чат
```javascript
socket.emit('chat:end', {
  chatId: string,
  reason?: string
});
```

#### `chat:rate`
Оценить собеседника
```javascript
socket.emit('chat:rate', {
  chatId: string,
  score: number,        // От 1 до 5
  comment?: string
});
```

### 👥 Контакты

#### `contact:request`
Запросить контакт
```javascript
socket.emit('contact:request', {
  to: string,      // ID пользователя
  chatId: string
});
```

#### `contact:respond`
Ответить на запрос контакта
```javascript
socket.emit('contact:respond', {
  userId: string,
  status: 'accepted' | 'declined' | 'blocked'
});
```

---

## События от сервера к клиенту

### 🔍 Поиск и мэтчинг

#### `search:matched`
Найден партнер

**Структура данных:**
```javascript
{
  matchedUser: {
    telegramId: string,
    gender: 'male' | 'female',
    age: number,
    chatId: string
  }
}
```

**Пример:**
```javascript
socket.on('search:matched', (data) => {
  console.log('Найден партнер:', data);
  // {
  //   matchedUser: {
  //     telegramId: '123456789',
  //     gender: 'female',
  //     age: 23,
  //     chatId: 'new_chat_id_here'
  //   }
  // }
});
```

#### `search:status`
Статус поиска

**Структура данных:**
```javascript
{
  status: 'searching' | 'cancelled' | 'expired' | 'matched'
}
```

#### `search:expired`
Поиск истек (без параметров)
```javascript
socket.on('search:expired', () => {
  console.log('Время поиска истекло');
});
```

#### `search:stats`
Статистика активных пользователей

**Структура данных:**
```javascript
{
  t: number,      // Всего ищут
  m: number,      // Мужчин ищут
  f: number,      // Женщин ищут
  online: {
    t: number,    // Всего онлайн
    m: number,    // Мужчин онлайн
    f: number     // Женщин онлайн
  },
  avgSearchTime: {          // ← Добавлено отсутствующее поле
    t: number,              // Среднее время поиска (всего)
    m: number,              // Среднее время поиска (мужчины)
    f: number,              // Среднее время поиска (женщины)
    matches24h: number      // Количество мэтчей за 24 часа
  }
}
```

**Пример:**
```javascript
socket.on('search:stats', (data) => {
  // {
  //   t: 15,
  //   m: 8,
  //   f: 7,
  //   online: { t: 45, m: 23, f: 22 },
  //   avgSearchTime: { t: 0, m: 0, f: 0, matches24h: 42 }
  // }
});
```

### 💬 Чат и сообщения

#### `chat:message`
Новое сообщение

**Структура данных:**
```javascript
{
  chatId: string,
  message: {
    _id: string,
    chatId: string,
    content: string,
    timestamp: string,    // ISO дата
    isRead: boolean,
    readBy: string[],     // ← Массив ID пользователей, прочитавших сообщение
    sender: {
      _id: string,
      telegramId: number,
      username?: string,
      firstName?: string,
      lastName?: string,
      photos?: string[]
    }
  }
}
```

**Пример:**
```javascript
socket.on('chat:message', (data) => {
  // {
  //   chatId: '656f1784f4e322b83fb88291',
  //   message: {
  //     _id: '65705a9f2b38b6d85714a273',
  //     content: 'Привет!',
  //     timestamp: '2023-12-06T12:05:19.989Z',
  //     isRead: false,
  //     readBy: [],
  //     sender: {
  //       _id: '656f176ff4e322b83fb8828d',
  //       telegramId: 123456789,
  //       firstName: 'Иван',
  //       photos: ['url1.jpg']
  //     }
  //   }
  // }
});
```

#### `chat:typing`
Собеседник печатает

**Структура данных:**
```javascript
{
  chatId: string,
  userId: string    // ← Изменено: это telegramId, а не обычный _id
}
```

#### `chat:read`
Сообщения прочитаны

**Структура данных:**
```javascript
{
  chatId: string,
  userId: string,
  timestamp: Date
}
```

#### `chat:ended`
Чат завершен

**Структура данных:**
```javascript
{
  chatId: string,
  endedBy: string,
  reason?: string    // 'partner_disconnected', 'user_ended', etc.
}
```

#### `chat:rated`
Получена оценка

**Структура данных:**
```javascript
{
  chatId: string,
  ratedBy: string,
  score: number
}
```

### 👥 Контакты

#### `contact:request`
Запрос на контакт

**Структура данных:**
```javascript
{
  from: string,     // ID пользователя, который запрашивает
  chatId: string
}
```

#### `contact:status`
Статус контакта

**Структура данных:**
```javascript
{
  userId: string,
  status: 'accepted' | 'declined' | 'blocked'
}
```

### 🔗 Соединение и ошибки

#### `connection:recovered`
Соединение восстановлено (без параметров)
```javascript
socket.on('connection:recovered', () => {
  console.log('Соединение восстановлено');
});
```

#### `error`
Ошибка

**Структура данных:**
```javascript
{
  message: string
}
```

**Возможные сообщения об ошибках:**
- `"Failed to send message"` - ошибка отправки сообщения
- `"Failed to mark messages as read"` - ошибка отметки сообщений как прочитанных  
- `"Failed to end chat"` - ошибка завершения чата
- `"Failed to rate chat"` - ошибка оценки чата
- `"Failed to start search"` - ошибка начала поиска
- `"Failed to cancel search"` - ошибка отмены поиска
- `"Search service is temporarily unavailable. Please try again later."` - сервис поиска недоступен
- `"Message queued for delivery due to service degradation"` - сообщение поставлено в очередь из-за проблем с сервисом

---

## Полный пример использования

```javascript
// Подключение
const socket = io('ws://localhost:3000', {
  auth: { token: 'your_jwt_token' }
});

// Обработчики подключения
socket.on('connect', () => {
  console.log('Подключено к WebSocket');
  
  // Подписываемся на статистику
  socket.emit('search:subscribe_stats');
});

socket.on('connect_error', (error) => {
  console.error('Ошибка подключения:', error);
});

// Поиск
socket.on('search:stats', (data) => {
  console.log(`Онлайн: ${data.online.t}, ищут: ${data.t}, мэтчей за 24ч: ${data.avgSearchTime.matches24h}`);
});

socket.on('search:matched', (data) => {
  console.log('Найден партнер!');
  // Присоединяемся к чату
  socket.emit('chat:join', data.matchedUser.chatId);
});

// Чат
socket.on('chat:message', (data) => {
  console.log(`${data.message.sender.firstName}: ${data.message.content}`);
});

socket.on('chat:ended', (data) => {
  if (data.reason === 'partner_disconnected') {
    console.log('Собеседник отключился');
  } else {
    console.log('Чат завершен');
  }
});

// Ошибки
socket.on('error', (data) => {
  console.error('Ошибка:', data.message);
});

// Отправка сообщения
function sendMessage(chatId, text) {
  socket.emit('chat:message', {
    chatId: chatId,
    content: text
  });
}

// Начать поиск
function startSearch() {
  socket.emit('search:start', {
    criteria: {
      gender: 'male',
      age: 25,
      desiredGender: ['any'],
      desiredAgeMin: 18,
      desiredAgeMax: 50,
      useGeolocation: false
    }
  });
}
```

---

## Примечания

1. **Аутентификация обязательна** - все события требуют валидный JWT токен
2. **Автоматическое переподключение** - Socket.IO автоматически восстанавливает соединение
3. **Валидация данных** - сервер проверяет корректность всех отправляемых данных
4. **Rate limiting** - есть ограничения на частоту отправки событий
5. **Геолокация опциональна** - можно искать как с геолокацией, так и без нее
6. **Circuit Breaker** - при высокой нагрузке сервер может временно отклонять запросы
7. **Автоматическое завершение чатов** - чат автоматически завершается при отключении партнера
8. **Отложенная отмена поиска** - поиск отменяется через 10 секунд после отключения
9. **Статистика в реальном времени** - подписка на `search:stats` обновляется автоматически
10. **Восстановление состояния** - при переподключении все комнаты восстанавливаются автоматически

## Временные ограничения

- **Ping timeout:** 20 секунд
- **Ping interval:** 25 секунд  
- **Максимальное время отключения для восстановления:** 2 минуты
- **Задержка отмены поиска при отключении:** 10 секунд
- **Интервал обновления активности пользователя:** 10 секунд
- **TTL кэша статистики:** 5 секунд
- **Максимальный размер HTTP буфера:** 1MB
- **Сжатие данных:** включено для сообщений больше 1KB

## WebSocket комнаты

Система автоматически управляет подключениями к различным комнатам:

- **`search_stats_room`** - для получения статистики поиска в реальном времени
- **`chat:{chatId}`** - для каждого активного чата (автоматически при `chat:join`)
- **`search:{userId}`** - для каждого активного поиска (автоматически при `search:start`)

**Примечание:** Клиенту не нужно вручную управлять комнатами - все происходит автоматически при вызове соответствующих событий. 