# Multi-stage Dockerfile для production сборки

# Стадия 1: Сборка приложения
FROM node:22-alpine AS builder

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json для установки зависимостей
COPY package*.json ./

# Устанавливаем все зависимости (включая dev для сборки)
RUN npm ci && npm cache clean --force

# Копируем исходный код TypeScript
COPY src/ ./src/
COPY tsconfig.json ./

# Компилируем TypeScript в JavaScript
RUN npm run build

# Стадия 2: Production образ
FROM node:22-alpine AS production

# Устанавливаем рабочую директорию
WORKDIR /app

# Создаем непривилегированного пользователя для безопасности
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Копируем package.json для определения зависимостей
COPY package*.json ./

# Устанавливаем только production зависимости
RUN npm ci --only=production && npm cache clean --force

# Копируем скомпилированный код из стадии builder
COPY --from=builder /app/dist ./dist

# Создаем директорию для логов и устанавливаем права
RUN mkdir -p logs && chown -R nodejs:nodejs /app
USER nodejs

# Экспонируем порт
EXPOSE 3001

# Health check для проверки работоспособности приложения
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (res) => { \
    process.exit(res.statusCode === 200 ? 0 : 1) \
  }).on('error', () => process.exit(1))"

# Запуск приложения напрямую через node — надёжный проброс SIGTERM
# (npm как PID 1 не всегда форвардит сигнал → graceful shutdown не срабатывал).
CMD ["node", "dist/server.js"]
