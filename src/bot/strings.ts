/** What the bot itself says. Its answers follow the language of each question instead. */
export const STRINGS = {
  en: {
    help: (u: string) =>
      `I'm an AI bot running on my owner's own free Cloudflare account.\n\n` +
      `In groups, mention @${u} or reply to my message. In a private chat, just write. I understand photos and voice messages, and I can draw ("draw a cat in a hat").\n\n` +
      `/reset forgets our recent conversation\n/facts shows what I remember about this chat\n/forget erases it\n/privacy tells where your messages go`,
    privacy:
      'Messages I answer, and in groups the recent conversation I can see, go to Cloudflare Workers AI on my owner’s Cloudflare account to write a reply. Recent messages are kept there for up to 24 hours so I can follow the conversation; facts you ask me to remember stay until /forget. Cloudflare does not use them to train models. The hub app that set me up never sees them.',
    commands: [
      ['help', 'What I can do'],
      ['reset', 'Forget our recent conversation'],
      ['facts', 'What I remember about this chat'],
      ['forget', 'Erase what I remember'],
      ['privacy', 'Where your messages go'],
    ],
    paired: (u: string) => `Done, you're my owner now. Write to me here, or add @${u} to a group: groups you add me to work straight away.`,
    pairFailed: 'This link is out of date. Open a fresh one from the Telegram bot page in the hub app.',
    notAllowed: 'This is a personal bot. Its owner can let you in from the hub app.',
    joinedGroup: (u: string) => `Hi! I'm an AI bot. Mention @${u} or reply to my message and I'll answer. /privacy tells where messages go.`,
    unknownGroup: (title: string) => `Someone added me to “${title}”. I stay silent there until you allow it on the Telegram bot page in the hub app.`,
    reset: 'Done, I forgot our recent conversation.',
    noFacts: 'I don’t remember anything about this chat yet. Ask me: “remember that…”.',
    facts: 'What I remember:',
    forgot: 'Done, I erased everything I remembered about this chat.',
    ownerOnly: 'Only my owner can do that in a group.',
    remembered: 'Remembered.',
    limit: (name: string, min: number) => `${name}, let me catch my breath. Back to you in ${min} min.`,
    chatLimit: 'That’s all the answers I give this chat today. See you tomorrow.',
    quota: 'My owner’s free Cloudflare quota for today has run out. I’ll be back after midnight UTC.',
    error: 'Sorry, I couldn’t answer just now. Try again in a minute.',
    voiceFailed: 'I couldn’t make out that voice message.',
    drawFailed: 'The picture didn’t work out. Try describing it differently.',
  },
  uk: {
    help: (u: string) =>
      `Я AI-бот, що працює на власному безкоштовному акаунті Cloudflare мого власника.\n\n` +
      `У групах тегни @${u} або відповідай на моє повідомлення. В особистих просто пиши. Розумію фото й голосові, вмію малювати («намалюй кота в капелюсі»).\n\n` +
      `/reset забуває недавню розмову\n/facts показує, що я пам'ятаю про цей чат\n/forget стирає це\n/privacy розповідає, куди йдуть повідомлення`,
    privacy:
      'Повідомлення, на які я відповідаю, а в групах ще й недавня розмова, яку я бачу, йдуть у Cloudflare Workers AI на акаунті мого власника, щоб написати відповідь. Недавні повідомлення зберігаються там до 24 годин, щоб я тримав нитку розмови; факти, які ви просите запам’ятати, лишаються до /forget. Cloudflare не тренує на них моделі. Застосунок hub, через який мене налаштували, їх не бачить.',
    commands: [
      ['help', 'Що я вмію'],
      ['reset', 'Забути недавню розмову'],
      ['facts', 'Що я пам’ятаю про цей чат'],
      ['forget', 'Стерти те, що я пам’ятаю'],
      ['privacy', 'Куди йдуть повідомлення'],
    ],
    paired: (u: string) => `Готово, тепер ти мій власник. Пиши мені тут або додай @${u} у групу: групи, куди мене додаєш ти, працюють одразу.`,
    pairFailed: 'Це посилання вже застаріло. Відкрий нове на сторінці Telegram-бота в застосунку hub.',
    notAllowed: 'Це особистий бот. Власник може дати тобі доступ у застосунку hub.',
    joinedGroup: (u: string) => `Привіт! Я AI-бот. Тегни @${u} або відповідай на моє повідомлення, і я відповім. /privacy розповідає, куди йдуть повідомлення.`,
    unknownGroup: (title: string) => `Мене додали в «${title}». Я мовчу там, доки ти не дозволиш цей чат на сторінці Telegram-бота в застосунку hub.`,
    reset: 'Готово, я забув недавню розмову.',
    noFacts: 'Я ще нічого не пам’ятаю про цей чат. Скажи: «запам’ятай, що…».',
    facts: 'Що я пам’ятаю:',
    forgot: 'Готово, я стер усе, що пам’ятав про цей чат.',
    ownerOnly: 'У групі це може зробити лише мій власник.',
    remembered: 'Запам’ятав.',
    limit: (name: string, min: number) => `${name}, дай мені трохи перепочити. Повернусь до тебе за ${min} хв.`,
    chatLimit: 'На сьогодні це всі відповіді для цього чату. До завтра.',
    quota: 'Безкоштовна квота Cloudflare мого власника на сьогодні скінчилась. Повернусь після опівночі за UTC.',
    error: 'Вибач, не вдалося відповісти. Спробуй за хвилину.',
    voiceFailed: 'Не вдалося розібрати це голосове.',
    drawFailed: 'Картинка не вийшла. Спробуй описати інакше.',
  },
} as const;

export type Lang = keyof typeof STRINGS;
export const LANGS = Object.keys(STRINGS) as Lang[];
