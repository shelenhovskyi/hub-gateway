# hub gateway

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shelenhovskyi/hub-gateway)

Your own backend for hub, on your free Cloudflare account. It gives the hub app:

- **Workers AI** without any API key: pictures (FLUX), transcription (Whisper), speech (MeloTTS), on your daily free neurons;
- **Morning digest**: every day at the hour you choose it reads your RSS/Atom feeds and writes a short summary;
- **Telegram bot**: your own AI bot for private chats and groups. It answers mentions and replies, understands photos and voice messages, draws, and remembers facts it is asked to. Set it up on the Telegram bot page in the hub app: paste the token from @BotFather, then press Start in the bot to become its owner. Only chats you allow get answers; `/privacy` tells members where their messages go.

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

One hourly cron (of the 5 the free plan allows per account), one SQLite Durable Object, Workers AI on the 10,000 daily free neurons. By Workers AI's published prices a bot answer costs roughly 50–100 neurons and a picture about as much again, so the default limit of 60 answers per chat per day leaves room for the other tools. When the neurons run out the gateway answers 429 and hub falls back to your other services.
