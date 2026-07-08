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
import { GamificationService } from './GamificationService';

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

export interface SearchStatsSnapshot {
  t: number;        // всего в поиске
  m: number;        // мужчин в поиске
  f: number;        // женщин в поиске
  inChat: number;   // людей в активных чатах (чаты × 2)
  online: { t: number; m: number; f: number };
  avgSearchTime: { t: number; m: number; f: number; matches24h: number };
}

export class SearchService {
  // Статистика считается ТОЛЬКО полным пересчётом из БД (несколько countDocuments
  // по индексам). Инкрементальный слой удалён сознательно: он дрейфовал
  // (двойные декременты, потерянные инкременты, вечное продление TTL кэша).
  private static statsCache: {
    data: SearchStatsSnapshot;
    timestamp: number;
  } | null = null;
  private static readonly CACHE_TTL = 3000; // 3 секунды
  // Дебаунс рассылки: события (коннекты/поиски/матчи) приходят пачками
  private static broadcastTimer: NodeJS.Timeout | null = null;
  private static readonly BROADCAST_DEBOUNCE_MS = 300;
  // Single-flight: параллельные запросы при истёкшем кэше делят один пересчёт
  private static recomputeInFlight: Promise<SearchStatsSnapshot> | null = null;

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

    // Отменяем предыдущий поиск, если есть (перебит новым поиском того же юзера)
    const superseded = await Search.findOneAndUpdate(
      { userId, status: 'searching' },
      { status: 'cancelled' }
    );
    if (superseded) { void this.logSearchEnd(superseded, 'cancelled', 'superseded'); }

    // Узнаем премиум-статус пользователя (снимок на момент старта поиска)
    let isPremium = false;
    let platform = 'unknown';
    try {
      const u = await User.findById(userId).select('subscription authProvider').lean();
      if (u) {
        platform = (u as any).authProvider || 'unknown';
        if ((u as any).subscription?.isActive && (u as any).subscription?.type && (u as any).subscription.type !== 'basic') {
          isPremium = true;
        }
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
      isPremium,
      platform
    };

    // Добавляем местоположение только если используется геолокация и координаты предоставлены.
    // Огрубляем до сетки ~1.1 км (2 знака после запятой) — «ближайший без точности»:
    // хватает для ранжирования по расстоянию, но не позволяет таргетинг/триангуляцию.
    // (Раньше было 3 знака ≈ 110 м — точнее, чем заявляли.)
    if (criteria.useGeolocation && criteria.location) {
      const round2 = (n: number) => Math.round(n * 100) / 100;
      searchData.location = {
        type: 'Point',
        coordinates: [round2(criteria.location.longitude), round2(criteria.location.latitude)]
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
        platform,
        name: 'search_start',
        props: {
          gender: criteria.gender,
          age: criteria.age,
          desiredGender: criteria.desiredGender,
          desiredAgeMin: criteria.desiredAgeMin,
          desiredAgeMax: criteria.desiredAgeMax,
          minAcceptableRating: criteria.minAcceptableRating ?? -1,
          useGeolocation: criteria.useGeolocation,
          distanceKm: criteria.maxDistance ?? null,
          platform,
          isPremium
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
    // Ошибка findMatches (например битые гео-координаты) НЕ должна ронять поиск:
    // иначе юзер молча «в поиске» без клиентского статуса и без AI-фолбэка.
    let matches: ISearch[] = [];
    try {
      matches = await this.findMatches(search);
    } catch (e) {
      wsLogger.warn('find_matches_failed', (e as Error).message, { searchId: search._id?.toString() });
    }
    if (matches.length > 0) {
      // Выбираем лучший мэтч
      const bestMatch = await this.selectBestMatch(search, matches);
      if (search._id && bestMatch._id) {
        await this.createMatch(
          search as ISearch & { _id: mongoose.Types.ObjectId },
          bestMatch as ISearch & { _id: mongoose.Types.ObjectId }
        );
          // search_end(matched) логируется ВНУТРИ createMatch для ОБОИХ участников
          // Рефералы: отметим квалификацию и наградим реферера (best-effort)
          try { await ReferralService.markQualified(String(search.userId)); } catch {}
          try { await ReferralService.rewardReferrer(String(search.userId)); } catch {}
      }
    }

    // Атомарно обновляем статистику после начала поиска
    await this.broadcastSearchStats();

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

  static async cancelSearch(userId: string, reason: 'user' | 'disconnect' | 'superseded' = 'user') {
    const search = await Search.findOneAndUpdate(
      { userId, status: 'searching' },
      { status: 'cancelled' },
      { new: true }
    );

    // Атомарно обновляем статистику после отмены поиска
    await this.broadcastSearchStats();

    // Аналитика: search_end (cancelled) с причиной (ручная / обрыв / перебит)
    if (search) { void this.logSearchEnd(search, 'cancelled', reason); }
    return search;
  }

  /** Единая durable-запись конца поиска для сквозной аналитики. */
  private static async logSearchEnd(
    search: { userId?: mongoose.Types.ObjectId; telegramId?: string; createdAt?: Date; useGeolocation?: boolean; platform?: string },
    outcome: 'matched' | 'cancelled' | 'expired',
    reason?: 'user' | 'disconnect' | 'superseded'
  ): Promise<void> {
    try {
      const durationMs = Date.now() - (search.createdAt ? new Date(search.createdAt).getTime() : Date.now());
      await AnalyticsEvent.create({
        userId: search.userId,
        telegramId: search.telegramId,
        platform: search.platform,
        name: 'search_end',
        props: {
          outcome,
          ...(reason ? { reason } : {}),
          durationMs,
          useGeolocation: search.useGeolocation,
          platform: search.platform,
        },
      } as any);
    } catch {}
  }

  /** Свип истёкших поисков: durable-событие 'expired' до удаления по TTL. */
  static async sweepExpiredSearches(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 29 * 60 * 1000); // ~перед 30-мин TTL
      const stale = await Search.find({ status: 'searching', createdAt: { $lte: cutoff } }).limit(200);
      for (const s of stale) {
        // Логируем 'expired' ТОЛЬКО если реально перевели из searching (иначе, если
        // док в этот момент сматчили, был бы двойной/противоречивый outcome).
        const upd = await Search.updateOne({ _id: s._id, status: 'searching' }, { $set: { status: 'expired' } });
        if (upd.modifiedCount === 1) void this.logSearchEnd(s as any, 'expired');
      }
    } catch (error) {
      wsLogger.warn('sweep_expired_searches', (error as Error).message);
    }
  }

  /**
   * Повторная попытка мэтча для УЖЕ существующего активного поиска пользователя.
   * Вызывается на реконнекте: если поиск пережил обрыв и есть ждущий совместимый
   * собеседник — соединяем сразу, а не ждём, пока кто-то запустит новый поиск.
   */
  static async retryMatchForUser(userId: string): Promise<boolean> {
    const search = await Search.findOne({ userId: new mongoose.Types.ObjectId(userId), status: 'searching' });
    if (!search || !search._id) return false;
    try {
      const matches = await this.findMatches(search as ISearch);
      if (matches.length === 0) return false;
      const best = await this.selectBestMatch(search as ISearch, matches);
      if (!best._id) return false;
      await this.createMatch(
        search as ISearch & { _id: mongoose.Types.ObjectId },
        best as ISearch & { _id: mongoose.Types.ObjectId }
      );
      return true;
    } catch (error) {
      wsLogger.warn('retry_match_failed', (error as Error).message, { userId });
      return false;
    }
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

    // Геолокация — ПРЕДПОЧТЕНИЕ «ближайшего», а не фильтр-сегрегация.
    // Раньше: гео матчился только с гео в жёстком радиусе 20 км (в малолюдном
    // регионе поиск висел вечно), не-гео — только с не-гео. Теперь:
    //  - гео-юзер: сначала гео-кандидаты, отсортированные ПО РАССТОЯНИЮ ($near
    //    без $maxDistance сортирует от ближнего к дальнему), затем не-гео;
    //  - не-гео юзер: матчится со всеми (premium/очередь как раньше).
    const hasGeo = search.useGeolocation && search.location && Array.isArray(search.location.coordinates);
    if (search.useGeolocation && !hasGeo) {
      wsLogger.warn('invalid_geo_data_in_find', 'Геолокация включена, но координаты отсутствуют — ищем без гео', {
        searchId: search._id?.toString(),
        location: search.location
      });
    }

    let candidates: ISearch[];
    if (hasGeo) {
      const geoCriteria = {
        ...matchCriteria,
        useGeolocation: true,
        location: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: search.location!.coordinates
            }
            // Без $maxDistance: «просто ближайший», как бы далеко он ни был
          }
        }
      };
      const nonGeoCriteria = { ...matchCriteria, useGeolocation: false };
      const CANDIDATE_LIMIT = 20; // нужен один; запас — под блок-фильтр
      const [geoCandidates, nonGeoCandidates] = await Promise.all([
        // порядок $near = от ближнего к дальнему, НЕ пересортировывать
        Search.find(geoCriteria).limit(CANDIDATE_LIMIT),
        Search.find(nonGeoCriteria).sort({ isPremium: -1, createdAt: 1 }).limit(CANDIDATE_LIMIT),
      ]);
      candidates = [...geoCandidates, ...nonGeoCandidates];
    } else {
      candidates = await Search.find(matchCriteria).sort({ isPremium: -1, createdAt: 1 }).limit(20);
    }

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

  /**
   * Грубое расстояние между двумя поисками (км) — «без точности».
   * Координаты уже огрублены до сетки ~1.1 км; поверх — ступени округления,
   * чтобы по числу нельзя было уточнить позицию: <1 → 1; <10 → целые км;
   * <50 → шаг 5; <200 → шаг 25; дальше → шаг 100.
   */
  private static coarseDistanceKm(a?: ISearch, b?: ISearch): number | null {
    const ca = a?.location?.coordinates;
    const cb = b?.location?.coordinates;
    if (!Array.isArray(ca) || !Array.isArray(cb) || ca.length < 2 || cb.length < 2) return null;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const [lon1, lat1] = ca;
    const [lon2, lat2] = cb;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const km = 2 * 6371 * Math.asin(Math.sqrt(h));
    if (!Number.isFinite(km)) return null;
    if (km < 1) return 1;
    if (km < 10) return Math.ceil(km);
    if (km < 50) return Math.ceil(km / 5) * 5;
    if (km < 200) return Math.ceil(km / 25) * 25;
    return Math.ceil(km / 100) * 100;
  }

  private static async selectBestMatch(search: ISearch, matches: ISearch[]): Promise<ISearch> {
    try {
      if (!matches || matches.length === 0) {
        wsLogger.info('select_best_match', 'Попытка выбрать лучший матч из пустого массива', {
          searchId: search._id?.toString()
        });
        throw new Error('No matches available for selection');
      }

      // Анти-повтор: не соединять с недавним партнёром, если есть другие варианты.
      // (пример: 2 мужчины + 1 женщина — женщина получит того, с кем ещё не общалась)
      const pool = await this.preferFreshPartners(search, matches);

      // Гео-поиск: findMatches уже вернул кандидатов в порядке
      // «ближайшие гео → не-гео по очереди» — берём первого (ближайшего) из свежих.
      if (search.useGeolocation && search.location) {
        return pool[0];
      }

      // Приоритезация: premium первыми, затем по времени ожидания (createdAt ASC), и только затем по скору
      const sorted = pool.slice().sort((a: any, b: any) => {
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

  /**
   * Оставляет только «свежих» кандидатов — тех, с кем пользователь НЕ соединялся
   * за последнее время (окно MATCH_REPEAT_WINDOW_MS). Если свежих нет — возвращает
   * исходный список (лучше повторный матч, чем никакого).
   */
  private static async preferFreshPartners(search: ISearch, matches: ISearch[]): Promise<ISearch[]> {
    try {
      const RECENT_MS = Number(process.env.MATCH_REPEAT_WINDOW_MS || 3 * 60 * 60 * 1000); // 3 часа
      const since = new Date(Date.now() - RECENT_MS);
      const chats = await Chat.find({ participants: search.userId, createdAt: { $gte: since } })
        .select('participants').lean();
      const recent = new Set<string>();
      for (const c of chats) {
        for (const p of (c as any).participants || []) {
          const s = String(p);
          if (s !== String(search.userId)) recent.add(s);
        }
      }
      if (recent.size === 0) return matches;
      const fresh = matches.filter((m) => !recent.has(String(m.userId)));
      if (fresh.length > 0 && fresh.length < matches.length) {
        wsLogger.info('match_avoid_repeat', 'Исключены недавние партнёры из кандидатов', {
          searchId: search._id?.toString(), total: matches.length, fresh: fresh.length,
        });
      }
      return fresh.length > 0 ? fresh : matches;
    } catch {
      return matches;
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
          // Геймификация: матч обоим
          GamificationService.award(String(search1.userId), 'match').catch(() => {});
          GamificationService.award(String(search2.userId), 'match').catch(() => {});
          // Реальный матч состоялся → снимаем AI-таймеры обоих (иначе бот мог бы
          // перехватить уже сматченного и уронить живую пару).
          try { wsManager.clearAiMatch(String(search1.userId)); wsManager.clearAiMatch(String(search2.userId)); } catch {}
          // Аналитика: search_end(matched) для ОБОИХ участников (раньше — только инициатор)
          void this.logSearchEnd(search1, 'matched');
          void this.logSearchEnd(search2, 'matched');
          wsLogger.info('match_created', 'Создан новый матч (tx)', {
            chatId: createdChat._id.toString(),
            search1Id: search1._id.toString(),
            search2Id: search2._id.toString(),
          });

          // Получаем дополнительную информацию о пользователях для уведомлений
          const [user1Data, user2Data] = await Promise.all([
            User.findById(search1.userId).select('rating username firstName lastName profilePhoto photos subscription preferences').lean(),
            User.findById(search2.userId).select('rating username firstName lastName profilePhoto photos subscription preferences').lean()
          ]);

          // Грубое расстояние между собеседниками (если оба делились геопозицией
          // И оба не скрыли расстояние в настройках приватности).
          // Число огрублено ступенями — точную позицию по нему не восстановить.
          // Купидон доступен в чате, только если оба его не заблокировали
          const cupidAvailable =
            (user1Data as any)?.preferences?.acceptCupid !== false &&
            (user2Data as any)?.preferences?.acceptCupid !== false;
          const bothShowDistance =
            (user1Data as any)?.preferences?.showDistance !== false &&
            (user2Data as any)?.preferences?.showDistance !== false;
          const distanceKm = bothShowDistance ? this.coarseDistanceKm(search1, search2) : null;
          if (distanceKm !== null) {
            // Персистим в чат: бейдж расстояния должен переживать реконнект
            Chat.updateOne({ _id: createdChat._id }, { $set: { distanceKm } }).catch((e) => {
              wsLogger.warn('match_distance_persist', (e as Error).message, { chatId: createdChat._id.toString() });
            });
          }

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
              chatId: createdChat._id.toString(),
              acceptsVoice: (user2Data as any)?.preferences?.acceptVoice !== false,
              acceptsGames: (user2Data as any)?.preferences?.acceptGames !== false,
              cupidAvailable,
              ...(distanceKm !== null ? { distanceKm } : {})
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
              chatId: createdChat._id.toString(),
              acceptsVoice: (user1Data as any)?.preferences?.acceptVoice !== false,
              acceptsGames: (user1Data as any)?.preferences?.acceptGames !== false,
              cupidAvailable,
              ...(distanceKm !== null ? { distanceKm } : {})
            }
          });

          await this.broadcastSearchStats();
          await session.endSession();
          return createdChat;
        }

        await session.endSession();
        return null;

      } catch (error: any) {
        lastError = error;
        try { await session.endSession(); } catch {}
        // Идемпотентность против встречной гонки: если ЭТОТ поиск уже переведён
        // в matched параллельной транзакцией — матч фактически состоялся, а
        // победившая сторона уже отправила search:matched обоим. Не бросаем
        // ошибку, иначе юзер получил бы search:error поверх search:matched.
        try {
          const cur = await Search.findById(search1._id);
          if (cur?.status === 'matched') {
            wsLogger.warn('create_match_tx', 'уже matched встречной транзакцией — идемпотентный успех', {
              attempt,
              search1Id: String(search1._id)
            });
            return null;
          }
        } catch {}
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

  /**
   * Полный пересчёт статистики из БД с коротким кэшем.
   * ВАЖНО: наружу всегда уходит КОПИЯ — раньше обработчик подписки мутировал
   * возвращённый объект и «отравлял» общий кэш для всех подписчиков.
   */
  static async getSearchStats(): Promise<SearchStatsSnapshot> {
    if (this.statsCache && Date.now() - this.statsCache.timestamp < this.CACHE_TTL) {
      return this.cloneStats(this.statsCache.data);
    }
    return this.cloneStats(await this.recomputeStats());
  }

  private static cloneStats(stats: SearchStatsSnapshot): SearchStatsSnapshot {
    return {
      ...stats,
      online: { ...stats.online },
      avgSearchTime: { ...stats.avgSearchTime },
    };
  }

  private static recomputeStats(): Promise<SearchStatsSnapshot> {
    if (this.recomputeInFlight) return this.recomputeInFlight;
    this.recomputeInFlight = this.doRecomputeStats().finally(() => {
      this.recomputeInFlight = null;
    });
    return this.recomputeInFlight;
  }

  private static async doRecomputeStats(): Promise<SearchStatsSnapshot> {
    const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000);

    const [
      totalSearching,
      maleSearching,
      femaleSearching,
      totalOnline,
      maleOnline,
      femaleOnline,
      chats24h,
      inChatAgg,
      avgAgg,
    ] = await Promise.all([
      Search.countDocuments({ status: 'searching' }),
      Search.countDocuments({ status: 'searching', gender: 'male' }),
      Search.countDocuments({ status: 'searching', gender: 'female' }),
      User.countDocuments({ isOnline: true }),
      User.countDocuments({ isOnline: true, gender: 'male' }),
      User.countDocuments({ isOnline: true, gender: 'female' }),
      // Матчи за 24ч: один чат = один матч. Раньше считали Search-доки со
      // status:'matched' — их ДВА на матч, метрика была завышена вдвое.
      Chat.countDocuments({ createdAt: { $gte: oneDayAgo } }),
      // «В чате» = люди, которые сейчас ОНЛАЙН в активных чатах.
      // Раньше считали «активные чаты × 2» — зомби-чаты (оба офлайн, ждут
      // grace/sweep) завышали цифру. Активных чатов немного — $lookup дёшев.
      Chat.aggregate<{ total: number }>([
        { $match: { isActive: true } },
        { $lookup: { from: 'users', localField: 'participants', foreignField: '_id', as: 'p' } },
        { $project: { n: { $size: { $filter: { input: '$p', as: 'u', cond: '$$u.isOnline' } } } } },
        { $group: { _id: null, total: { $sum: '$n' } } },
      ]),
      // Реальное среднее время до матча (сек) по полу. TTL-индекс хранит
      // Search-доки ~30 минут — получается «живое» среднее по недавним матчам.
      Search.aggregate<{ _id: string; avgMs: number }>([
        { $match: { status: 'matched' } },
        { $project: { gender: 1, waitMs: { $subtract: ['$updatedAt', '$createdAt'] } } },
        { $group: { _id: '$gender', avgMs: { $avg: '$waitMs' }, n: { $sum: 1 } } },
      ]),
    ]);

    const toSec = (ms: number | undefined | null) =>
      Number.isFinite(ms as number) && (ms as number) > 0 ? Math.round((ms as number) / 1000) : 0;
    const avgByGender = new Map(avgAgg.map((r) => [r._id, r.avgMs]));
    // Общее среднее — взвешенное по числу матчей, а не среднее средних
    const totalN = avgAgg.reduce((s, r) => s + (r as unknown as { n: number }).n, 0);
    const avgAllMs = totalN > 0
      ? avgAgg.reduce((s, r) => s + r.avgMs * (r as unknown as { n: number }).n, 0) / totalN
      : 0;

    // Фиктивный «живой» слой поверх реальных чисел (чтобы не было пусто/нулей)
    const fb = this.fakeBoost();
    const stats: SearchStatsSnapshot = {
      t: totalSearching + fb.searching,
      m: maleSearching + fb.searchingM,
      f: femaleSearching + fb.searchingF,
      inChat: (inChatAgg[0]?.total || 0) + fb.inChat,
      online: {
        t: totalOnline + fb.online,
        m: maleOnline + fb.onlineM,
        f: femaleOnline + fb.onlineF,
      },
      avgSearchTime: {
        t: toSec(avgAllMs) || fb.avgSec,
        m: toSec(avgByGender.get('male')) || fb.avgSec,
        f: toSec(avgByGender.get('female')) || fb.avgSec,
        matches24h: chats24h + fb.matches24h,
      },
    };

    this.statsCache = { data: stats, timestamp: Date.now() };
    return stats;
  }

  /**
   * Фиктивный «живой» слой поверх реальной статистики (иначе видно, что пусто).
   * Стабилен в пределах ~3-минутного окна (не прыгает на каждом бродкасте),
   * плавно меняется по времени суток (МСК), с перекосом на женщин под мужскую
   * аудиторию. Отключается FAKE_STATS_ENABLED=false. Настройка масштаба —
   * FAKE_STATS_SCALE (множитель, дефолт 1).
   */
  private static fakeWalk: { online: number; searching: number; inChat: number; avgSec: number; at: number } | null = null;
  private static fakeBoost() {
    const zero = { online: 0, onlineM: 0, onlineF: 0, searching: 0, searchingM: 0, searchingF: 0, inChat: 0, matches24h: 0, avgSec: 0 };
    if (String(process.env.FAKE_STATS_ENABLED ?? 'true') === 'false') return zero;
    const scale = Number(process.env.FAKE_STATS_SCALE || 1) || 1;
    const now = Date.now();
    const mskHour = (((new Date(now).getUTCHours() + 3) % 24) + 24) % 24;
    // Кривая онлайна по часам МСК: ночью мало, вечером пик.
    const curve = [46, 34, 26, 22, 20, 24, 34, 60, 88, 118, 138, 150, 158, 168, 158, 156, 170, 196, 236, 270, 250, 208, 150, 88];
    const dow = new Date(now).getUTCDay();
    const weekend = (dow === 0 || dow === 6) ? 1.12 : 1;
    const base = (curve[mskHour] || 120) * scale * weekend;
    // ЖИВОЕ случайное блуждание вокруг цели дня: обновляем не чаще ~11с (люди приходят/уходят).
    const STEP_MS = 11000;
    const st = this.fakeWalk;
    if (!st || now - st.at > STEP_MS) {
      const prev = st ? st.online : base;
      const pull = (base - prev) * 0.2;                             // притяжение к «норме» часа
      const noise = (Math.random() - 0.5) * Math.max(6, base * 0.07); // приход/уход людей
      const online = Math.max(12, Math.round(prev + pull + noise));
      const searching = Math.max(3, Math.round(online * (0.10 + Math.random() * 0.06)));
      const inChat = Math.round(online * (0.28 + Math.random() * 0.14));
      const avgSec = 45 + Math.round(Math.random() * 45);
      this.fakeWalk = { online, searching, inChat, avgSec, at: now };
    }
    const w = this.fakeWalk!;
    const onlineF = Math.round(w.online * 0.60); // перекос на женщин
    const onlineM = w.online - onlineF;
    const searchingF = Math.round(w.searching * 0.6);
    const searchingM = w.searching - searchingF;
    const matches24h = Math.round(base * 2.5 + (Math.floor(now / 60000) % 60));
    return { online: w.online, onlineM, onlineF, searching: w.searching, searchingM, searchingF, inChat: w.inChat, matches24h, avgSec: w.avgSec };
  }

  /**
   * Пер-юзерный сдвиг статистики: у каждого свой стабильный множитель 0.90..1.10,
   * чтобы цифры были «не для всех одинаковыми» (иначе видно, что фейк). Время в
   * avgSearchTime не трогаем (это не счётчик). Без фейка — без персонализации.
   */
  static personalizeStats(stats: SearchStatsSnapshot, userId: string): SearchStatsSnapshot {
    if (String(process.env.FAKE_STATS_ENABLED ?? 'true') === 'false') return stats;
    let h = 2166136261;
    const s = String(userId);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const mul = 0.9 + ((h % 1000) / 1000) * 0.2;
    const j = (n: number) => Math.max(0, Math.round(n * mul));
    return {
      t: j(stats.t), m: j(stats.m), f: j(stats.f),
      inChat: j(stats.inChat),
      online: { t: j(stats.online.t), m: j(stats.online.m), f: j(stats.online.f) },
      avgSearchTime: { ...stats.avgSearchTime, matches24h: j(stats.avgSearchTime.matches24h) },
    };
  }

  static async getUserActiveSearch(userId: string) {
    return await Search.findOne({
      userId,
      status: 'searching'
    });
  }

  /**
   * Сигнал «данные статистики изменились» (поиск/матч/коннект/конец чата):
   * инвалидирует кэш и рассылает свежий пересчёт с дебаунсом — пачка событий
   * (например, матч = два ушли из поиска + чат создан) даёт одну рассылку.
   * Никакой инкрементальной арифметики: только пересчёт из БД.
   */
  public static async broadcastSearchStats(): Promise<void> {
    this.statsCache = null;
    if (this.broadcastTimer) return; // рассылка уже запланирована — событие войдёт в неё
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      // getSearchStats: если кэш уже освежили в окне дебаунса — без лишнего пересчёта
      this.getSearchStats()
        .then((stats) => {
          void wsManager.emitPersonalizedStats(stats);
        })
        .catch((error) => {
          logger.error('Failed to broadcast search stats', {
            error: error instanceof Error ? { message: error.message, stack: error.stack } : error
          });
        });
    }, this.BROADCAST_DEBOUNCE_MS);
    // Таймер не должен держать процесс при остановке
    this.broadcastTimer.unref?.();
  }


}