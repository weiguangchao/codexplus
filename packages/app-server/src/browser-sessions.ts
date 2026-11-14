import { randomUUID } from 'node:crypto';
import { ServiceError } from '@weiguangchao/codexplus-shared';
import { browserLogin } from './browser-login.js';

interface BrowserSession {
  controller: AbortController;
  status: 'pending' | 'complete' | 'error';
  url: string;
  manual: boolean;
  auth?: string;
  error?: string;
  task: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserSessions {
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly login: typeof browserLogin = browserLogin) {}

  start(): { id: string } {
    if (this.sessions.size > 0) throw new ServiceError(409, '已有浏览器登录正在进行，请完成或取消后重试。');
    const id = randomUUID();
    const controller = new AbortController();
    const session: BrowserSession = {
      controller, status: 'pending', url: '', manual: false, task: Promise.resolve(),
      timer: setTimeout(() => { void this.cancel(id); }, 10 * 60_000),
    };
    session.timer.unref();
    this.sessions.set(id, session);
    session.task = this.login({
      signal: controller.signal,
      onUrl: (url) => { session.url = url; },
      onBrowserError: () => { session.manual = true; },
    }).then((auth) => {
      if (!controller.signal.aborted) { session.auth = auth; session.status = 'complete'; }
    }, (error: unknown) => {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : '浏览器登录失败，请重新登录。';
    });
    return { id };
  }

  private get(id: string): BrowserSession {
    const session = this.sessions.get(id);
    if (!session) throw new ServiceError(404, '本次浏览器登录已结束，请重新登录。');
    return session;
  }

  status(id: string) {
    const { status, url, manual, error } = this.get(id);
    return { status, url, manual, ...(error ? { error } : {}) };
  }

  auth(id: string): string {
    const session = this.get(id);
    if (session.status !== 'complete' || !session.auth) throw new ServiceError(409, '浏览器登录尚未完成。');
    return session.auth;
  }

  async cancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    session.controller.abort(new Error('已取消浏览器登录。'));
    try { await session.task; } finally { delete session.auth; this.sessions.delete(id); }
  }

  async close(): Promise<void> { await Promise.all([...this.sessions.keys()].map((id) => this.cancel(id))); }
}
