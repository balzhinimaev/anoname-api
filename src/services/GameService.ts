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
  | { toUserId: string; event: 'game:start'; data: { gameId: string; role: GameRole; word?: string; myScore: number; opponentScore: number; round: number } }
  | { toUserId: string; event: 'game:event'; data: { type: string; payload?: any } }
  | { toUserId: string; event: 'game:end'; data: { reason?: string } };

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
  ): { events: Array<{ to: 'self' | 'other' | 'both'; type: string; payload?: any }>; restart?: boolean };
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
          // верно: очко угадавшему, меняем рисующего, новое слово, новый раунд
          state.scores[fromUserId] = (state.scores[fromUserId] || 0) + 1;
          state.round += 1;
          const guessedWord = state.word;
          state.drawerId = fromUserId; // угадавший становится рисующим (роли меняются)
          state.word = pickWord(guessedWord);
          return {
            events: [{ to: 'both', type: 'correct', payload: { by: fromUserId, word: guessedWord, scores: state.scores } }],
            restart: true,
          };
        }
        // неверно: показываем догадку рисующему
        return { events: [{ to: 'other', type: 'guess', payload: { text: String(payload?.text || '').slice(0, 60) } }] };
      }

      default:
        return { events: [] };
    }
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
}

export class GameManager {
  private sessions = new Map<string, Session>(); // chatId -> session

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
    this.sessions.set(chatId, { def, players, inviterId: fromUserId, status: 'pending' });
    return [{ toUserId: other, event: 'game:invite', data: { gameId: def.id, by: fromUserId, title: def.title } }];
  }

  /** Ответ на приглашение. accept=false → завершение. accept=true → старт (game:start обоим). */
  respond(chatId: string, userId: string, accept: boolean): OutEvent[] {
    const s = this.sessions.get(chatId);
    if (!s || s.status !== 'pending' || userId === s.inviterId) return [];
    if (!accept) {
      this.sessions.delete(chatId);
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
    const { events, restart } = s.def.onEvent(s.state, fromUserId, type, payload);
    const out: OutEvent[] = [];
    for (const e of events) {
      const targets = e.to === 'both' ? s.players : e.to === 'self' ? [fromUserId] : [s.players.find((p) => p !== fromUserId)!];
      for (const t of targets) {
        out.push({ toUserId: t, event: 'game:event', data: { type: e.type, payload: e.payload } });
      }
    }
    if (restart) out.push(...this.startEvents(s));
    return out;
  }

  /** Выход/завершение игры. */
  leave(chatId: string, _userId: string): OutEvent[] {
    const s = this.sessions.get(chatId);
    if (!s) return [];
    this.sessions.delete(chatId);
    return s.players.map((p) => ({ toUserId: p, event: 'game:end' as const, data: { reason: 'ended' } }));
  }

  /** Завершить игру при выходе из чата/дисконнекте (без рассылки конкретному). */
  endForChat(chatId: string): OutEvent[] {
    return this.leave(chatId, '');
  }

  /** game:start обоим игрокам (роль-специфично). */
  private startEvents(s: Session): OutEvent[] {
    const st = s.state!;
    return s.players.map((p) => {
      const info = s.def.startInfo(st, p);
      const other = st.players.find((x) => x !== p)!;
      return {
        toUserId: p,
        event: 'game:start' as const,
        data: { gameId: st.gameId, role: info.role, word: info.word, myScore: st.scores[p] || 0, opponentScore: st.scores[other] || 0, round: st.round },
      };
    });
  }
}

export const gameManager = new GameManager();
