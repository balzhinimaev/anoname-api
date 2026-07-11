import mongoose, { Document, Schema } from 'mongoose';

/**
 * Глобальные рантайм-тумблеры продукта (единственный документ key='global').
 * Управляются из админки (GET/PUT /api/admin/settings) без рестарта API.
 * Начальные значения при первом создании берутся из .env (см. SettingsService),
 * дальше .env на эти флаги НЕ влияет — источник истины только БД.
 */
export interface IGlobalSettingsFlags {
  /** Часовой лимит бесплатных поисков (2/час). false = безлимит всем. */
  searchLimitsEnabled: boolean;
  /** ИИ-собеседники: подключение персоны, когда живой матч не нашёлся. */
  aiCompanionsEnabled: boolean;
  /** Авто-разрыв ИИ-чата у не-премиум через 40–70с («собеседник покинул чат»). */
  aiChatTtlEnabled: boolean;
  /** Фиктивный слой статистики онлайна поверх реальных чисел. */
  fakeStatsEnabled: boolean;
  /**
   * «Закрытый клуб» в TG мини-аппе: отложенный запуск — вместо приложения
   * показывается экран листа ожидания. Админы (ADMIN_TELEGRAM_IDS) проходят
   * мимо гейта (cohort='admin' в ответах auth/profile). Веб/VK не затрагивает.
   */
  tmaPrelaunchEnabled: boolean;
}

export const GLOBAL_SETTINGS_FLAG_KEYS: (keyof IGlobalSettingsFlags)[] = [
  'searchLimitsEnabled',
  'aiCompanionsEnabled',
  'aiChatTtlEnabled',
  'fakeStatsEnabled',
  'tmaPrelaunchEnabled',
];

export interface IGlobalSettings extends Document, IGlobalSettingsFlags {
  key: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GlobalSettingsSchema = new Schema<IGlobalSettings>(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    searchLimitsEnabled: { type: Boolean, required: true, default: true },
    aiCompanionsEnabled: { type: Boolean, required: true, default: true },
    aiChatTtlEnabled: { type: Boolean, required: true, default: true },
    fakeStatsEnabled: { type: Boolean, required: true, default: true },
    tmaPrelaunchEnabled: { type: Boolean, required: true, default: false },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<IGlobalSettings>('GlobalSettings', GlobalSettingsSchema);
