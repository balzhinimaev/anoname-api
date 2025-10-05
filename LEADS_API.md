# Leads API Documentation

## POST /api/leads/add

Добавляет лида в систему.

### Аутентификация
Требуется заголовок `X-Bot-Secret` с секретом из `BOT_BACKEND_SECRET`.

```
X-Bot-Secret: <your-bot-backend-secret>
```

### Тело запроса
```json
{
  "telegramId": "123456789"
}
```

### Ответ

#### Успешный ответ (200 OK)
```json
{
  "success": true,
  "added": true,
  "isNew": true
}
```

#### Поля ответа:
- `success` (boolean) - успешность операции
- `added` (boolean) - был ли лид добавлен
- `isNew` (boolean) - новый лид или уже существующий

#### Ошибки:
- `400 Bad Request` - отсутствует или некорректный telegramId
- `401 Unauthorized` - неверный секрет
- `500 Internal Server Error` - ошибка сервера

## POST /api/leads/tma-open

Фиксирует факт открытия Telegram Mini App из кампаний и обновляет связанные данные лида.

### Аутентификация
Требуется заголовок `X-Bot-Secret` с секретом из `BOT_BACKEND_SECRET`.

### Тело запроса
```json
{
  "telegramId": "123456789",
  "campaignId": "65fd2d1a6f2c3b0a2e4f9876",
  "campaign": "WELCOME",
  "payload": "lead_WELCOME_123456789"
}
```

### Ответ

```json
{
  "success": true,
  "created": false,
  "leadId": "6654ab1c0f2e9b456789abcd",
  "telegramId": "123456789",
  "campaign": "WELCOME",
  "campaignId": "65fd2d1a6f2c3b0a2e4f9876",
  "tmaOpenedAt": "2024-05-11T09:20:35.000Z"
}
```

#### Ошибки:
- `400 Bad Request` – отсутствует обязательный `telegramId`
- `401 Unauthorized` – неверный секрет
- `500 Internal Server Error` – внутренняя ошибка сервера

## GET /api/leads/stats

Получает статистику лидов.

### Аутентификация
Требуется заголовок `X-Bot-Secret` с секретом из `BOT_BACKEND_SECRET`.

### Ответ

#### Успешный ответ (200 OK)
```json
{
  "total": 150,
  "registered": 45,
  "unregistered": 105
}
```

#### Поля ответа:
- `total` (number) - общее количество лидов
- `registered` (number) - количество зарегистрированных лидов
- `unregistered` (number) - количество незарегистрированных лидов

## Админские эндпоинты

### GET /api/admin/leads/stats
Статистика лидов (требует админских прав).

### GET /api/admin/leads/list
Список лидов с пагинацией (требует админских прав).

### GET /api/admin/leads/export.csv
Экспорт лидов в CSV (требует админских прав).

## Логика работы

1. **Добавление лида**: Telegram бот отправляет запрос с `telegramId`
2. **Проверка регистрации**: система проверяет, зарегистрирован ли пользователь в коллекции `User`
3. **Создание лида**: лид создается с соответствующим статусом `isRegistered`
4. **Уведомление**: отправляется уведомление в Telegram канал о новом лиде
5. **При регистрации**: система автоматически находит лида по `telegramId` и устанавливает `isRegistered: true`
6. **Уникальность**: один `telegramId` = одна запись в коллекции лидов

## Уведомления

При добавлении нового лида система автоматически отправляет уведомление в Telegram канал с информацией:
- Telegram ID лида
- Статус регистрации (зарегистрирован/ожидает регистрации)
- Время добавления (МСК)
