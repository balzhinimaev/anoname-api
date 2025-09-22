# Lead Migration Script

Скрипт для миграции лидов из файла `user_ids.txt` в коллекцию `Lead`.

## Описание

Этот скрипт читает Telegram ID из текстового файла и создает соответствующие записи в коллекции `Lead`. Если пользователь уже находится в коллекции `Prelaunch`, добавляется поле `prelaunched: true`.

## Использование

```bash
npm run migrate-leads <path-to-user_ids.txt>
```

### Примеры

```bash
# Миграция из файла в корне проекта
npm run migrate-leads ./user_ids.txt

# Миграция из файла в другой директории
npm run migrate-leads /path/to/user_ids.txt

# Миграция из файла с абсолютным путем
npm run migrate-leads C:\Users\Username\user_ids.txt
```

## Формат файла

Файл должен содержать один Telegram ID на строку:

```
123456789
987654321
555666777
```

## Что делает скрипт

1. **Читает файл** - загружает все Telegram ID из указанного файла
2. **Проверяет дубликаты** - пропускает лиды, которые уже существуют
3. **Проверяет прелаунч** - определяет, находится ли пользователь в коллекции `Prelaunch`
4. **Создает лиды** - создает записи в коллекции `Lead` с соответствующими полями
5. **Выводит статистику** - показывает результаты миграции

## Поля создаваемых лидов

- `telegramId` - ID пользователя Telegram
- `createdAt` - дата создания (текущее время)
- `isRegistered` - всегда `false` (это лиды, не зарегистрированные пользователи)
- `prelaunched` - `true` если пользователь в `Prelaunch`, иначе `false`

## Безопасность

- Скрипт не удаляет существующие лиды
- Проверяет уникальность по `telegramId`
- Обрабатывает ошибки без остановки процесса
- Добавляет задержки для снижения нагрузки на БД

## Требования

- Переменные окружения должны быть настроены (особенно `MONGO_URI`)
- Файл с ID должен существовать и быть доступен для чтения
- Подключение к MongoDB должно работать

## Логирование

Скрипт выводит подробную информацию о процессе:
- Количество найденных ID
- Прогресс обработки
- Статистику результатов
- Ошибки (если есть)

## Пример вывода

```
🚀 Starting lead migration from file...
📁 File path: ./user_ids.txt
✅ Connected to database
📁 Found 1500 valid user IDs in file
📊 Processing 1500 user IDs...

[1/1500] Processing 123456789...
✅ Created lead for 123456789 (prelaunched)

[2/1500] Processing 987654321...
✅ Created lead for 987654321

...

📊 Migration Statistics:
========================
Total user IDs processed: 1500
Leads created: 1450
Leads skipped (already exist): 50
Prelaunched users: 200
Errors: 0
Success rate: 96.67%

🎉 Migration completed successfully!
```
