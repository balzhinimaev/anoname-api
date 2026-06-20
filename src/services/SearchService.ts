import Search, { ISearch } from '../models/Search';
import Chat from '../models/Chat';
import { wsManager } from '../server';
import mongoose from 'mongoose';
import { wsLogger } from '../utils/logger';
import logger from '../utils/logger';
import User from '../models/User';
import { MonetizationService } from './MonetizationService';
import { BlockService } from './BlockService';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { ReferralService } from './ReferralService';

export interface SearchCriteria {
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
  maxDistance?: number; // не используется как ограничение, оставлено для обратной совместимости
}

export interface SearchResult {
  status: 'searching' | 'matched' | 'cancelled' | 'expired';
  userId: mongoose.Types.ObjectId;
  telegramId: string;
  matchedWith?: {
    userId: mongoose.Types.ObjectId;
    telegramId: string;
    chatId: mongoose.Types.ObjectId;
  };
}

export class SearchService {
  private static statsCache: {
    data: any;
    timestamp: number;
  } | null = null;
  private static readonly CACHE_TTL = 5000; // 5 секунд

  static async startSearch(
    userId: string,
    telegramId: string,
    criteria: SearchCriteria
  ): Promise<SearchResult> {
    wsLogger.info('search_service_entered', `SearchService.startSearch entered for user ${userId}`, { userId, telegramId });
    // === ПРОВЕРКА МОНЕТИЗАЦИИ ===
    wsLogger.info('monetization_check_start', `Checking monetization for user ${userId}`, { userId });
    const canSearch = await MonetizationService.canUserSearch(userId);
    wsLogger.info('monetization_check_end', `Monetization check for user ${userId} completed`, { userId, canSearch });
    if (!canSearch.canSearch) {
      wsLogger.warn('monetization_fail', `Search denied for user ${userId} due to monetization`, { userId, reason: canSearch.reason });
      throw new Error(canSearch.reason || 'Поиск недоступен');
    }

    // НЕ списываем попытку здесь - только при успешном матче

    // Добавляем логирование полученных критериев
    wsLogger.info('search_service_start', 'Запуск поиска в сервисе', {
      userId,
      telegramId,
      criteria: {
        gender: criteria.gender,
        age: criteria.age,
        desiredGender: criteria.desiredGender,
        desiredAgeMin: criteria.desiredAgeMin,
        desiredAgeMax: criteria.desiredAgeMax,
        useGeolocation: criteria.useGeolocation,
        hasLocation: !!criteria.location,
        location: criteria.location ? {
          longitude: criteria.location.longitude,
          latitude: criteria.location.latitude
        } : null,
        maxDistance: criteria.maxDistance
      }
    });
    
    // Централизованное логирование вместо console.log
    logger.debug('Search start request', {
      userId,
      telegramId,
      useGeolocation: criteria.useGeolocation,
      location: criteria.location,
      maxDistance: criteria.maxDistance
    });

    // Отменяем предыдущий поиск, если есть
    await Search.findOneAndUpdate(
      { userId, status: 'searching' },
      { status: 'cancelled' }
    );

    // Узнаем премиум-статус пользователя (снимок на момент старта поиска)
    let isPremium = false;
    try {
      const u = await User.findById(userId).select('subscription').lean();
      if (u && (u as any).subscription?.isActive && (u as any).subscription?.type && (u as any).subscription.type !== 'basic') {
        isPremium = true;
      }
    } catch {}

    // Создаем объект для нового поиска
    const searchData: any = {
      userId: new mongoose.Types.ObjectId(userId),
      telegramId,
      status: 'searching',
      gender: criteria.gender,
      age: criteria.age,
      rating: criteria.rating ?? 0,
      desiredGender: criteria.desiredGender,
      desiredAgeMin: criteria.desiredAgeMin,
      desiredAgeMax: criteria.desiredAgeMax,
      minAcceptableRating: criteria.minAcceptableRating ?? -1,
      useGeolocation: criteria.useGeolocation,
      // maxDistance устанавливаем только если используется геолокация
      // Не ограничиваем максимальную дистанцию — ищем без $maxDistance
      maxDistance: undefined,
      isPremium
    };

    // Добавляем местоположение только если используется геолокация и координаты предоставлены.
    // Огрубляем до ~1 км сетки (3 знака после запятой) — снижает точность таргетинга/триангуляции,
    // сохраняя пригодность для поиска «рядом».
    if (criteria.useGeolocation && criteria.location) {
      const round3 = (n: number) => Math.round(n * 1000) / 1000;
      searchData.location = {
        type: 'Point',
        coordinates: [round3(criteria.location.longitude), round3(criteria.location.latitude)]
      };
    }

    // Создаем новый поиск
    const search = await Search.create(searchData);
    
    // Логируем созданную запись поиска с фокусом на геоданные
    // Аналитика: search_start (снимок критериев)
    try {
      // Опционально подтянем cohort пользователя для аналитики
      let userCohort: 'A' | 'B' | undefined = undefined;
      try {
        const u = await User.findById(userId).select('cohort').lean();
        userCohort = (u as any)?.cohort as any;
      } catch {}
      await AnalyticsEvent.create({
        userId: new mongoose.Types.ObjectId(userId),
        telegramId,
        cohort: userCohort,
        name: 'search_start',
        props: {
          gender: criteria.gender,
          age: criteria.age,
          desiredGender: criteria.desiredGender,
          desiredAgeMin: criteria.desiredAgeMin,
          desiredAgeMax: criteria.desiredAgeMax,
          minAcceptableRating: criteria.minAcceptableRating ?? -1,
          useGeolocation: criteria.useGeolocation,
          distanceKm: criteria.maxDistance ?? null
        }
      } as any);
    } catch {}
    wsLogger.info('search_record_created', 'Запись поиска создана', {
      userId,
      searchId: search._id?.toString(),
      useGeolocation: search.useGeolocation,
      hasLocation: !!search.location,
      coordinates: search.location ? search.location.coordinates : null,
      maxDistance: search.maxDistance
    });
    
    // Ищем подходящий мэтч
    const matches = await this.findMatches(search);
    if (matches.length > 0) {
      // Выбираем лучший мэтч
      const bestMatch = this.selectBestMatch(search, matches);
      if (search._id && bestMatch._id) {
        await this.createMatch(
          search as ISearch & { _id: mongoose.Types.ObjectId },
          bestMatch as ISearch & { _id: mongoose.Types.ObjectId }
        );
          // Аналитика: search_end (matched)
          try {
            const durationMs = Date.now() - (search.createdAt ? new Date(search.createdAt).getTime() : Date.now());
            await AnalyticsEvent.create({
              userId: search.userId,
              telegramId: search.telegramId,
              name: 'search_end',
              props: {
                outcome: 'matched',
                durationMs,
                useGeolocation: search.useGeolocation
              }
            } as any);
          } catch {}
          // Рефералы: отметим квалификацию и наградим реферера (best-effort)
          try { await ReferralService.markQualified(String(search.userId)); } catch {}
          try { await ReferralService.rewardReferrer(String(search.userId)); } catch {}
      }
    }

    // Атомарно обновляем статистику после начала поиска
    await this.updateAndBroadcastStats('start', userId);

    // Преобразуем результат в SearchResult
    return {
      status: search.status as 'searching' | 'matched' | 'cancelled' | 'expired',
      userId: search.userId,
      telegramId: search.telegramId,
      matchedWith: search.matchedWith ? {
        userId: search.matchedWith.userId,
        telegramId: search.matchedWith.telegramId,
        chatId: search.matchedWith.chatId as mongoose.Types.ObjectId
      } : undefined
    };
  }

  static async cancelSearch(userId: string) {
    const search = await Search.findOneAndUpdate(
      { userId, status: 'searching' },
      { status: 'cancelled' },
      { new: true }
    );

    // Атомарно обновляем статистику после отмены поиска
    await this.updateAndBroadcastStats('cancel', userId);

    // Аналитика: search_end (cancelled)
    if (search) {
      try {
        const durationMs = Date.now() - (search.createdAt ? new Date(search.createdAt).getTime() : Date.now());
        await AnalyticsEvent.create({
          userId: search.userId,
          telegramId: search.telegramId,
          name: 'search_end',
          props: {
            outcome: 'cancelled',
            durationMs,
            useGeolocation: search.useGeolocation
          }
        } as any);
      } catch {}
    }
    return search;
  }

  private static async findMatches(search: ISearch): Promise<ISearch[]> {
    // Базовые критерии поиска
    const matchCriteria: any = {
      status: 'searching',
      userId: { $ne: search.userId },
    };

    // Корректная обработка желаемого пола
    let gendersToMatch: ('male' | 'female')[] = [];
    if (search.desiredGender.includes('any')) {
      gendersToMatch = ['male', 'female'];
    } else {
      // Убедимся, что отфильтровываем 'any', если он там случайно оказался,
      // и приводим к нужному типу.
      gendersToMatch = search.desiredGender.filter(g => g === 'male' || g === 'female') as ('male' | 'female')[];
    }
    matchCriteria.gender = { $in: gendersToMatch };

    // Проверяем, что наш пол соответствует желаемому полу других
    matchCriteria.desiredGender = {
      $in: [search.gender, 'any']
    };

    // Проверяем возрастные ограничения (в обе стороны)
    matchCriteria.age = { 
      $gte: search.desiredAgeMin,
      $lte: search.desiredAgeMax
    };
    matchCriteria.desiredAgeMin = { $lte: search.age };
    matchCriteria.desiredAgeMax = { $gte: search.age };

    // Добавляем фильтр по рейтингу
    if (search.minAcceptableRating > -1) {
      matchCriteria.rating = { $gte: search.minAcceptableRating };
    }

    // Если мы не используем геолокацию, ищем только тех, кто тоже ее не использует
    if (!search.useGeolocation) {
      matchCriteria.useGeolocation = false;
    }
    // Если используем геолокацию, применяем стандартную логику
    else if (search.useGeolocation && search.location && Array.isArray(search.location.coordinates)) {
      matchCriteria.useGeolocation = true;
      // Ограничиваем радиус поиска по конфигу тарифа/настроек
      const DEFAULT_MAX_KM = 20; // базовый радиус по умолчанию (можно вынести в конфиг/тариф)
      // Если в документе поиска maxDistance отсутствует (так как не храним), используем дефолт
      const km = DEFAULT_MAX_KM;
      const meters = km * 1000;
      matchCriteria.location = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: search.location.coordinates
          },
          $maxDistance: meters
        }
      };
    } else if (search.useGeolocation) {
      // Логируем случай, когда геолокация включена, но данные некорректны
      wsLogger.warn('invalid_geo_data_in_find', 'Геолокация включена, но данные отсутствуют или некорректны в документе поиска', {
        searchId: search._id?.toString(),
        location: search.location
      });
      // В этом случае мы не можем выполнить гео-поиск, поэтому ищем без него.
      // Это предотвратит падение, но покажет проблему в данных.
      matchCriteria.useGeolocation = false;
    }

    // Для non-geo запросов можно сразу приоритизировать очередь сортировкой по премиуму и времени ожидания
    const isGeo = !!matchCriteria.location;
    const candidates = !isGeo
      ? await Search.find(matchCriteria).sort({ isPremium: -1, createdAt: 1 })
      : await Search.find(matchCriteria);

    // Исключаем пары, где есть блок (в любую сторону)
    // Оптимизация: получаем наборы блокировок для текущего пользователя одним запросом
    try {
      const { blockedByMeIds, blockedMeIds } = await BlockService.getActiveBlocksForUser(String(search.userId));
      const filtered = candidates.filter((cand) => {
        const candId = String(cand.userId);
        return !(blockedByMeIds.has(candId) || blockedMeIds.has(candId));
      });
      return filtered;
    } catch {
      // В случае ошибки проверки вернём исходные кандидаты, чтобы не ломать поиск
      return candidates;
    }
  }

  private static selectBestMatch(search: ISearch, matches: ISearch[]): ISearch {
    try {
      if (!matches || matches.length === 0) {
        wsLogger.info('select_best_match', 'Попытка выбрать лучший матч из пустого массива', {
          searchId: search._id?.toString()
        });
        throw new Error('No matches available for selection');
      }

      // Приоритезация: premium первыми, затем по времени ожидания (createdAt ASC), и только затем по скору
      const sorted = matches.slice().sort((a: any, b: any) => {
        const ap = a.isPremium ? 1 : 0;
        const bp = b.isPremium ? 1 : 0;
        if (ap !== bp) return bp - ap; // premium desc
        const ac = (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const bc = (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        if (ac !== bc) return ac - bc; // older first
        // Tie-breaker: по скору совместимости
        const as = this.calculateMatchScore(search, a);
        const bs = this.calculateMatchScore(search, b);
        return bs - as;
      });

      return sorted[0];
    } catch (error) {
      wsLogger.warn('select_best_match', (error as Error).message, {
        searchId: search._id?.toString()
      });
      return matches[0];
    }
  }

  private static calculateMatchScore(search: ISearch, match: ISearch): number {
    try {
      let score = 0;

      // Близость рейтинга (максимум 40 баллов)
      const searchRating = typeof search.rating === 'number' ? search.rating : 0;
      const matchRating = typeof match.rating === 'number' ? match.rating : 0;
      const ratingDiff = Math.abs(searchRating - matchRating);
      score += Math.max(0, 40 - ratingDiff * 2);

      // Близость возраста (максимум 30 баллов)
      const searchAge = typeof search.age === 'number' ? search.age : 25;
      const matchAge = typeof match.age === 'number' ? match.age : 25;
      const ageDiff = Math.abs(searchAge - matchAge);
      score += Math.max(0, 30 - ageDiff * 2);

      // Геолокация (максимум 30 баллов)
      if (search.useGeolocation && match.useGeolocation && 
          search.location && match.location && 
          search.location.coordinates && match.location.coordinates &&
          search.location.coordinates.length >= 2 && match.location.coordinates.length >= 2) {
        try {
          const distance = this.calculateDistance(
            search.location.coordinates as [number, number],
            match.location.coordinates as [number, number]
          );
          score += Math.max(0, 30 - (distance / 1000)); // distance в км
        } catch (error) {
          // Ошибка при расчете расстояния - просто не добавляем эти баллы
          wsLogger.warn('distance_calc', (error as Error).message, {
            matchId: match._id?.toString()
          });
        }
      }

      return score;
    } catch (error) {
      wsLogger.warn('match_score', (error as Error).message, {
        searchId: search._id?.toString(),
        matchId: match._id?.toString()
      });
      // В случае ошибки возвращаем базовый счет
      return 50; // базовый счет по умолчанию
    }
  }

  private static calculateDistance(coord1: [number, number], coord2: [number, number]): number {
    try {
      // Проверка на валидность координат
      if (!coord1 || !coord2 || coord1.length < 2 || coord2.length < 2 ||
          typeof coord1[0] !== 'number' || typeof coord1[1] !== 'number' ||
          typeof coord2[0] !== 'number' || typeof coord2[1] !== 'number' ||
          isNaN(coord1[0]) || isNaN(coord1[1]) || isNaN(coord2[0]) || isNaN(coord2[1])) {
        throw new Error('Invalid coordinates for distance calculation');
      }

      // Реализация формулы гаверсинусов для расчета расстояния между точками
      const R = 6371e3; // радиус Земли в метрах
      const φ1 = (coord1[1] * Math.PI) / 180;
      const φ2 = (coord2[1] * Math.PI) / 180;
      const Δφ = ((coord2[1] - coord1[1]) * Math.PI) / 180;
      const Δλ = ((coord2[0] - coord1[0]) * Math.PI) / 180;

      const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
      
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1-a))); // Защита от отрицательных значений

      return R * c; // расстояние в метрах
    } catch (error) {
      wsLogger.warn('distance_calculation', (error as Error).message, {
        coord1: JSON.stringify(coord1),
        coord2: JSON.stringify(coord2)
      });
      return 10000; // возвращаем 10км как безопасное значение по умолчанию
    }
  }

  private static async createMatch(search1: ISearch & { _id: mongoose.Types.ObjectId }, search2: ISearch & { _id: mongoose.Types.ObjectId }) {
    // Транзакционный, безопасный к гонкам процесс создания мэтча
    const MAX_RETRIES = 3;
    let lastError: any = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const session = await mongoose.startSession();
      try {
        let createdChat: any = null;
        await session.withTransaction(async () => {
          // 1) Повторно читаем документы поиска в транзакции
          const s1 = await Search.findById(search1._id).session(session);
          const s2 = await Search.findById(search2._id).session(session);

          if (!s1 || !s2) {
            throw new Error('Search documents not found');
          }
          if (s1.status !== 'searching' || s2.status !== 'searching') {
            throw new Error('One of searches is not in searching state');
          }

          // 2) Проверим, нет ли уже активного чата между участниками
          const existingChat = await Chat.findOne({
            participants: { $all: [s1.userId, s2.userId] },
            isActive: true
          }).session(session);

          if (existingChat) {
            // Обновим оба поиска на matched к найденному чату, если ещё searching
            const upd1 = await Search.updateOne(
              { _id: s1._id, status: 'searching' },
              {
                $set: {
                  status: 'matched',
                  matchedWith: {
                    userId: s2.userId,
                    telegramId: s2.telegramId,
                    chatId: existingChat._id as any
                  }
                }
              }
            ).session(session);
            const upd2 = await Search.updateOne(
              { _id: s2._id, status: 'searching' },
              {
                $set: {
                  status: 'matched',
                  matchedWith: {
                    userId: s1.userId,
                    telegramId: s1.telegramId,
                    chatId: existingChat._id as any
                  }
                }
              }
            ).session(session);

            if (upd1.modifiedCount !== 1 || upd2.modifiedCount !== 1) {
              throw new Error('Concurrent match update detected');
            }

            // Списываем попытки
            await Promise.all([
              MonetizationService.useSearchAttempt(String(s1.userId)),
              MonetizationService.useSearchAttempt(String(s2.userId))
            ]);

            createdChat = existingChat;
            return; // выходим из транзакции
          }

          // 3) Создаём чат внутри транзакции
          const [chat] = await Chat.create([
            {
              participants: [s1.userId, s2.userId],
              type: 'anonymous',
              isActive: true
            }
          ], { session });

          if (!chat || !chat._id) {
            throw new Error('Failed to create chat for match');
          }

          // 4) Обновляем статусы обоих поисков условно (только если всё ещё searching)
          const upd1 = await Search.updateOne(
            { _id: s1._id, status: 'searching' },
            {
              $set: {
                status: 'matched',
                matchedWith: {
                  userId: s2.userId,
                  telegramId: s2.telegramId,
                  chatId: chat._id as any
                }
              }
            }
          ).session(session);
          const upd2 = await Search.updateOne(
            { _id: s2._id, status: 'searching' },
            {
              $set: {
                status: 'matched',
                matchedWith: {
                  userId: s1.userId,
                  telegramId: s1.telegramId,
                  chatId: chat._id as any
                }
              }
            }
          ).session(session);

          if (upd1.modifiedCount !== 1 || upd2.modifiedCount !== 1) {
            throw new Error('Concurrent match update detected');
          }

          // 5) Списываем попытки внутри транзакции
          await Promise.all([
            MonetizationService.useSearchAttempt(String(s1.userId)),
            MonetizationService.useSearchAttempt(String(s2.userId))
          ]);

          createdChat = chat;
        }, {
          // Опционально можем указать уровни согласованности
        });

        // Транзакция успешно завершена
        if (createdChat) {
          wsLogger.info('match_created', 'Создан новый матч (tx)', {
            chatId: createdChat._id.toString(),
            search1Id: search1._id.toString(),
            search2Id: search2._id.toString(),
          });

          // Получаем дополнительную информацию о пользователях для уведомлений
          const [user1Data, user2Data] = await Promise.all([
            User.findById(search1.userId).select('rating username firstName lastName profilePhoto photos subscription').lean(),
            User.findById(search2.userId).select('rating username firstName lastName profilePhoto photos subscription').lean()
          ]);

          // Уведомления пользователям (вне транзакции)
          // PII: в анонимном матче НЕ раскрываем telegramId/@username/фамилию партнёра.
          // Оставляем безопасные для отображения поля (имя, фото, пол/возраст/рейтинг).
          wsManager.sendToUser(String(search1.userId), 'search:matched', {
            matchedUser: {
              gender: search2.gender,
              age: search2.age,
              rating: user2Data?.rating || 0,
              firstName: user2Data?.firstName,
              profilePhoto: user2Data?.profilePhoto,
              photos: user2Data?.photos,
              isPremium: !!(user2Data?.subscription?.isActive && user2Data?.subscription?.type && user2Data?.subscription?.type !== 'basic'),
              chatId: createdChat._id.toString()
            }
          });
          wsManager.sendToUser(String(search2.userId), 'search:matched', {
            matchedUser: {
              gender: search1.gender,
              age: search1.age,
              rating: user1Data?.rating || 0,
              firstName: user1Data?.firstName,
              profilePhoto: user1Data?.profilePhoto,
              photos: user1Data?.photos,
              isPremium: !!(user1Data?.subscription?.isActive && user1Data?.subscription?.type && user1Data?.subscription?.type !== 'basic'),
              chatId: createdChat._id.toString()
            }
          });

          await this.updateAndBroadcastStats('match', String(search1.userId));
          await session.endSession();
          return createdChat;
        }

        await session.endSession();
        return null;

      } catch (error: any) {
        lastError = error;
        try { await session.endSession(); } catch {}
        wsLogger.warn('create_match_tx', error?.message || String(error), {
          attempt,
          search1Id: String(search1._id),
          search2Id: String(search2._id)
        });
        // При временных конфликтах — повторим
        if (attempt < MAX_RETRIES) {
          continue;
        } else {
          throw error;
        }
      }
    }
    // Если дошли сюда — значит все попытки провалились
    throw lastError || new Error('Failed to create match after retries');
  }

  static async getSearchStats() {
    // Проверяем кэш
    if (this.statsCache && Date.now() - this.statsCache.timestamp < this.CACHE_TTL) {
      return this.statsCache.data;
    }

    // Получаем количество пользователей в поиске
    const [totalSearching, maleSearching, femaleSearching, activeChatsCount] = await Promise.all([
      Search.countDocuments({ status: 'searching' }),
      Search.countDocuments({ status: 'searching', gender: 'male' }),
      Search.countDocuments({ status: 'searching', gender: 'female' }),
      Chat.countDocuments({ isActive: true }),
    ]);

    // Получаем общее количество активных пользователей онлайн
    const totalOnline = await User.countDocuments({
      isOnline: true
    });

    // Получаем статистику по времени поиска и мэтчам за 24 часа
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const matches24h = await Search.countDocuments({
      status: 'matched',
      updatedAt: { $gte: oneDayAgo }
    });

    // Собираем и возвращаем статистику
    const stats = {
      t: totalSearching,
      m: maleSearching,
      f: femaleSearching,
      inChat: activeChatsCount * 2, // Каждый активный чат имеет 2 участника
      online: {
        t: totalOnline,
        m: 0,
        f: 0
      },
      avgSearchTime: {
        t: 0, // Эти значения могут быть заполнены реальными данными позже
        m: 0,
        f: 0,
        matches24h
      }
    };

    // Обновляем кэш
    this.statsCache = {
      data: stats,
      timestamp: Date.now()
    };

    return stats;
  }

  static async getUserActiveSearch(userId: string) {
    return await Search.findOne({
      userId,
      status: 'searching'
    });
  }

  public static async broadcastSearchStats() {
    try {
      const stats = await this.getSearchStats();
      wsManager.io.to('search_stats_room').emit('search:stats', stats);
      return stats; // Возвращаем stats для соответствия предыдущему Promise<any>
    } catch (error) {
      logger.error('Failed to broadcast search stats', {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
      });
      return null; // Возвращаем null в случае ошибки
    }
  }

  private static async updateAndBroadcastStats(action: 'start' | 'cancel' | 'match', userId: string) {
    // Вынесли обновление статистики в отдельный метод для атомарности
    try {
      // Если статистика уже обновляется, планируем еще одно обновление после завершения текущего
      if (this.updatingStats) {
        this.pendingUpdates = true;
        return;
      }

      this.updatingStats = true;

      // Если у нас есть кэш и он свежий, то обновим его инкрементально
      if (this.statsCache && Date.now() - this.statsCache.timestamp < this.CACHE_TTL) {
        // Получаем пол пользователя для инкрементного обновления статистики
        const user = await Search.findOne({ userId });
        const gender = user?.gender;

        if (gender) {
          // Логируем, что выполняем инкрементное обновление
          wsLogger.info('stats_incremental_update', 'Инкрементное обновление кэша (' + action + ' поиска)', {
            gender,
            userId
          });

          // Инкрементально обновляем статистику в зависимости от действия
          if (action === 'start') {
            this.statsCache.data.t++;
            if (gender === 'male') this.statsCache.data.m++;
            else if (gender === 'female') this.statsCache.data.f++;
          } else if (action === 'cancel') {
            this.statsCache.data.t = Math.max(0, this.statsCache.data.t - 1);
            if (gender === 'male') this.statsCache.data.m = Math.max(0, this.statsCache.data.m - 1);
            else if (gender === 'female') this.statsCache.data.f = Math.max(0, this.statsCache.data.f - 1);
          } else if (action === 'match') {
            // При мэтче двое покидают поиск
            this.statsCache.data.t = Math.max(0, this.statsCache.data.t - 2);
            
            // Двое входят в чат
            this.statsCache.data.inChat = (this.statsCache.data.inChat || 0) + 2;
            
            // Увеличиваем счетчик мэтчей
            this.statsCache.data.avgSearchTime.matches24h++;
            
            // Мы не знаем пол второго участника, поэтому просто сокращаем общее количество
            // и корректируем пол известного нам участника
            if (gender === 'male') this.statsCache.data.m = Math.max(0, this.statsCache.data.m - 1);
            else if (gender === 'female') this.statsCache.data.f = Math.max(0, this.statsCache.data.f - 1);
          }

          // Обновляем временную метку кэша
          this.statsCache.timestamp = Date.now();
        }
      } else {
        // Если кэша нет или он устарел, запрашиваем полные данные
        await this.getSearchStats();
      }

      // Отправляем обновленную статистику всем подписчикам
      wsLogger.info('stats_force_update', 'Статистика отправлена после действия: ' + action, {
        userId,
        stats: this.statsCache?.data,
        fromCache: !!this.statsCache
      });
      await this.broadcastSearchStats();

      this.updatingStats = false;

      // Если были отложенные обновления, выполняем еще одно
      if (this.pendingUpdates) {
        this.pendingUpdates = false;
        // Используем setTimeout, чтобы избежать слишком глубокой рекурсии
        setTimeout(() => this.broadcastSearchStats(), 0);
      }
    } catch (error) {
      this.updatingStats = false;
      logger.error('Failed to update and broadcast stats', {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
      });
      throw error;
    }
  }

  private static updatingStats = false;
  private static pendingUpdates = false;
} 