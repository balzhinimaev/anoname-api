import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GameManager, OutEvent, TARGET_SCORE, ROUND_SECONDS, CHOOSE_SECONDS, CHOICE_COUNT } from '../src/services/GameService';

const CHAT = 'c1';
const A = 'userA';
const B = 'userB';
const PLAYERS: [string, string] = [A, B];

/** Кандидаты слов, предложенные пользователю в game:choose (undefined у угадывающего). */
function wordsFor(out: OutEvent[], user: string): string[] | undefined {
  const e = out.find((x) => x.toUserId === user && x.event === 'game:choose') as any;
  return e ? (e.data.words as string[] | undefined) : undefined;
}

/** Рисующий выбирает кандидата idx → game:start обоим. */
function pick(gm: GameManager, drawer: string, idx = 0): OutEvent[] {
  return gm.event(CHAT, drawer, 'pick', { index: idx });
}

/** Полный старт до фазы рисования (A — рисующий) и слово рисующего. */
function startGame(): { gm: GameManager; word: string; startOut: OutEvent[] } {
  const gm = new GameManager();
  gm.invite(CHAT, A, 'draw-guess', PLAYERS);
  gm.respond(CHAT, B, true); // → game:choose
  const startOut = pick(gm, A, 0); // → game:start
  const startA = startOut.find((e) => e.toUserId === A && e.event === 'game:start') as any;
  return { gm, word: startA.data.word as string, startOut };
}

describe('GameManager.catalog', () => {
  it('содержит игру «Угадай рисунок»', () => {
    expect(GameManager.catalog()).toEqual(expect.arrayContaining([{ id: 'draw-guess', title: 'Угадай рисунок' }]));
  });
});

describe('invite / respond', () => {
  it('invite шлёт приглашение ТОЛЬКО сопернику', () => {
    const gm = new GameManager();
    const out = gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toUserId: B, event: 'game:invite' });
    expect((out[0].data as any).by).toBe(A);
  });

  it('invite на несуществующую игру — ничего', () => {
    const gm = new GameManager();
    expect(gm.invite(CHAT, A, 'no-such', PLAYERS)).toEqual([]);
  });

  it('accept → game:choose обоим: рисующему N слов на выбор, угадывающему — ожидание; счёт 0:0', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const out = gm.respond(CHAT, B, true);
    const chooses = out.filter((e) => e.event === 'game:choose');
    expect(chooses).toHaveLength(2);
    const a = chooses.find((e) => e.toUserId === A)!.data as any;
    const b = chooses.find((e) => e.toUserId === B)!.data as any;
    expect(a.role).toBe('drawer');
    expect(Array.isArray(a.words)).toBe(true);
    expect(a.words).toHaveLength(CHOICE_COUNT);
    expect(new Set(a.words).size).toBe(CHOICE_COUNT); // слова различны
    expect(b.role).toBe('guesser');
    expect(b.words).toBeUndefined();
    expect(a.myScore).toBe(0);
    expect(a.round).toBe(1);
  });

  it('decline → game:end обоим, игра не активна', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const out = gm.respond(CHAT, B, false);
    expect(out.every((e) => e.event === 'game:end')).toBe(true);
    expect(out.map((e) => e.toUserId).sort()).toEqual([A, B]);
    expect(gm.event(CHAT, A, 'draw', {})).toEqual([]);
  });

  it('пригласивший не может сам принять приглашение', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    expect(gm.respond(CHAT, A, true)).toEqual([]);
  });
});

describe('выбор слова (choose phase)', () => {
  it('pick рисующим → game:start обоим: рисующему выбранное слово, угадывающему маска', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const chooseOut = gm.respond(CHAT, B, true);
    const words = wordsFor(chooseOut, A)!;
    const out = pick(gm, A, 1);
    const starts = out.filter((e) => e.event === 'game:start');
    expect(starts).toHaveLength(2);
    const a = starts.find((e) => e.toUserId === A)!.data as any;
    const b = starts.find((e) => e.toUserId === B)!.data as any;
    expect(a.word).toBe(words[1]); // выбрано именно то слово
    expect(b.word).toBeUndefined();
    expect(typeof b.mask).toBe('string');
  });

  it('pick с неверным индексом игнорируется (остаёмся в выборе)', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    gm.respond(CHAT, B, true);
    expect(pick(gm, A, 99)).toEqual([]);
    // всё ещё выбор: рисование не работает, а корректный pick — работает
    expect(gm.event(CHAT, A, 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([]);
    expect(pick(gm, A, 0).some((e) => e.event === 'game:start')).toBe(true);
  });

  it('pick от угадывающего игнорируется', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    gm.respond(CHAT, B, true);
    expect(pick(gm, B, 0)).toEqual([]);
  });

  it('guess во время выбора игнорируется', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const chooseOut = gm.respond(CHAT, B, true);
    const words = wordsFor(chooseOut, A)!;
    expect(gm.event(CHAT, B, 'guess', { text: words[0] })).toEqual([]);
  });
});

describe('рисование (draw/clear)', () => {
  it('draw от рисующего → ретранслируется ТОЛЬКО угадывающему', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, A, 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toUserId: B, event: 'game:event' });
    expect((out[0].data as any).type).toBe('draw');
  });

  it('draw от угадывающего игнорируется (рисует только drawer)', () => {
    const { gm } = startGame();
    expect(gm.event(CHAT, B, 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([]);
  });

  it('clear от рисующего → угадывающему', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, A, 'clear', {});
    expect(out).toHaveLength(1);
    expect((out[0].data as any).type).toBe('clear');
  });
});

describe('угадывание (guess)', () => {
  it('неверная догадка → показывается ТОЛЬКО рисующему', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, B, 'guess', { text: 'йцукенгшщзхъ' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toUserId: A, event: 'game:event' });
    expect((out[0].data as any).type).toBe('guess');
  });

  it('верная догадка → correct обоим + новый раунд (game:choose): роли меняются, счёт угадавшему', () => {
    const { gm, word } = startGame();
    const out = gm.event(CHAT, B, 'guess', { text: word });

    const correct = out.filter((e) => (e.data as any).type === 'correct');
    expect(correct.map((e) => e.toUserId).sort()).toEqual([A, B]);
    expect((correct[0].data as any).payload.word).toBe(word);

    const chooses = out.filter((e) => e.event === 'game:choose');
    expect(chooses).toHaveLength(2);
    const bChoose = chooses.find((e) => e.toUserId === B)!.data as any;
    const aChoose = chooses.find((e) => e.toUserId === A)!.data as any;
    // Угадавший (B) теперь рисующий и выбирает слово, A — угадывающий (ждёт)
    expect(bChoose.role).toBe('drawer');
    expect(Array.isArray(bChoose.words)).toBe(true);
    expect(aChoose.role).toBe('guesser');
    expect(aChoose.words).toBeUndefined();
    expect(bChoose.myScore).toBe(1);
    expect(aChoose.myScore).toBe(0);
    expect(bChoose.round).toBe(2);
  });

  it('верная догадка нечувствительна к регистру/ё и пробелам', () => {
    const { gm, word } = startGame();
    const messy = ` ${word.toUpperCase().replace(/е/gi, 'Ё')} `;
    const out = gm.event(CHAT, B, 'guess', { text: messy });
    expect(out.some((e) => (e.data as any).type === 'correct')).toBe(true);
  });

  it('рисующий не может «угадать» своё слово', () => {
    const { gm, word } = startGame();
    expect(gm.event(CHAT, A, 'guess', { text: word })).toEqual([]);
  });
});

describe('skip и leave', () => {
  it('skip рисующим → skipped обоим + новый выбор слова (роли те же)', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, A, 'skip', {});
    expect(out.some((e) => (e.data as any).type === 'skipped')).toBe(true);
    const aChoose = out.find((e) => e.toUserId === A && e.event === 'game:choose')!.data as any;
    expect(aChoose.role).toBe('drawer'); // роли НЕ меняются при skip
    expect(Array.isArray(aChoose.words)).toBe(true);
  });

  it('leave → game:end обоим, дальнейшие события игнорируются', () => {
    const { gm } = startGame();
    const out = gm.leave(CHAT, A);
    expect(out.every((e) => e.event === 'game:end')).toBe(true);
    expect(gm.event(CHAT, A, 'draw', {})).toEqual([]);
  });
});

describe('авторизация участников', () => {
  it('событие от постороннего (не игрока) игнорируется', () => {
    const { gm } = startGame();
    expect(gm.event(CHAT, 'intruder', 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([]);
    expect(gm.event(CHAT, 'intruder', 'guess', { text: 'кот' })).toEqual([]);
  });

  it('события без активной игры — пусто', () => {
    const gm = new GameManager();
    expect(gm.event('nope', A, 'draw', {})).toEqual([]);
  });

  it('повторное приглашение во время активной игры игнорируется (не сбрасывает игру)', () => {
    const { gm } = startGame();
    expect(gm.invite(CHAT, A, 'draw-guess', PLAYERS)).toEqual([]);
    expect(gm.event(CHAT, A, 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 })).toHaveLength(1);
  });
});

describe('конец игры (победа до TARGET_SCORE)', () => {
  /** Играет верными догадками до конца (после каждого раунда новый рисующий выбирает слово). */
  function playToWin(gm: GameManager, firstWord: string): OutEvent[] {
    let drawer = A;
    let word = firstWord;
    for (let i = 0; i < TARGET_SCORE * 2 + 2; i++) {
      const guesser = drawer === A ? B : A;
      const out = gm.event(CHAT, guesser, 'guess', { text: word });
      if (out.some((e) => e.event === 'game:end')) return out;
      drawer = guesser; // угадавший стал рисующим и выбирает слово
      const startOut = pick(gm, drawer, 0);
      const st = startOut.find((e) => e.toUserId === drawer && e.event === 'game:start') as any;
      word = st.data.word;
    }
    throw new Error('игра не завершилась за ожидаемое число раундов');
  }

  it('game:start содержит roundSeconds и targetScore', () => {
    const { startOut } = startGame();
    const start = startOut.find((e) => e.event === 'game:start')!.data as any;
    expect(start.roundSeconds).toBe(ROUND_SECONDS);
    expect(start.targetScore).toBe(TARGET_SCORE);
  });

  it('набор TARGET_SCORE очков → correct + персонализированный game:end, сессия закрыта', () => {
    const { gm, word } = startGame();
    const out = playToWin(gm, word);

    expect(out.some((e) => (e.data as any).type === 'correct')).toBe(true);
    expect(out.some((e) => e.event === 'game:start')).toBe(false);
    expect(out.some((e) => e.event === 'game:choose')).toBe(false);
    const ends = out.filter((e) => e.event === 'game:end');
    expect(ends).toHaveLength(2);
    const winnerEnd = ends.find((e) => (e.data as any).youWon)!.data as any;
    const loserEnd = ends.find((e) => !(e.data as any).youWon)!.data as any;
    expect(winnerEnd.reason).toBe('finished');
    expect(winnerEnd.myScore).toBe(TARGET_SCORE);
    expect(loserEnd.opponentScore).toBe(TARGET_SCORE);

    expect(gm.event(CHAT, A, 'draw', {})).toEqual([]);
    expect(gm.invite(CHAT, A, 'draw-guess', PLAYERS)).toHaveLength(1);
  });
});

describe('таймеры (выбор + раунд)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  /** Заводит игру и доводит до фазы рисования (A рисует), round timer = roundMs. */
  function startDrawing(roundMs = 5000) {
    const gm = new GameManager(roundMs);
    const dispatched: OutEvent[][] = [];
    gm.setDispatcher((evts) => dispatched.push(evts));
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    gm.respond(CHAT, B, true);
    const out = pick(gm, A, 0);
    const word = (out.find((e) => e.toUserId === A && e.event === 'game:start')!.data as any).word as string;
    return { gm, dispatched, word };
  }

  it('истечение выбора → авто-выбор и game:start (диспетчер)', () => {
    const gm = new GameManager(5000);
    const dispatched: OutEvent[][] = [];
    gm.setDispatcher((evts) => dispatched.push(evts));
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    gm.respond(CHAT, B, true); // фаза выбора, choice timer
    jest.advanceTimersByTime(CHOOSE_SECONDS * 1000);
    expect(dispatched).toHaveLength(1);
    const starts = dispatched[0].filter((e) => e.event === 'game:start');
    expect(starts).toHaveLength(2);
    expect((starts.find((e) => e.toUserId === A)!.data as any).word).toBeTruthy();
  });

  it('истечение раунда → timeout обоим + новый выбор (game:choose), роли меняются', () => {
    const { dispatched, word } = startDrawing();
    jest.advanceTimersByTime(5000);
    // 2 диспатча: подсказка-буква на середине раунда + сам timeout
    expect(dispatched).toHaveLength(2);
    const hint = dispatched[0].find((e) => (e.data as any).type === 'hint') as any;
    expect(hint).toBeTruthy();
    expect(String(hint.data.payload.mask)).toMatch(/[а-яa-z]/i); // буква раскрыта
    const out = dispatched[1];
    const timeouts = out.filter((e) => (e.data as any).type === 'timeout');
    expect(timeouts.map((e) => e.toUserId).sort()).toEqual([A, B]);
    expect((timeouts[0].data as any).payload.word).toBe(word);
    const bChoose = out.find((e) => e.toUserId === B && e.event === 'game:choose')!.data as any;
    expect(bChoose.role).toBe('drawer'); // роли поменялись
    expect(bChoose.round).toBe(2);
  });

  it('верная догадка снимает round timer (старый дедлайн не срабатывает)', () => {
    const { gm, dispatched, word } = startDrawing();
    jest.advanceTimersByTime(4000); // на 2.5с прилетела подсказка-буква
    gm.event(CHAT, B, 'guess', { text: word }); // → фаза выбора (round timer снят, взведён choice 15s)
    jest.advanceTimersByTime(1500); // старый round-дедлайн (5s) прошёл — ничего нового
    expect(dispatched).toHaveLength(1); // только подсказка, timeout НЕ сработал
    expect((dispatched[0][0].data as any).type).toBe('hint');
  });

  it('после leave таймер не срабатывает', () => {
    const { gm, dispatched } = startDrawing();
    gm.leave(CHAT, A);
    jest.advanceTimersByTime(60000);
    expect(dispatched).toHaveLength(0);
  });
});

describe('подсказки: маска и «почти»', () => {
  it('угадывающий получает маску вместо слова; число точек = числу букв', () => {
    const { word, startOut } = startGame();
    const guesser = startOut.find((e) => e.toUserId === B && e.event === 'game:start')!.data as any;
    expect(guesser.word).toBeUndefined();
    expect(typeof guesser.mask).toBe('string');
    const dots = (guesser.mask.match(/•/g) || []).length;
    expect(dots).toBe(word.replace(/ /g, '').length);
  });

  it('близкая догадка (расстояние 1) → «close» угадывающему + показ рисующему, очков нет', () => {
    const { gm, word } = startGame();
    const near = word.slice(0, -1); // удаляем последнюю букву → расстояние 1
    const out = gm.event(CHAT, B, 'guess', { text: near });
    expect(out.some((e) => e.toUserId === B && (e.data as any).type === 'close')).toBe(true);
    expect(out.some((e) => e.toUserId === A && (e.data as any).type === 'guess')).toBe(true);
    const cont = gm.event(CHAT, B, 'guess', { text: word });
    expect(cont.some((e) => (e.data as any).type === 'correct')).toBe(true);
  });

  it('совсем не близкая догадка → без «close»', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, B, 'guess', { text: 'йцукенгшщз' });
    expect(out.some((e) => (e.data as any).type === 'close')).toBe(false);
    expect(out.some((e) => e.toUserId === A && (e.data as any).type === 'guess')).toBe(true);
  });
});


// ── Игра «Совпадения» (match-quiz) ─────────────────────────────────────────────
describe('match-quiz', () => {
  function startQuiz(): { gm: GameManager; startOut: OutEvent[] } {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'match-quiz', PLAYERS);
    const startOut = gm.respond(CHAT, B, true); // без фазы выбора — сразу game:start
    return { gm, startOut };
  }

  it('в каталоге; accept → сразу game:start с вопросом обоим (без game:choose)', () => {
    expect(GameManager.catalog()).toEqual(expect.arrayContaining([{ id: 'match-quiz', title: 'Совпадения' }]));
    const { startOut } = startQuiz();
    const starts = startOut.filter((e) => e.event === 'game:start');
    expect(starts).toHaveLength(2);
    const qa = (starts[0].data as any).question;
    const qb = (starts[1].data as any).question;
    expect(qa?.text).toBeTruthy();
    expect(qa.options.length).toBeGreaterThanOrEqual(2);
    expect(qb.text).toBe(qa.text); // вопрос одинаковый
    expect(startOut.some((e) => e.event === 'game:choose')).toBe(false);
  });

  it('первый ответ → partner_answered второму; совпадение → reveal с matched и рост счёта', () => {
    const { gm } = startQuiz();
    const out1 = gm.event(CHAT, A, 'answer', { index: 0 });
    expect(out1).toHaveLength(1);
    expect(out1[0].toUserId).toBe(B);
    expect((out1[0].data as any).type).toBe('partner_answered');

    const out2 = gm.event(CHAT, B, 'answer', { index: 0 });
    const reveals = out2.filter((e) => (e.data as any).type === 'reveal');
    expect(reveals.map((e) => e.toUserId).sort()).toEqual([A, B]);
    const rA = reveals.find((e) => e.toUserId === A)!.data as any;
    expect(rA.payload.matched).toBe(true);
    expect(rA.payload.matches).toBe(1);
    // следующий раунд стартует сразу (game:start с новым вопросом)
    const nextStarts = out2.filter((e) => e.event === 'game:start');
    expect(nextStarts).toHaveLength(2);
    expect((nextStarts[0].data as any).round).toBe(2);
  });

  it('несовпадение → matched=false, счёт не растёт; повторный ответ игнорируется', () => {
    const { gm } = startQuiz();
    gm.event(CHAT, A, 'answer', { index: 0 });
    expect(gm.event(CHAT, A, 'answer', { index: 1 })).toHaveLength(0); // не переголосовать
    const out = gm.event(CHAT, B, 'answer', { index: 1 });
    const rB = out.find((e) => e.toUserId === B && (e.data as any).type === 'reveal')!.data as any;
    expect(rB.payload.matched).toBe(false);
    expect(rB.payload.matches).toBe(0);
    expect(rB.payload.mine).toBe(1);
    expect(rB.payload.partner).toBe(0);
  });

  it('после последнего раунда — quiz_final и кооперативный game:end (без youWon)', () => {
    const { gm } = startQuiz();
    let final: OutEvent[] = [];
    for (let r = 0; r < 10; r++) {
      gm.event(CHAT, A, 'answer', { index: 0 });
      final = gm.event(CHAT, B, 'answer', { index: 0 });
    }
    const quizFinal = final.filter((e) => (e.data as any).type === 'quiz_final');
    expect(quizFinal.map((e) => e.toUserId).sort()).toEqual([A, B]);
    expect((quizFinal[0].data as any).payload).toEqual({ matches: 10, total: 10 });
    const ends = final.filter((e) => e.event === 'game:end');
    expect(ends).toHaveLength(2);
    const endA = ends.find((e) => e.toUserId === A)!.data as any;
    expect(endA.reason).toBe('finished');
    expect(endA.youWon).toBeUndefined(); // кооператив — победителя нет
    expect(endA.myScore).toBe(10);
    // сессия закрыта — дальнейшие события игнорируются
    expect(gm.event(CHAT, A, 'answer', { index: 0 })).toHaveLength(0);
  });

  it('таймаут вопроса → quiz_timeout обоим и следующий вопрос (диспетчер)', () => {
    jest.useFakeTimers();
    const gm = new GameManager();
    const dispatched: OutEvent[][] = [];
    gm.setDispatcher((evts) => dispatched.push(evts));
    gm.invite(CHAT, A, 'match-quiz', PLAYERS);
    gm.respond(CHAT, B, true);
    jest.advanceTimersByTime(30_000); // QUIZ_ROUND_SECONDS
    const out = dispatched.flat();
    const timeouts = out.filter((e) => (e.data as any).type === 'quiz_timeout');
    expect(timeouts.map((e) => e.toUserId).sort()).toEqual([A, B]);
    const nextStarts = out.filter((e) => e.event === 'game:start');
    expect(nextStarts).toHaveLength(2);
    expect((nextStarts[0].data as any).round).toBe(2);
    jest.useRealTimers();
  });
});
