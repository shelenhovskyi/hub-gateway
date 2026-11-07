import { markdownToTelegramHtml } from './format.ts';

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
}

export interface TgFile {
  file_id: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  entities?: { type: string; offset: number; length: number }[];
  reply_to_message?: TgMessage;
  photo?: (TgFile & { width: number; height: number })[];
  voice?: TgFile & { duration?: number };
  audio?: TgFile & { duration?: number };
  video_note?: TgFile & { duration?: number };
  migrate_to_chat_id?: number;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: { chat: TgChat; from: TgUser; new_chat_member: { status: string } };
}

export const TG_MAX_LEN = 4096;
/** Bot API refuses downloads above this size. */
export const TG_MAX_FILE = 20_000_000;

export class TgError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class Telegram {
  constructor(
    readonly token: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.f(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!data.ok) throw new TgError(data.error_code ?? res.status, data.description ?? `HTTP ${res.status}`);
    return data.result as T;
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const { file_path, file_size } = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!file_path || (file_size ?? 0) > TG_MAX_FILE) throw new TgError(400, 'file too large');
    const res = await this.f(`https://api.telegram.org/file/bot${this.token}/${file_path}`);
    if (!res.ok) throw new TgError(res.status, 'file download failed');
    return res.arrayBuffer();
  }

  /** Markdown as Telegram HTML, split under the length limit; plain text if Telegram rejects the markup. */
  async reply(to: TgMessage, markdown: string): Promise<void> {
    const base = { chat_id: to.chat.id, ...(to.message_thread_id && { message_thread_id: to.message_thread_id }) };
    let first = true;
    for (const part of splitText(markdown)) {
      const params = { ...base, ...(first && { reply_parameters: { message_id: to.message_id, allow_sending_without_reply: true } }) };
      first = false;
      try {
        await this.call('sendMessage', { ...params, text: markdownToTelegramHtml(part), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      } catch (e) {
        if (!(e instanceof TgError) || e.code !== 400) throw e;
        await this.call('sendMessage', { ...params, text: part });
      }
    }
  }

  async sendPhoto(to: TgMessage, jpeg: Uint8Array, caption: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', String(to.chat.id));
    if (to.message_thread_id) form.set('message_thread_id', String(to.message_thread_id));
    form.set('reply_parameters', JSON.stringify({ message_id: to.message_id, allow_sending_without_reply: true }));
    form.set('caption', caption.slice(0, 1024));
    form.set('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'image.jpg');
    const res = await this.f(`https://api.telegram.org/bot${this.token}/sendPhoto`, { method: 'POST', body: form });
    const data = (await res.json()) as { ok: boolean; description?: string; error_code?: number };
    if (!data.ok) throw new TgError(data.error_code ?? res.status, data.description ?? 'sendPhoto failed');
  }
}

// Telegram's limit is in UTF-16 code units, which is what String.length counts.
export function splitText(text: string, max = TG_MAX_LEN - 200): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    if (cut < max * 0.75) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (cut === max && code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunks keep String.fromCharCode under the engine's argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
