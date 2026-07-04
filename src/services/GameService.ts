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
  | { toUserId: string; event: 'game:start'; data: { gameId: string; role: GameRole; word?: string; myScore: number; opponentScore: number; round: number; roundSeconds: number; targetScore: number } }
  | { toUserId: string; event: 'game:event'; data: { type: string; payload?: any } }
  | { toUserId: string; event: 'game:end'; data: { reason?: string; youWon?: boolean; myScore?: number; opponentScore?: number } };

/** Длительность раунда: не успел угадать — слово раскрывается, роли меняются. */
export const ROUND_SECONDS = 90;
/** Игра идёт до этого количества очков. */
export const TARGET_SCORE = 5;

export type GameRole = 'drawer' | 'guesser';

export interface GameState {
  gameId: string;
  players: [string, string]; // userIds
  scores: Record<string, number>;
  round: number;
  // специфично для draw-guess
  drawerId: string;
  word: string;
}

interface GameDefinition {
  id: string;
  title: string;
  /** Начальное состояние новой игры (starter ходит первым «рисующим»). */
  init(players: [string, string], starterId: string): GameState;
  /** Роль игрока + приватные данные для game:start (рисующему — слово). */
  startInfo(state: GameState, userId: string): { role: GameRole; word?: string };
  /** Обработка in-game события. restart=true → сервер заново разошлёт game:start обоим (новый раунд). */
  onEvent(
    state: GameState,
    fromUserId: string,
    type: string,
    payload: any
  ): { events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }>; restart?: boolean; winnerId?: string };
  /** Истёк таймер раунда. Вернуть события и (обычно) restart для нового раунда. */
  onTimeout(state: GameState): { events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }>; restart?: boolean };
}

// ── Банк слов для «Угадай рисунок» (простые, рисуемые) ──────────────────────────
const WORD_BANK = [
  'кот', 'собака', 'дом', 'дерево', 'солнце', 'машина', 'цветок', 'рыба', 'звезда', 'сердце',
  'яблоко', 'банан', 'гриб', 'зонт', 'очки', 'часы', 'ключ', 'лодка', 'самолёт', 'ракета',
  'гитара', 'барабан', 'мяч', 'воздушный шар', 'снеговик', 'ёлка', 'торт', 'мороженое', 'пицца', 'чашка',
  'телефон', 'компьютер', 'книга', 'карандаш', 'ножницы', 'молоток', 'лампочка', 'свеча', 'замок', 'мост',
  'гора', 'река', 'облако', 'радуга', 'молния', 'снежинка', 'лист', 'бабочка', 'пчела', 'паук',
  'слон', 'жираф', 'лев', 'медведь', 'заяц', 'лиса', 'птица', 'улитка', 'черепаха', 'краб',
  'корона', 'робот', 'призрак', 'клоун', 'футболка', 'ботинок', 'шляпа', 'перчатка', 'флаг', 'якорь',
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
      word: pickWord(),
    };
  },

  startInfo(state, userId) {
    const role: GameRole = userId === state.drawerId ? 'drawer' : 'guesser';
    return { role, word: role === 'drawer' ? state.word : undefined };
  },

  onEvent(state, fromUserId, type, payload) {
    const isDrawer = fromUserId === state.drawerId;

    switch (type) {
      case 'draw': // штрихи: рисующий → угадывающему
        if (!isDrawer) return { events: [] };
        return { events: [{ to: 'other', type: 'draw', payload }] };

      case 'clear': // очистка холста рисующим
        if (!isDrawer) return { events: [] };
        return { events: [{ to: 'other', type: 'clear' }] };

      case 'skip': // рисующий пропускает слово → новое слово, роли те же
        if (!isDrawer) return { events: [] };
        state.word = pickWord(state.word);
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
          // меняем рисующего, новое слово, новый раунд
          state.round += 1;
          state.drawerId = fromUserId; // угадавший становится рисующим (роли меняются)
          state.word = pickWord(guessedWord);
          return { events: [correctEvent], restart: true };
        }
        // неверно: показываем догадку рисующему
        return { events: [{ to: 'other', type: 'guess', payload: { text: String(payload?.text || '').slice(0, 60) } }] };
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
    state.word = pickWord(expiredWord);
    return {
      events: [{ to: 'both', type: 'timeout', payload: { word: expiredWord } }],
      restart: true,
    };
  },
};

const GAMES: Record<string, GameDefinition> = {
  [drawGuess.id]: drawGuess,
};

interface Session {
  def: GameDefinition;
  state?: GameState; // есть после accept
  players: [string, string];
  inviterId: string;
  status: 'pending' | 'active';
  chatId: string;
  timer?: NodeJS.Timeout; // таймер текущего раунда
  roundEndsAt?: number; // ms epoch окончания текущего раунда (для ресинка при reconnect)
}

export class GameManager {
  private sessions = new Map<string, Session>(); // chatId -> session
  /** Рассылка событий вне запроса (истечение таймера раунда). Регистрирует WebSocketManager. */
  private dispatcher: ((events: OutEvent[]) => void) | null = null;

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
    if (!s || s.status !== 'pending' || userId === s.inviterId) return [];
    if (!accept) {
      this.clearSession(chatId);
      return s.players.map((p) => ({ toUserId: p, event: 'game:end' as const, data: { reason: 'declined' } }));
    }
    s.state = s.def.init(s.players, s.inviterId);
    s.status = 'active';
    return this.startEvents(s);
  }

  /** In-game событие (draw/guess/clear/skip). */
  event(chatId: string, fromUserId: string, type: string, payload: any): OutEvent[] {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'active' || !s.state) return [];
    if (!s.players.includes(fromUserId)) return [];
    const { events, restart, winnerId } = s.def.onEvent(s.state, fromUserId, type, payload);
    const out: OutEvent[] = [];
    for (const e of events) {
      const targets = e.to === 'both' ? s.players : e.to === 'self' ? [fromUserId] : [s.players.find((p) => p !== fromUserId)!];
      for (const t of targets) {
        out.push({ toUserId: t, event: 'game:event', data: { type: e.type, payload: e.payload } });
      }
    }
    if (winnerId) {
      out.push(...this.finishEvents(s, winnerId));
      this.clearSession(chatId);
      return out;
    }
    if (restart) out.push(...this.startEvents(s));
    return out;
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
          myScore: st.scores[p] || 0,
          opponentScore: st.scores[other] || 0,
          round: st.round,
          roundSeconds: Math.round(this.roundMs / 1000),
          targetScore: TARGET_SCORE,
        },
      };
    });
  }

  /** Персонализированный game:end по итогам игры (победа/поражение + счёт). */
  private finishEvents(s: Session, winnerId: string): OutEvent[] {
    const st = s.state!;
    return s.players.map((p) => {
      const other = s.players.find((x) => x !== p)!;
      return {
        toUserId: p,
        event: 'game:end' as const,
        data: {
          reason: 'finished',
          youWon: p === winnerId,
          myScore: st.scores[p] || 0,
          opponentScore: st.scores[other] || 0,
        },
      };
    });
  }

  /** (Пере)запуск таймера раунда активной сессии. */
  private armTimer(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.roundEndsAt = Date.now() + this.roundMs;
    s.timer = setTimeout(() => this.onRoundTimeout(s.chatId), this.roundMs);
    s.timer.unref?.();
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
    const info = s.def.startInfo(st, userId);
    const other = st.players.find((x) => x !== userId)!;
    const remainingMs = s.roundEndsAt ? Math.max(0, s.roundEndsAt - Date.now()) : this.roundMs;
    return [{
      toUserId: userId,
      event: 'game:start',
      data: {
        gameId: st.gameId,
        role: info.role,
        word: info.word,
        myScore: st.scores[userId] || 0,
        opponentScore: st.scores[other] || 0,
        round: st.round,
        roundSeconds: Math.max(1, Math.round(remainingMs / 1000)),
        targetScore: TARGET_SCORE,
      },
    }];
  }

  /** Истечение таймера раунда: события игры + новый раунд через диспетчер. */
  private onRoundTimeout(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'active' || !s.state) return;
    const { events, restart } = s.def.onTimeout(s.state);
    const out: OutEvent[] = [];
    for (const e of events) {
      // без инициатора события адресуем обоим игрокам
      for (const t of s.players) {
        out.push({ toUserId: t, event: 'game:event', data: { type: e.type, payload: e.payload } });
      }
    }
    if (restart) out.push(...this.startEvents(s));
    this.dispatcher?.(out);
  }

  /** Удаление сессии с остановкой таймера. */
  private clearSession(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (s?.timer) clearTimeout(s.timer);
    this.sessions.delete(chatId);
  }
}

export const gameManager = new GameManager();
