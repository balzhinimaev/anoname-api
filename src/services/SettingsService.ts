import GlobalSettings, { GLOBAL_SETTINGS_FLAG_KEYS, IGlobalSettingsFlags } from '../models/GlobalSettings';
import logger from '../utils/logger';

const envBool = (v: string | undefined, def: boolean): boolean =>
  v === undefined ? def : String(v).toLowerCase() !== 'false';

/**
 * Начальные значения тумблеров при ПЕРВОМ создании документа настроек —
 * из .env, чтобы включение фичи ничего не поменяло в поведении прода.
 * После первого запуска источник истины — только БД (админка).
 */
const ENV_DEFAULTS: IGlobalSettingsFlags = {
  searchLimitsEnabled: true,
  aiCompanionsEnabled: envBool(process.env.AI_COMPANION_ENABLED, true),
  aiChatTtlEnabled: true,
  fakeStatsEnabled: envBool(process.env.FAKE_STATS_ENABLED, true),
  // Закрытый клуб TG мини-аппа: по умолчанию выключен (обычный запуск)
  tmaPrelaunchEnabled: String(process.env.TMA_PRELAUNCH_ENABLED || 'false').toLowerCase() === 'true',
};

const REFRESH_MS = 15_000;

/**
 * Глобальные рантайм-тумблеры с синхронным доступом: `SettingsService.flags.*`
 * читается из кэша в горячих местах (поиск, статистика, ИИ) без await.
 * Кэш обновляется раз в REFRESH_MS и сразу после update() из админки.
 */
class SettingsServiceImpl {
  private cache: IGlobalSettingsFlags = { ...ENV_DEFAULTS };
  private meta: { updatedAt?: Date; updatedBy?: string } = {};
  private timer: NodeJS.Timeout | null = null;

  get flags(): Readonly<IGlobalSettingsFlags> {
    return this.cache;
  }

  get updatedInfo(): { updatedAt?: Date; updatedBy?: string } {
    return this.meta;
  }

  /** Вызывается на старте сервера после подключения Mongo. */
  async init(): Promise<void> {
    await GlobalSettings.findOneAndUpdate(
      { key: 'global' },
      { $setOnInsert: { key: 'global', ...ENV_DEFAULTS } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => { this.refresh().catch(() => {}); }, REFRESH_MS);
      this.timer.unref?.();
    }
    logger.info('Global settings loaded', { flags: this.cache });
  }

  async refresh(): Promise<void> {
    const doc = await GlobalSettings.findOne({ key: 'global' }).lean();
    if (!doc) return;
    for (const k of GLOBAL_SETTINGS_FLAG_KEYS) {
      if (typeof doc[k] === 'boolean') this.cache[k] = doc[k];
    }
    this.meta = { updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
  }

  /**
   * Применяет частичное обновление флагов из админки. Побочные эффекты:
   * выключение ИИ-собеседников мягко завершает активные ИИ-чаты; изменение
   * фиктивной статистики сразу рассылает клиентам пересчитанные цифры.
   */
  async update(patch: Partial<IGlobalSettingsFlags>, updatedBy: string): Promise<IGlobalSettingsFlags> {
    const prev = { ...this.cache };
    const $set: Record<string, boolean | string> = { updatedBy };
    for (const k of GLOBAL_SETTINGS_FLAG_KEYS) {
      if (typeof patch[k] === 'boolean') $set[k] = patch[k] as boolean;
    }
    await GlobalSettings.findOneAndUpdate(
      { key: 'global' },
      { $set, $setOnInsert: { key: 'global' } },
      { upsert: true }
    );
    await this.refresh();
    logger.info('Global settings updated', { updatedBy, patch, flags: this.cache });

    // Побочные эффекты — динамические импорты, чтобы не плодить циклы зависимостей.
    if (prev.aiCompanionsEnabled && !this.cache.aiCompanionsEnabled) {
      import('./AICompanionService')
        .then(({ AICompanionService }) => AICompanionService.endActiveAiChats())
        .catch(() => {});
    }
    if (prev.fakeStatsEnabled !== this.cache.fakeStatsEnabled) {
      import('./SearchService')
        .then(({ SearchService }) => SearchService.broadcastSearchStats())
        .catch(() => {});
    }
    return { ...this.cache };
  }
}

export const SettingsService = new SettingsServiceImpl();
export default SettingsService;
