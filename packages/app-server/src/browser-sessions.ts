import { randomUUID } from 'node:crypto';
import { parseBrowserLoginId, ServiceError } from '@weiguangchao/codexplus-shared';
import type { Auth, BrowserLoginId, BrowserStatus } from '@weiguangchao/codexplus-shared';
import { browserLogin } from './browser-login.js';

type BrowserState =
  | { status: 'pending' }
  | { status: 'complete'; auth: Auth }
  | { status: 'error'; error: string };

interface BrowserSession {
  controller: AbortController;
  state: BrowserState;
  url: string;
  manual: boolean;
  task: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserSessions {
  private readonly sessions = new Map<BrowserLoginId, BrowserSession>();

  constructor(private readonly login: typeof browserLogin = browserLogin) {}

  start(): { id: BrowserLoginId } {
    if (this.sessions.size > 0) throw new ServiceError({ status: 409, message: '已有浏览器登录正在进行，请完成或取消后重试。' });
    const id = parseBrowserLoginId(randomUUID());
    const controller = new AbortController();
    const session: BrowserSession = {
      controller, state: { status: 'pending' }, url: '', manual: false, task: Promise.resolve(),
      timer: setTimeout(() => { void this.cancel(id); }, 10 * 60_000),
    };
    session.timer.unref();
    this.sessions.set(id, session);
    session.task = this.login({
      signal: controller.signal,
      onUrl: (url) => { session.url = url; },
      onBrowserError: () => { session.manual = true; },
    }).then((auth) => {
      if (!controller.signal.aborted) session.state = { status: 'complete', auth };
    }, (error: unknown) => {
      session.state = { status: 'error', error: error instanceof Error ? error.message : '浏览器登录失败，请重新登录。' };
    });
    return { id };
  }

  private get(id: BrowserLoginId): BrowserSession {
    const session = this.sessions.get(id);
    if (!session) throw new ServiceError({ status: 404, message: '本次浏览器登录已结束，请重新登录。' });
    return session;
  }

  status(id: BrowserLoginId): BrowserStatus {
    const { state, url, manual } = this.get(id);
    switch (state.status) {
      case 'pending': return { status: 'pending', url, manual };
      case 'complete': return { status: 'complete', url, manual };
      case 'error': return { status: 'error', url, manual, error: state.error };
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  }

  auth(id: BrowserLoginId): Auth {
    const { state } = this.get(id);
    if (state.status !== 'complete') throw new ServiceError({ status: 409, message: '浏览器登录尚未完成。' });
    return state.auth;
  }

  async cancel(id: BrowserLoginId): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    session.controller.abort(new Error('已取消浏览器登录。'));
    try { await session.task; } finally { session.state = { status: 'pending' }; this.sessions.delete(id); }
  }

  async close(): Promise<void> { await Promise.all([...this.sessions.keys()].map((id) => this.cancel(id))); }
}
