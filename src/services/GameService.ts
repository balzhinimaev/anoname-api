/**
 * Мини-игры в чате — generic игровой слой.
 *
 * Транспорт (WS): game:invite / game:respond / game:event / game:leave (client→server),
 * game:invite / game:start / game:event / game:end (server→client).
 *
 * Каждая игра реализует GameDefinition. Сейчас одна игра — «Угадай рисунок» (draw-guess);
 * чтобы добавить новую, достаточно зарегистрировать ещё один GameDefinition в GAMES.
 */

export type OutEvent =
  | { toUserId: string; event: 'game:invite'; data: { gameId: string; by: string; title: string } }
  | { toUserId: string; event: 'game:start'; data: { gameId: string; role: GameRole; word?: string; mask?: string; question?: { text: string; options: string[] }; myAnswer?: number; partnerAnswered?: boolean; myScore: number; opponentScore: number; round: number; roundSeconds: number; targetScore: number } }
  | { toUserId: string; event: 'game:choose'; data: { role: GameRole; words?: string[]; chooseSeconds: number; round: number; myScore: number; opponentScore: number; targetScore: number } }
  | { toUserId: string; event: 'game:event'; data: { type: string; payload?: any } }
  | { toUserId: string; event: 'game:end'; data: { reason?: string; youWon?: boolean; myScore?: number; opponentScore?: number } };

/** Длительность раунда: не успел угадать — слово раскрывается, роли меняются. */
export const ROUND_SECONDS = 90;
/** Игра идёт до этого количества очков. */
export const TARGET_SCORE = 5;
/** Сколько секунд даётся рисующему на выбор слова (по истечении — авто-выбор). */
export const CHOOSE_SECONDS = 15;
/** Сколько слов предлагается рисующему на выбор. */
export const CHOICE_COUNT = 3;

export type GameRole = 'drawer' | 'guesser';

export interface GameState {
  gameId: string;
  players: [string, string]; // userIds
  scores: Record<string, number>;
  round: number;
  // специфично для draw-guess
  drawerId: string;
  word: string;
  choosing: boolean;      // рисующий сейчас выбирает слово из candidates
  candidates: string[];   // предложенные на выбор слова (только пока choosing)
  hintMask?: string;      // маска с подсказкой-буквой (после середины раунда)
  // специфично для match-quiz
  quiz?: {
    question: { text: string; options: string[] } | null;
    answers: Record<string, number>;
    matches: number;
    total: number;
    usedIdx: number[];
  };
}

interface GameDefinition {
  id: string;
  title: string;
  /** false → раунд начинается сразу с game:start (без фазы выбора слова). */
  hasChoosePhase?: boolean;
  /** Пер-игровая длительность раунда (сек); по умолчанию ROUND_SECONDS. */
  roundSecondsOverride?: number;
  /** Подготовка данных нового раунда для игр без фазы выбора (например, следующий вопрос). */
  prepareRound?(state: GameState): void;
  /** Событие середины раунда (например, подсказка-буква). null → ничего не слать.
   *  to: 'guessers' → всем, кроме текущего drawerId (по умолчанию 'both'). */
  onHalfTime?(state: GameState): Array<{ to?: 'both' | 'guessers'; type: string; payload?: any }> | null;
  /** Начальное состояние новой игры (starter ходит первым «рисующим»). */
  init(players: [string, string], starterId: string): GameState;
  /** Роль игрока + приватные данные для game:start (рисующему — слово, угадывающему — маску, в квизе — вопрос). */
  startInfo(state: GameState, userId: string): { role: GameRole; word?: string; mask?: string; question?: { text: string; options: string[] } };
  /** N уникальных слов на выбор рисующему (начало раунда). */
  pickCandidates(count: number, exclude?: string): string[];
  /** Обработка in-game события. restart=true → новый раунд (фаза выбора слова).
   *  startNow=true → слово выбрано, пора начинать рисование (game:start + таймер раунда).
   *  finished=true → игра окончена без победителя (кооперативный финал). */
  onEvent(
    state: GameState,
    fromUserId: string,
    type: string,
    payload: any
  ): { events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }>; restart?: boolean; startNow?: boolean; winnerId?: string; finished?: boolean };
  /** Истёк таймер раунда. Вернуть события и (обычно) restart для нового раунда. */
  onTimeout(state: GameState): { events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }>; restart?: boolean; finished?: boolean };
}

// ── Банк слов для «Угадай рисунок» (простые, рисуемые) ──────────────────────────
const WORD_BANK = [
  // животные
  'кот', 'собака', 'рыба', 'слон', 'жираф', 'лев', 'медведь', 'заяц', 'лиса', 'птица',
  'улитка', 'черепаха', 'краб', 'бабочка', 'пчела', 'паук', 'змея', 'лягушка', 'ёжик', 'белка',
  'сова', 'пингвин', 'кит', 'акула', 'осьминог', 'дельфин', 'петух', 'корова', 'свинья', 'овца',
  'лошадь', 'мышь', 'волк', 'тигр', 'обезьяна', 'кенгуру', 'верблюд', 'улей', 'муравей', 'динозавр',
  // природа
  'дерево', 'солнце', 'цветок', 'звезда', 'гора', 'река', 'облако', 'радуга', 'молния', 'снежинка',
  'лист', 'гриб', 'кактус', 'вулкан', 'остров', 'водопад', 'костёр', 'луна', 'планета', 'море',
  // еда
  'яблоко', 'банан', 'торт', 'мороженое', 'пицца', 'арбуз', 'клубника', 'вишня', 'лимон', 'апельсин',
  'морковь', 'перец', 'яйцо', 'сыр', 'хлеб', 'конфета', 'пончик', 'бургер', 'сосиска', 'чашка',
  // предметы
  'дом', 'машина', 'зонт', 'очки', 'часы', 'ключ', 'лодка', 'самолёт', 'ракета', 'гитара',
  'барабан', 'мяч', 'воздушный шар', 'снеговик', 'ёлка', 'телефон', 'компьютер', 'книга', 'карандаш', 'ножницы',
  'молоток', 'лампочка', 'свеча', 'замок', 'мост', 'корона', 'робот', 'призрак', 'клоун', 'футболка',
  'ботинок', 'шляпа', 'перчатка', 'флаг', 'якорь', 'ведро', 'лестница', 'зеркало', 'кровать', 'стул',
  'диван', 'дверь', 'окно', 'чемодан', 'фотоаппарат', 'наушники', 'кисть', 'иголка', 'подушка', 'фонарик',
  'поезд', 'велосипед', 'вертолёт', 'трактор', 'светофор', 'парашют', 'сани', 'скейт', 'коляска', 'колесо',
  // фигуры/символы/прочее
  'сердце', 'домик', 'снежинка', 'подарок', 'воздушный змей', 'мельница', 'маяк', 'палатка', 'замок песочный', 'меч',
];

/** Нормализация для сравнения догадки со словом. */
function normalize(s: string): string {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, '').trim();
}

function pickWord(exclude?: string): string {
  let w = WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];
  if (exclude && WORD_BANK.length > 1) {
    let guard = 0;
    while (normalize(w) === normalize(exclude) && guard++ < 10) {
      w = WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];
    }
  }
  return w;
}

/** Маска слова для угадывающего: длина по буквам, пробелы сохраняются. «дом» → «• • •». */
function maskOf(word: string): string {
  return String(word || '')
    .split('')
    .map((ch) => (ch === ' ' ? '  ' : '•'))
    .join(' ')
    .trim();
}

/** Расстояние Левенштейна — для распознавания «почти угадал» (опечатка/окончание). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// ── Игра «Угадай рисунок» ───────────────────────────────────────────────────────
const drawGuess: GameDefinition = {
  id: 'draw-guess',
  title: 'Угадай рисунок',

  init(players, starterId) {
    return {
      gameId: 'draw-guess',
      players,
      scores: { [players[0]]: 0, [players[1]]: 0 },
      round: 1,
      drawerId: starterId,
      word: '',
      choosing: false,
      candidates: [],
    };
  },

  startInfo(state, userId) {
    const role: GameRole = userId === state.drawerId ? 'drawer' : 'guesser';
    return role === 'drawer'
      ? { role, word: state.word }
      : { role, mask: state.hintMask || maskOf(state.word) };
  },

  /** Середина раунда: раскрываем угадывающему одну случайную букву. */
  onHalfTime(state) {
    if (!state.word || state.choosing) return null;
    const letters = state.word.split('');
    const idxs = letters.map((ch, i) => (ch === ' ' ? -1 : i)).filter((i) => i >= 0);
    if (idxs.length < 3) return null; // короткие слова не подсказываем
    const revealIdx = idxs[Math.floor(Math.random() * idxs.length)];
    const mask = letters
      .map((ch, i) => (ch === ' ' ? ' ' : i === revealIdx ? ch.toUpperCase() : '•'))
      .join(' ')
      .trim();
    state.hintMask = mask;
    return [{ to: 'guessers', type: 'hint', payload: { mask } }];
  },

  pickCandidates(count, exclude) {
    const out: string[] = [];
    let guard = 0;
    while (out.length < count && guard++ < 200) {
      const w = pickWord(exclude);
      if (!out.some((x) => normalize(x) === normalize(w))) out.push(w);
    }
    return out;
  },

  onEvent(state, fromUserId, type, payload) {
    const isDrawer = fromUserId === state.drawerId;

    // Фаза выбора слова: принимаем только 'pick' от рисующего.
    if (state.choosing) {
      if (type !== 'pick' || !isDrawer) return { events: [] };
      const idx = Number(payload?.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= state.candidates.length) return { events: [] };
      state.word = state.candidates[idx];
      state.choosing = false;
      state.candidates = [];
      return { events: [], startNow: true };
    }

    switch (type) {
      case 'draw': // штрихи: рисующий → угадывающему
        if (!isDrawer) return { events: [] };
        return { events: [{ to: 'other', type: 'draw', payload }] };

      case 'clear': // очистка холста рисующим
        if (!isDrawer) return { events: [] };
        return { events: [{ to: 'other', type: 'clear' }] };

      case 'skip': // рисующий пропускает слово → новый выбор, роли те же
        if (!isDrawer) return { events: [] };
        return { events: [{ to: 'both', type: 'skipped' }], restart: true };

      case 'guess': { // угадывающий присылает догадку
        if (isDrawer) return { events: [] };
        const guess = normalize(String(payload?.text || ''));
        if (!guess) return { events: [] };
        if (guess === normalize(state.word)) {
          // верно: очко угадавшему
          state.scores[fromUserId] = (state.scores[fromUserId] || 0) + 1;
          const guessedWord = state.word;
          const correctEvent = { to: 'both' as const, type: 'correct', payload: { by: fromUserId, word: guessedWord, scores: state.scores } };
          if ((state.scores[fromUserId] || 0) >= TARGET_SCORE) {
            // набрал целевой счёт — игра окончена
            return { events: [correctEvent], winnerId: fromUserId };
          }
          // меняем рисующего, новый раунд (слово выберет beginRound)
          state.round += 1;
          state.drawerId = fromUserId; // угадавший становится рисующим (роли меняются)
          return { events: [correctEvent], restart: true };
        }
        // неверно: показываем догадку рисующему; угадывающему — «почти», если близко
        const target = normalize(state.word);
        const dist = levenshtein(guess, target);
        const isClose = dist > 0 && (dist === 1 || (dist === 2 && target.length >= 6));
        const events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }> = [
          { to: 'other', type: 'guess', payload: { text: String(payload?.text || '').slice(0, 60) } },
        ];
        if (isClose) events.push({ to: 'self', type: 'close' });
        return { events };
      }

      default:
        return { events: [] };
    }
  },

  onTimeout(state) {
    // время вышло: раскрываем слово, очков никому, роли меняются, новый раунд
    const expiredWord = state.word;
    state.round += 1;
    state.drawerId = state.players.find((p) => p !== state.drawerId)!;
    return {
      events: [{ to: 'both', type: 'timeout', payload: { word: expiredWord } }],
      restart: true,
    };
  },
};

// ── Игра «Совпадения» — quiz-дихотомии для знакомства ──────────────────────────
// Оба втайне отвечают на один вопрос; совпадение = 💘. Кооперативный счёт.
const QUIZ_QUESTIONS: Array<{ text: string; options: string[] }> = [
  { text: 'Идеальный вечер?', options: ['Дома под плед', 'Куда-нибудь выбраться'] },
  { text: 'Море или горы?', options: ['Море', 'Горы'] },
  { text: 'Кофе или чай?', options: ['Кофе', 'Чай'] },
  { text: 'Сова или жаворонок?', options: ['Сова', 'Жаворонок'] },
  { text: 'Кошки или собаки?', options: ['Кошки', 'Собаки'] },
  { text: 'Зима или лето?', options: ['Зима', 'Лето'] },
  { text: 'Готовить дома или заказать доставку?', options: ['Готовить', 'Доставка'] },
  { text: 'Спонтанная поездка или всё по плану?', options: ['Спонтанно', 'По плану'] },
  { text: 'Кино дома или в кинотеатре?', options: ['Дома', 'В кинотеатре'] },
  { text: 'Сладкое или солёное?', options: ['Сладкое', 'Солёное'] },
  { text: 'Опоздать или прийти сильно заранее?', options: ['Опоздать', 'Заранее'] },
  { text: 'Текст или голосовое?', options: ['Текст', 'Голосовое'] },
  { text: 'Большая компания или пара близких друзей?', options: ['Компания', 'Пара близких'] },
  { text: 'Город или природа?', options: ['Город', 'Природа'] },
  { text: 'Душ утром или вечером?', options: ['Утром', 'Вечером'] },
  { text: 'Пицца или суши?', options: ['Пицца', 'Суши'] },
  { text: 'Сериал залпом или по серии?', options: ['Залпом', 'По серии'] },
  { text: 'Танцевать или смотреть, как танцуют?', options: ['Танцевать', 'Смотреть'] },
  { text: 'Первым написать или ждать сообщения?', options: ['Написать', 'Ждать'] },
  { text: 'Вечеринка или настолки?', options: ['Вечеринка', 'Настолки'] },
  { text: 'Поход в горы или отель всё включено?', options: ['Поход', 'Всё включено'] },
  { text: 'Книга или подкаст?', options: ['Книга', 'Подкаст'] },
  { text: 'Завтрак — сладкий или сытный?', options: ['Сладкий', 'Сытный'] },
  { text: 'Гулять под дождём или смотреть на него из окна?', options: ['Гулять', 'Из окна'] },
  { text: 'Отпуск: один большой или несколько маленьких?', options: ['Один большой', 'Несколько'] },
  { text: 'Звонок или переписка?', options: ['Звонок', 'Переписка'] },
  { text: 'Утро без будильника или ранний подъём?', options: ['Без будильника', 'Ранний подъём'] },
  { text: 'Немного опасно, но весело — или спокойно и надёжно?', options: ['Весело', 'Надёжно'] },
  { text: 'Комедия или триллер?', options: ['Комедия', 'Триллер'] },
  { text: 'Подарок-сюрприз или спросить, что подарить?', options: ['Сюрприз', 'Спросить'] },
  { text: 'Наличные или карта?', options: ['Наличные', 'Карта'] },
  { text: 'Молчать вместе — уютно или неловко?', options: ['Уютно', 'Неловко'] },
  { text: 'Переезд в другую страну — да или страшно?', options: ['Да!', 'Страшно'] },
  { text: 'Экспромт-караоке: поёте или ни за что?', options: ['Пою!', 'Ни за что'] },
  { text: 'Идеальное свидание — днём или ночью?', options: ['Днём', 'Ночью'] },
  { text: 'Спорт вместе или каждый сам?', options: ['Вместе', 'Каждый сам'] },
];
const QUIZ_ROUNDS = 10;
const QUIZ_ROUND_SECONDS = 30;

const matchQuiz: GameDefinition = {
  id: 'match-quiz',
  title: 'Совпадения',
  hasChoosePhase: false,
  roundSecondsOverride: QUIZ_ROUND_SECONDS,

  init(players, starterId) {
    return {
      gameId: 'match-quiz',
      players,
      scores: { [players[0]]: 0, [players[1]]: 0 },
      round: 1,
      drawerId: starterId, // не используется квизом (поле каркаса)
      word: '',
      choosing: false,
      candidates: [],
      quiz: { question: null, answers: {}, matches: 0, total: QUIZ_ROUNDS, usedIdx: [] },
    };
  },

  prepareRound(state) {
    const q = state.quiz!;
    q.answers = {};
    const available = QUIZ_QUESTIONS.map((_, i) => i).filter((i) => !q.usedIdx.includes(i));
    const pick = available.length
      ? available[Math.floor(Math.random() * available.length)]
      : Math.floor(Math.random() * QUIZ_QUESTIONS.length);
    q.usedIdx.push(pick);
    q.question = QUIZ_QUESTIONS[pick];
  },

  startInfo(state) {
    // Ролей нет — оба отвечают; вопрос одинаковый для обоих
    return { role: 'guesser', question: state.quiz?.question || undefined };
  },

  pickCandidates() {
    return [];
  },

  onEvent(state, fromUserId, type, payload) {
    if (type !== 'answer') return { events: [] };
    const q = state.quiz;
    if (!q || !q.question) return { events: [] };
    const idx = Number(payload?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.question.options.length) return { events: [] };
    if (q.answers[fromUserId] !== undefined) return { events: [] }; // уже отвечал

    q.answers[fromUserId] = idx;
    const other = state.players.find((p) => p !== fromUserId)!;
    if (q.answers[other] === undefined) {
      // Ждём второго: партнёру — «собеседник ответил», себе — подтверждение
      return { events: [{ to: 'other', type: 'partner_answered' }] };
    }

    // Оба ответили → раскрытие
    const mine = q.answers[fromUserId];
    const theirs = q.answers[other];
    const matched = mine === theirs;
    if (matched) {
      q.matches += 1;
      state.players.forEach((p) => { state.scores[p] = q.matches; });
    }
    const base = {
      question: q.question.text,
      options: q.question.options,
      matched,
      matches: q.matches,
      round: state.round,
      total: q.total,
    };
    const events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }> = [
      { to: 'self', type: 'reveal', payload: { ...base, mine, partner: theirs } },
      { to: 'other', type: 'reveal', payload: { ...base, mine: theirs, partner: mine } },
    ];
    if (state.round >= q.total) {
      events.push({ to: 'both', type: 'quiz_final', payload: { matches: q.matches, total: q.total } });
      return { events, finished: true };
    }
    state.round += 1;
    return { events, restart: true };
  },

  onTimeout(state) {
    // Вопрос просрочен: без совпадения, дальше (или финал, если это был последний)
    const q = state.quiz!;
    const events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }> = [
      { to: 'both', type: 'quiz_timeout', payload: { round: state.round } },
    ];
    if (state.round >= q.total) {
      events.push({ to: 'both', type: 'quiz_final', payload: { matches: q.matches, total: q.total } });
      return { events, finished: true };
    }
    state.round += 1;
    return { events, restart: true };
  },
};

const GAMES: Record<string, GameDefinition> = {
  [drawGuess.id]: drawGuess,
  [matchQuiz.id]: matchQuiz,
};

interface Session {
  def: GameDefinition;
  state?: GameState; // есть после accept
  players: [string, string];
  inviterId: string;
  status: 'pending' | 'active';
  chatId: string;
  timer?: NodeJS.Timeout; // таймер текущего раунда
  hintTimer?: NodeJS.Timeout; // таймер события середины раунда (подсказка)
  roundEndsAt?: number; // ms epoch окончания текущего раунда (для ресинка при reconnect)
}

export class GameManager {
  private sessions = new Map<string, Session>(); // chatId -> session
  /** Рассылка событий вне запроса (истечение таймера раунда). Регистрирует WebSocketManager. */
  private dispatcher: ((events: OutEvent[]) => void) | null = null;
  /** Уведомление о завершённой партии (геймификация). Регистрирует WebSocketManager. */
  private finishListener:
    | ((info: { players: [string, string]; winnerId?: string; gameId: string; quizMatches?: number }) => void)
    | null = null;

  setFinishListener(
    fn: (info: { players: [string, string]; winnerId?: string; gameId: string; quizMatches?: number }) => void
  ): void {
    this.finishListener = fn;
  }

  constructor(private roundMs: number = ROUND_SECONDS * 1000) {}

  setDispatcher(fn: (events: OutEvent[]) => void): void {
    this.dispatcher = fn;
  }

  /** Доступные игры (для меню). */
  static catalog(): Array<{ id: string; title: string }> {
    return Object.values(GAMES).map((g) => ({ id: g.id, title: g.title }));
  }

  /** Приглашение в игру. Возвращает события (game:invite сопернику). */
  invite(chatId: string, fromUserId: string, gameId: string, players: [string, string]): OutEvent[] {
    const def = GAMES[gameId];
    if (!def) return [];
    const other = players.find((p) => p !== fromUserId);
    if (!other) return [];
    // Не перетираем уже идущую игру повторным приглашением.
    if (this.sessions.get(chatId)?.status === 'active') return [];
    this.sessions.set(chatId, { def, players, inviterId: fromUserId, status: 'pending', chatId });
    return [{ toUserId: other, event: 'game:invite', data: { gameId: def.id, by: fromUserId, title: def.title } }];
  }

  /** Ответ на приглашение. accept=false → завершение. accept=true → старт (game:start обоим). */
  respond(chatId: string, userId: string, accept: boolean): OutEvent[] {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'pending') return [];
    if (userId === s.inviterId) {
      // Инициатор не может принять сам себя, но МОЖЕТ отменить сессию.
      // Важно при взаимных приглашениях: встречный invite перетирает pending,
      // и «Нет» перетёртого инициатора раньше глоталось — экран приглашения висел.
      if (accept) return [];
      this.clearSession(chatId);
      return s.players.map((p) => ({ toUserId: p, event: 'game:end' as const, data: { reason: 'declined' } }));
    }
    if (!accept) {
      this.clearSession(chatId);
      return s.players.map((p) => ({ toUserId: p, event: 'game:end' as const, data: { reason: 'declined' } }));
    }
    s.state = s.def.init(s.players, s.inviterId);
    s.status = 'active';
    return this.beginRound(s); // раунд начинается с выбора слова рисующим
  }

  /** In-game событие (draw/guess/clear/skip/pick). */
  event(chatId: string, fromUserId: string, type: string, payload: any): OutEvent[] {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'active' || !s.state) return [];
    if (!s.players.includes(fromUserId)) return [];
    const { events, restart, startNow, winnerId, finished } = s.def.onEvent(s.state, fromUserId, type, payload);
    const out: OutEvent[] = [];
    for (const e of events) {
      const targets = e.to === 'both' ? s.players : e.to === 'self' ? [fromUserId] : [s.players.find((p) => p !== fromUserId)!];
      for (const t of targets) {
        out.push({ toUserId: t, event: 'game:event', data: { type: e.type, payload: e.payload } });
      }
    }
    if (winnerId || finished) {
      out.push(...this.finishEvents(s, winnerId));
      this.clearSession(chatId);
      return out;
    }
    if (startNow) out.push(...this.startEvents(s)); // слово выбрано → рисуем
    else if (restart) out.push(...this.beginRound(s)); // новый раунд → снова выбор слова
    return out;
  }

  /** Начало раунда: фаза выбора слова, либо сразу game:start (игры без выбора). */
  private beginRound(s: Session): OutEvent[] {
    const st = s.state!;
    st.hintMask = undefined;
    if (s.def.hasChoosePhase === false) {
      s.def.prepareRound?.(st);
      return this.startEvents(s);
    }
    st.choosing = true;
    st.candidates = s.def.pickCandidates(CHOICE_COUNT);
    st.word = '';
    this.armChoiceTimer(s);
    return s.players.map((p) => {
      const other = st.players.find((x) => x !== p)!;
      const role: GameRole = p === st.drawerId ? 'drawer' : 'guesser';
      return {
        toUserId: p,
        event: 'game:choose' as const,
        data: {
          role,
          words: role === 'drawer' ? st.candidates : undefined,
          chooseSeconds: CHOOSE_SECONDS,
          round: st.round,
          myScore: st.scores[p] || 0,
          opponentScore: st.scores[other] || 0,
          targetScore: TARGET_SCORE,
        },
      };
    });
  }

  /** Выход/завершение игры. */
  leave(chatId: string, _userId: string): OutEvent[] {
    const s = this.sessions.get(chatId);
    if (!s) return [];
    this.clearSession(chatId);
    return s.players.map((p) => ({ toUserId: p, event: 'game:end' as const, data: { reason: 'ended' } }));
  }

  /** Завершить игру при выходе из чата/дисконнекте (без рассылки конкретному). */
  endForChat(chatId: string): OutEvent[] {
    return this.leave(chatId, '');
  }

  /** Длительность раунда конкретной игры (мс). */
  private roundMsFor(s: Session): number {
    return s.def.roundSecondsOverride ? s.def.roundSecondsOverride * 1000 : this.roundMs;
  }

  /** game:start обоим игрокам (роль-специфично) + перезапуск таймера раунда. */
  private startEvents(s: Session): OutEvent[] {
    const st = s.state!;
    this.armTimer(s);
    return s.players.map((p) => {
      const info = s.def.startInfo(st, p);
      const other = st.players.find((x) => x !== p)!;
      return {
        toUserId: p,
        event: 'game:start' as const,
        data: {
          gameId: st.gameId,
          role: info.role,
          word: info.word,
          mask: info.mask,
          question: info.question,
          myScore: st.scores[p] || 0,
          opponentScore: st.scores[other] || 0,
          round: st.round,
          roundSeconds: Math.round(this.roundMsFor(s) / 1000),
          targetScore: st.quiz ? st.quiz.total : TARGET_SCORE,
        },
      };
    });
  }

  /** Персонализированный game:end по итогам игры (победа/поражение + счёт).
   *  Без winnerId — кооперативный финал (youWon не отправляется). */
  private finishEvents(s: Session, winnerId?: string): OutEvent[] {
    const st = s.state!;
    try {
      this.finishListener?.({
        players: s.players,
        winnerId,
        gameId: st.gameId,
        quizMatches: st.quiz?.matches,
      });
    } catch { /* геймификация не должна ломать игру */ }
    return s.players.map((p) => {
      const other = s.players.find((x) => x !== p)!;
      return {
        toUserId: p,
        event: 'game:end' as const,
        data: {
          reason: 'finished',
          ...(winnerId ? { youWon: p === winnerId } : {}),
          myScore: st.scores[p] || 0,
          opponentScore: st.scores[other] || 0,
        },
      };
    });
  }

  /** (Пере)запуск таймера раунда активной сессии (+ подсказка середины раунда). */
  private armTimer(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    if (s.hintTimer) clearTimeout(s.hintTimer);
    const ms = this.roundMsFor(s);
    s.roundEndsAt = Date.now() + ms;
    s.timer = setTimeout(() => this.onRoundTimeout(s.chatId), ms);
    s.timer.unref?.();
    if (s.def.onHalfTime) {
      s.hintTimer = setTimeout(() => this.onHalfTime(s.chatId), Math.round(ms / 2));
      s.hintTimer.unref?.();
    }
  }

  /** Середина раунда: игра может подсластить ожидание (подсказка-буква). */
  private onHalfTime(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'active' || !s.state || s.state.choosing) return;
    const evs = s.def.onHalfTime?.(s.state);
    if (!evs || evs.length === 0) return;
    const out: OutEvent[] = [];
    for (const e of evs) {
      const targets = e.to === 'guessers'
        ? s.players.filter((p) => p !== s.state!.drawerId)
        : s.players;
      for (const t of targets) {
        out.push({ toUserId: t, event: 'game:event', data: { type: e.type, payload: e.payload } });
      }
    }
    this.dispatcher?.(out);
  }

  /** Таймер фазы выбора слова: по истечении — авто-выбор первого кандидата. */
  private armChoiceTimer(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    if (s.hintTimer) clearTimeout(s.hintTimer);
    s.roundEndsAt = undefined; // раунд ещё не идёт
    s.timer = setTimeout(() => this.onChoiceTimeout(s.chatId), CHOOSE_SECONDS * 1000);
    s.timer.unref?.();
  }

  /** Рисующий не выбрал слово вовремя → берём первого кандидата и начинаем раунд. */
  private onChoiceTimeout(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'active' || !s.state || !s.state.choosing) return;
    const st = s.state;
    st.word = st.candidates[0] || pickWord();
    st.choosing = false;
    st.candidates = [];
    this.dispatcher?.(this.startEvents(s));
  }

  /**
   * События для переподключившегося игрока (ресинк без пере-арма таймера):
   * - активная партия → game:start-снапшот с ролью/счётом/остатком времени;
   * - нет партии (завершилась, пока клиент был офлайн) → game:end, чтобы закрыть
   *   «зависший» оверлей; ожидающее приглашение (pending) не трогаем.
   */
  syncEvents(chatId: string, userId: string): OutEvent[] {
    const s = this.sessions.get(chatId);
    if (!s || !s.players.includes(userId)) {
      return [{ toUserId: userId, event: 'game:end', data: { reason: 'ended' } }];
    }
    if (s.status !== 'active' || !s.state) return []; // pending — оставляем приглашение
    const st = s.state;
    const other = st.players.find((x) => x !== userId)!;

    // Фаза выбора слова: пере-отдаём game:choose (рисующему — слова, угадывающему — ожидание).
    if (st.choosing) {
      const role: GameRole = userId === st.drawerId ? 'drawer' : 'guesser';
      return [{
        toUserId: userId,
        event: 'game:choose',
        data: {
          role,
          words: role === 'drawer' ? st.candidates : undefined,
          chooseSeconds: CHOOSE_SECONDS,
          round: st.round,
          myScore: st.scores[userId] || 0,
          opponentScore: st.scores[other] || 0,
          targetScore: TARGET_SCORE,
        },
      }];
    }

    const info = s.def.startInfo(st, userId);
    const remainingMs = s.roundEndsAt ? Math.max(0, s.roundEndsAt - Date.now()) : this.roundMsFor(s);
    // Квиз: переподключившийся должен видеть свой уже данный ответ (кнопки
    // залочены на верном варианте) и знать, ответил ли партнёр
    const quizSync = st.quiz ? {
      myAnswer: st.quiz.answers[userId],
      partnerAnswered: st.quiz.answers[other] !== undefined,
    } : {};
    return [{
      toUserId: userId,
      event: 'game:start',
      data: {
        gameId: st.gameId,
        role: info.role,
        word: info.word,
        mask: info.mask,
        question: info.question,
        ...quizSync,
        myScore: st.scores[userId] || 0,
        opponentScore: st.scores[other] || 0,
        round: st.round,
        roundSeconds: Math.max(1, Math.round(remainingMs / 1000)),
        targetScore: st.quiz ? st.quiz.total : TARGET_SCORE,
      },
    }];
  }

  /** Истечение таймера раунда: события игры + новый раунд через диспетчер. */
  private onRoundTimeout(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'active' || !s.state) return;
    const { events, restart, finished } = s.def.onTimeout(s.state);
    const out: OutEvent[] = [];
    for (const e of events) {
      // без инициатора события адресуем обоим игрокам
      for (const t of s.players) {
        out.push({ toUserId: t, event: 'game:event', data: { type: e.type, payload: e.payload } });
      }
    }
    if (finished) {
      out.push(...this.finishEvents(s));
      this.clearSession(chatId);
    } else if (restart) {
      out.push(...this.beginRound(s)); // новый раунд → выбор слова
    }
    this.dispatcher?.(out);
  }

  /** Удаление сессии с остановкой таймера. */
  private clearSession(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (s?.timer) clearTimeout(s.timer);
    if (s?.hintTimer) clearTimeout(s.hintTimer);
    this.sessions.delete(chatId);
  }
}

export const gameManager = new GameManager();
