# REST API Документация

## Базовая информация

**Базовый URL:** `http://localhost:3001/api` (или ваш домен)  
**Аутентификация:** Bearer JWT токен в заголовке `Authorization`  
**Формат данных:** JSON  

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     https://your-domain.com/api/endpoint
```

---

## 🔐 Аутентификация (`/api/auth`)

### `POST /api/auth/register`
Регистрация нового пользователя

**Тело запроса:**
```json
{
  "telegramId": 123456789,
  "username": "username",       // Опционально
  "firstName": "Иван",          // Опционально  
  "lastName": "Иванов",         // Опционально
  "bio": "Описание профиля",    // Опционально
  "gender": "male",             // male | female | other (опционально)
  "age": 25,                    // Минимум 18 (опционально)
  "platform": "telegram"       // Опционально, по умолчанию "telegram"
}
```

**Успешный ответ (201):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "telegramId": 123456789,
    "username": "username",
    "firstName": "Иван",
    "lastName": "Иванов",
    "rating": 0
  }
}
```

**Возможные ошибки:**
- `400` - Ошибка валидации данных
- `409` - Пользователь уже существует
- `500` - Внутренняя ошибка сервера

---

### `POST /api/auth/login`
Аутентификация пользователя

**Тело запроса:**
```json
{
  "telegramId": 123456789,
  "platform": "telegram"       // Опционально
}
```

**Успешный ответ (200):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "telegramId": 123456789,
    "username": "username",
    "firstName": "Иван",
    "lastName": "Иванов", 
    "rating": 0
  }
}
```

**Возможные ошибки:**
- `404` - Пользователь не найден
- `500` - Ошибка при аутентификации

---

### `POST /api/auth/logout`
Выход из текущей сессии

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "message": "Успешный выход из системы"
}
```

---

### `POST /api/auth/logout-all`
Выход из всех сессий пользователя

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "message": "Успешный выход из всех сессий"
}
```

---

## 👤 Пользователи (`/api/users`)

### `POST /api/users`
Создание или обновление пользователя

**Заголовки:** `Authorization: Bearer <token>`

**Тело запроса:**
```json
{
  "telegramId": 123456789,
  "username": "username",
  "firstName": "Иван",
  "lastName": "Иванов",
  "bio": "Новое описание профиля",
  "gender": "male",
  "age": 25
}
```

**Успешный ответ (200):**
```json
{
  "telegramId": 123456789,
  "username": "username",
  "firstName": "Иван",
  "lastName": "Иванов",
  "bio": "Новое описание профиля",
  "gender": "male",
  "age": 25,
  "rating": 4.2,
  "photos": ["url1.jpg", "url2.jpg"],
  "preferences": {
    "gender": "female",
    "ageRange": {
      "min": 20,
      "max": 30
    }
  }
}
```

---

### `GET /api/users/{telegramId}`
Получение профиля пользователя

**Заголовки:** `Authorization: Bearer <token>`

**Параметры URL:** 
- `telegramId` (number) - Telegram ID пользователя

**Успешный ответ (200):**
```json
{
  "telegramId": 123456789,
  "username": "username",
  "firstName": "Иван",
  "lastName": "Иванов",
  "bio": "Описание профиля",
  "gender": "male",
  "age": 25,
  "rating": 4.2,
  "photos": ["url1.jpg", "url2.jpg"],
  "preferences": {
    "gender": "female",
    "ageRange": {
      "min": 20,
      "max": 30
    }
  },
  "stats": {
    "totalChats": 15,
    "totalMessages": 150
  }
}
```

---

### `GET /api/users/{telegramId}/matches`
Получение потенциальных партнеров

**Заголовки:** `Authorization: Bearer <token>`

**Параметры URL:**
- `telegramId` (number) - Telegram ID пользователя

**Параметры запроса:**
- `limit` (integer, 1-50, по умолчанию 20) - Количество результатов
- `page` (integer, по умолчанию 1) - Номер страницы

**Успешный ответ (200):**
```json
{
  "users": [
    {
      "telegramId": 987654321,
      "firstName": "Мария",
      "age": 23,
      "bio": "Люблю путешествовать",
      "photos": ["url1.jpg"],
      "rating": 4.5
    }
  ],
  "total": 45,
  "pages": 3
}
```

---

### `PUT /api/users/{telegramId}/preferences`
Обновление предпочтений пользователя

**Заголовки:** `Authorization: Bearer <token>`

**Тело запроса:**
```json
{
  "gender": "female",           // male | female | any
  "ageRange": {
    "min": 20,
    "max": 30
  }
}
```

**Успешный ответ (200):**
```json
{
  "telegramId": 123456789,
  "preferences": {
    "gender": "female",
    "ageRange": {
      "min": 20,
      "max": 30
    }
  }
}
```

---

### `POST /api/users/{telegramId}/photos`
Загрузка фотографий

**Заголовки:** `Authorization: Bearer <token>`  
**Content-Type:** `multipart/form-data`

**Тело запроса:**
```
photos: [File, File, ...] // Максимум 5 файлов
```

**Успешный ответ (200):**
```json
[
  {
    "id": "photo_id_1",
    "url": "https://example.com/photo1.jpg",
    "uploadedAt": "2023-12-06T12:00:00.000Z"
  },
  {
    "id": "photo_id_2", 
    "url": "https://example.com/photo2.jpg",
    "uploadedAt": "2023-12-06T12:00:05.000Z"
  }
]
```

**Возможные ошибки:**
- `400` - Превышен лимит фотографий (максимум 5)
- `413` - Размер файла превышает лимит

---

### `DELETE /api/users/{telegramId}/photos/{photoId}`
Удаление фотографии

**Заголовки:** `Authorization: Bearer <token>`

**Параметры URL:**
- `telegramId` (number) - Telegram ID пользователя
- `photoId` (string) - ID фотографии

**Успешный ответ (200):**
```json
{
  "message": "Фотография успешно удалена"
}
```

---

## 💬 Чаты (`/api/chats`)

### `POST /api/chats`
Создание нового чата

**Заголовки:** `Authorization: Bearer <token>`

**Тело запроса:**
```json
{
  "participants": [
    "656f176ff4e322b83fb8828d",
    "656f1784f4e322b83fb88291"
  ],
  "type": "anonymous"           // anonymous | permanent (по умолчанию anonymous)
}
```

**Успешный ответ (201):**
```json
{
  "_id": "656f1784f4e322b83fb88292",
  "participants": [
    "656f176ff4e322b83fb8828d",
    "656f1784f4e322b83fb88291"
  ],
  "type": "anonymous",
  "isActive": true,
  "createdAt": "2023-12-06T12:00:00.000Z",
  "expiresAt": "2023-12-06T18:00:00.000Z"
}
```

---

### `GET /api/chats/user/{userId}`
Получение чатов пользователя

**Заголовки:** `Authorization: Bearer <token>`

**Параметры URL:**
- `userId` (string) - MongoDB ObjectId пользователя

**Параметры запроса:**
- `type` (string) - Фильтр по типу: `anonymous` | `permanent` | `all`

**Успешный ответ (200):**
```json
[
  {
    "_id": "656f1784f4e322b83fb88292",
    "participants": [
      {
        "_id": "656f176ff4e322b83fb8828d",
        "firstName": "Иван",
        "photos": ["url1.jpg"]
      }
    ],
    "lastMessage": {
      "_id": "65705a9f2b38b6d85714a273",
      "content": "Привет!",
      "timestamp": "2023-12-06T12:05:00.000Z",
      "sender": "656f176ff4e322b83fb8828d"
    },
    "type": "anonymous",
    "isActive": true,
    "unreadCount": 2
  }
]
```

---

### `GET /api/chats/{chatId}/messages`
Получение сообщений чата

**Заголовки:** `Authorization: Bearer <token>`

**Параметры URL:**
- `chatId` (string) - ID чата

**Параметры запроса:**
- `limit` (integer, 1-100, по умолчанию 50) - Количество сообщений
- `before` (string, ISO date) - Получить сообщения до указанной даты

**Успешный ответ (200):**
```json
[
  {
    "_id": "65705a9f2b38b6d85714a273",
    "chatId": "656f1784f4e322b83fb88292",
    "content": "Привет! Как дела?",
    "timestamp": "2023-12-06T12:05:00.000Z",
    "isRead": true,
    "readBy": ["656f1784f4e322b83fb88291"],
    "sender": {
      "_id": "656f176ff4e322b83fb8828d",
      "telegramId": 123456789,
      "firstName": "Иван",
      "photos": ["url1.jpg"]
    }
  }
]
```

---

### `POST /api/chats/{chatId}/messages`
Отправка сообщения

**Заголовки:** `Authorization: Bearer <token>`

**Тело запроса:**
```json
{
  "content": "Привет! Как дела?",
  "sender": "656f176ff4e322b83fb8828d"
}
```

**Успешный ответ (201):**
```json
{
  "_id": "65705a9f2b38b6d85714a273",
  "chatId": "656f1784f4e322b83fb88292",
  "content": "Привет! Как дела?",
  "timestamp": "2023-12-06T12:05:00.000Z",
  "isRead": false,
  "readBy": [],
  "sender": "656f176ff4e322b83fb8828d"
}
```

---

### `PUT /api/chats/{chatId}/messages/read`
Отметить сообщения как прочитанные

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "message": "Сообщения отмечены как прочитанные",
  "markedCount": 3
}
```

---

### `DELETE /api/chats/{chatId}`
Деактивация чата

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "message": "Чат успешно деактивирован"
}
```

---

## 🔍 Поиск (`/api/search`)

### `GET /api/search/stats`
Получение статистики поиска

**Публичный эндпоинт** (не требует аутентификации)

**Успешный ответ (200):**
```json
{
  "t": 15,                      // Всего ищут
  "m": 8,                       // Мужчин ищут
  "f": 7,                       // Женщин ищут
  "online": {
    "t": 45,                    // Всего онлайн
    "m": 23,                    // Мужчин онлайн
    "f": 22                     // Женщин онлайн
  },
  "avgSearchTime": {
    "t": 0,                     // Среднее время поиска (всего)
    "m": 0,                     // Среднее время поиска (мужчины)
    "f": 0,                     // Среднее время поиска (женщины)
    "matches24h": 42            // Мэтчей за 24 часа
  }
}
```

---

## 💰 Монетизация (`/api/monetization`)

### `GET /api/monetization/status`
Получение статуса пользователя

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "success": true,
  "data": {
    "subscription": {
      "type": "premium",
      "isActive": true,
      "expiresAt": "2024-01-06T12:00:00.000Z",
      "features": {
        "unlimitedSearches": true,
        
        "advancedFilters": true,
        "priorityInSearch": true,
        
        "analytics": true
      }
    },
    "currency": {
    "boosts": 3
    },
    "limits": {
      "searchesToday": 2,
      "maxSearches": "unlimited",
      "resetsAt": "2023-12-07T00:00:00.000Z"
    },
    "analytics": {
      "profileViews": 42,
      "matches": 8,
      "likes": 15
    }
  }
}
```

---

### `GET /api/monetization/tiers`
Получение доступных тарифов

**Публичный эндпоинт**

**Успешный ответ (200):**
```json
{
  "success": true,
  "data": {
    "basic": {
      "type": "basic",
      "price": 0,
      "duration": 0,
      "features": {
        "unlimitedSearches": false,
        
        "advancedFilters": false,
        "priorityInSearch": false,
        
        "analytics": false
      }
    },
    "premium": {
      "type": "premium",
      "price": 199,
      "duration": 30,
      "features": {
        "unlimitedSearches": true,
        
        "advancedFilters": true,
        "priorityInSearch": true,
        
        "analytics": true
      }
    },
    
  }
}
```

---

### `GET /api/monetization/items`
Получение доступных товаров

**Публичный эндпоинт**

**Успешный ответ (200):**
```json
{
  "success": true,
  "data": {
    "boosts_1": { "type": "boosts", "amount": 1, "price": 99 },
    "boosts_5": { "type": "boosts", "amount": 5, "price": 399 },
    "premium": { "type": "subscription", "subscriptionType": "premium", "price": 199 }
  }
}
```

---

### `POST /api/monetization/purchase`
Совершение покупки

**Заголовки:** `Authorization: Bearer <token>`

**Тело запроса:**
```json
{
  "itemKey": "premium",
  "paymentData": {
    "payment_id": "12345",
    "amount": 59,
    "currency": "RUB",
    "method": "card"
  }
}
```

**Успешный ответ (200), если требуется подтверждение:**
```json
{
  "success": true,
  "redirectUrl": "https://yookassa.ru/pay/confirmation-url",
  "paymentId": "2a2f51a0-000f-5000-9000-1abc2def3456",
  "message": "Перейдите по ссылке для оплаты"
}
```

**Успешный ответ (200), если платёж сразу прошёл:**
```json
{
  "success": true,
  "message": "Подписка premium активирована!"
}
```

**Возможные ошибки:**
- `400` - Товар не найден или ошибка валидации
- `402` - Ошибка платежа
- `500` - Внутренняя ошибка сервера

---

### `POST /api/monetization/webhook/yookassa`
Вебхук от YooKassa

**Тело запроса (пример):**
```json
{
  "event": "payment.succeeded",
  "object": {
    "id": "2a2f51a0-000f-5000-9000-1abc2def3456",
    "status": "succeeded",
    "paid": true,
    "metadata": { "userId": "656f176ff4e322b83fb8828d", "itemKey": "premium" }
  }
}
```

**Ответы:**
- 200: `{ "success": true, "message": "Payment confirmed" }`
- 400: `{ "success": false, "error": "Payment not confirmed" }`

---

### `GET /api/monetization/check/search`
Проверка возможности поиска

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "success": true,
  "data": {
    "canSearch": true
  }
}
```

**Если поиск недоступен:**
```json
{
  "success": true,
  "data": {
    "canSearch": false,
    "reason": "Достигнут дневной лимит поисков (5). Купите Premium для безлимитного поиска."
  }
}
```

---

### `GET /api/monetization/limits/search`
Получение лимитов поиска

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "success": true,
  "data": {
    "searchesToday": 2,
    "maxSearches": 5,
    "unlimited": false,
    "remaining": 3,
    "resetsAt": "2023-12-07T00:00:00.000Z",
    "subscriptionType": "basic"
  }
}
```

---

### `GET /api/monetization/check/boost`
Проверка возможности использования буста

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "success": true,
  "data": {
    "canUse": true,
    "available": 3
  }
}
```

---

 

---

 

---

## 📊 Мониторинг (`/api/monitoring`)

### `GET /api/monitoring/metrics`
Получение метрик системы

**Заголовки:** `Authorization: Bearer <token>`

**Успешный ответ (200):**
```json
{
  "connections": {
    "current": 42,
    "total": 1250,
    "peak": 78
  },
  "messages": {
    "total": 15420,
    "perMinute": 125
  },
  "searches": {
    "active": 8,
    "total": 850,
    "successful": 720
  },
  "latency": {
    "avg": 45.2
  },
  "errors": {
    "count": 12,
    "lastError": "Connection timeout"
  },
  "timestamp": "2023-12-06T12:00:00.000Z",
  "uptime": 86400
}
```

---

### `GET /api/monitoring/health`
Проверка состояния системы

**Публичный эндпоинт**

**Успешный ответ (200):**
```json
{
  "status": "OK",
  "timestamp": "2023-12-06T12:00:00.000Z",
  "services": {
    "websocket": {
      "status": "OK",
      "activeConnections": 42
    },
    "search": {
      "status": "OK", 
      "activeSearches": 8
    }
  },
  "performance": {
    "messageLatency": "45.20ms",
    "messagesPerMinute": 125
  },
  "errors": {
    "count": 12,
    "lastError": "Connection timeout"
  }
}
```

**При проблемах (503):**
```json
{
  "status": "ERROR",
  "services": {
    "websocket": {
      "status": "ERROR",
      "activeConnections": 0
    }
  }
}
```

---

## 🌐 Общие эндпоинты

### `GET /health`
Базовая проверка здоровья системы

**Публичный эндпоинт**

**Успешный ответ (200):**
```json
{
  "status": "OK"
}
```

---

## ⚠️ Коды ошибок и ответы

### Стандартные HTTP коды:
- `200` - Успешный запрос
- `201` - Ресурс создан
- `400` - Ошибка валидации данных
- `401` - Не авторизован (отсутствует или недействительный токен)
- `403` - Доступ запрещен
- `404` - Ресурс не найден
- `409` - Конфликт (например, пользователь уже существует)
- `413` - Слишком большой размер запроса
- `429` - Слишком много запросов (rate limiting)
- `500` - Внутренняя ошибка сервера
- `503` - Сервис временно недоступен

### Формат ошибок:
```json
{
  "error": "Описание ошибки",
  "code": "ERROR_CODE",           // Опционально
  "details": {                   // Опционально
    "field": "Детали ошибки"
  }
}
```

### Ошибки валидации:
```json
{
  "error": "Ошибка валидации",
  "details": [
    {
      "field": "age",
      "message": "Возраст должен быть больше 18"
    },
    {
      "field": "gender", 
      "message": "Неверное значение пола"
    }
  ]
}
```

---

## 🔧 Дополнительная информация

### Rate Limiting
- Большинство эндпоинтов имеют ограничения по частоте запросов
- При превышении лимита возвращается код `429`
- Лимиты указываются в заголовках ответа:
  ```
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 95
  X-RateLimit-Reset: 1640995200
  ```

### Пагинация
Эндпоинты, возвращающие списки, поддерживают пагинацию:
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "pages": 8
  }
}
```

### Фильтрация и сортировка
Многие эндпоинты поддерживают параметры фильтрации:
```
GET /api/users?gender=female&age_min=20&age_max=30&sort=rating&order=desc
```

### CORS
API поддерживает CORS для веб-приложений:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

### Swagger UI
Интерактивная документация доступна по адресу: `/api-docs`