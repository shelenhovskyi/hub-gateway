# hub gateway

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shelenhovskyi/hub-gateway)

Your own backend for hub, on your free Cloudflare account. It gives the hub app:

- **Workers AI** without any API key: pictures (FLUX), transcription (Whisper), speech (MeloTTS), on your daily free neurons;
- **Morning digest**: every day at the hour you choose it reads your RSS/Atom feeds and writes a short summary;
- **Watches, reminders, weather**: page and price watches (every 15 minutes or more), one-off and repeating reminders, and a morning forecast with rain, frost and heat warnings from Open-Meteo. They run from a Durable Object alarm, not the cron, at most once per due time even if you press "check now" or edit the job meanwhile, and message you through your Telegram bot;
- **Telegram bot**: your own AI bot for private chats and groups. It answers mentions and replies, understands photos and voice messages, draws, remembers facts it is asked to, sets reminders (“remind us Friday at 7”, listed with `/reminders`, cancelled with `/cancel 1`) and sums up the last day with `/catchup`. In groups only you can make it remember facts or set repeating reminders, and each chat holds at most 5 waiting reminders, apart from the 50 jobs of the app. Telegram updates are queued and answered from the Durable Object's alarm, so a long voice note is not cut off. Set it up on the Telegram bot page in the hub app: paste the token from @BotFather, then press Start in the bot to become its owner. Only chats you allow get answers; `/privacy` tells members where their messages go.

- **Sync between devices**: one blob the hub app sealed with your passphrase before sending it (keys, settings, notes, expenses); the gateway keeps only that ciphertext and a version number, so a device that missed a change must pull it before it can write;
- **Shared lists**: shopping and to-do lists that family open by a link (`/l/<id>#<secret>`), no app or account; the secret after `#` never reaches a server log, the gateway keeps only its hash, and a new link shuts the old one. A link can make at most 600 changes a day;
- **Forms**: sign-up, RSVP and order forms at `/f/<id>` with answers kept here and sent to your Telegram bot. A new form starts closed; open ones take a daily number of answers you set (100 by default, 1000 at most), at most 10 a day from one network, and quietly drop bots that fill a hidden field or answer faster than a person could.

- **Notifications**: besides the Telegram bot, reminders, watches and form answers can reach you as push notifications (encrypted for each browser you allow, VAPID keys made on your gateway) and by email through your own Resend key, which is checked with a test email before it is kept and never sent back to the app.

Nothing here is shared with the hub's authors: the Worker runs in your account and only answers requests that carry your admin token.

## Deploy

With the "Deploy to Cloudflare" button in the hub app, Cloudflare copies this template into your GitHub or GitLab account, creates the Durable Object and asks for `ADMIN_TOKEN`. Choose any long random string.

By hand:

```bash
npx wrangler login
```

```bash
npx wrangler secret put ADMIN_TOKEN && npx wrangler deploy
```

Then in hub: Your kit, Cloudflare, paste `https://hub-gateway.<you>.workers.dev` and the token.

## Free-plan budget

The Durable Object's SQLite allows 5 million rows read and 100,000 written a day. Old messages, counters and handled updates are pruned once an hour by the cron rather than on every message, so a busy group costs a few row writes per message.

One hourly cron (of the 5 the free plan allows per account), one SQLite Durable Object, Workers AI on the 10,000 daily free neurons. By Workers AI's published prices a bot answer costs roughly 50–100 neurons and a picture about as much again, so the default limit of 60 answers per chat per day leaves room for the other tools. When the neurons run out the gateway answers 429 and hub falls back to your other services.
