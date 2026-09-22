/**
 * The reporter.
 *
 * Two rules govern everything in this file:
 *
 * 1. **Never throw into the host application.** A crash reporter that crashes the
 *    app it is reporting on is worse than no reporter. Every public method is
 *    wrapped, and failures are swallowed (surfaced only when `debug` is on).
 * 2. **Never report itself.** A transport failure that gets captured as an error
 *    produces another transport failure, and so on. A re-entrancy guard makes that
 *    impossible rather than unlikely.
 */

import {
  MAX_EVENTS_PER_REQUEST,
  signReport,
  type Breadcrumb,
  type Level,
  type ReportPayload,
  type ReportUser,
  type UsageEvent,
} from '@cinderblock/telemetry-collector-core';
import { exceptionChain, parseStack } from './stack.js';

export interface InitOptions {
  /**
   * Base URL of **your** telemetry-collector deployment, e.g.
   * `https://errors.example.com`.
   *
   * Deliberately required, with no default. This is self-hosted software: there is
   * no canonical server, and a default would mean an app that forgot to configure
   * one silently shipped its users' crashes to whoever happens to own that
   * hostname. Failing at `init` is the only safe behaviour.
   */
  endpoint: string;
  /** The public `ek1.…` key. Safe to commit and to ship in a client bundle. */
  ingestKey: string;
  release?: string;
  environment?: string;
  /**
   * Server-side, CLI and CI reporters only. Enables signed reports, which are
   * stored as attested. **Never set this in anything that runs in a browser** — it
   * would publish the secret that mints every ingest key for the app.
   */
  appSecret?: string;
  tags?: Record<string, string>;
  user?: ReportUser;
  maxBreadcrumbs?: number;
  /** Return `null` to drop an event, or a modified copy to scrub it. */
  beforeSend?: (payload: ReportPayload) => ReportPayload | null;
  /**
   * How long to hold usage events before sending them as a batch. A session emits
   * many; one request each would waste the rate limit and the battery. Set to 0 to
   * send each immediately, which is mainly useful in tests.
   */
  usageFlushMs?: number;
  debug?: boolean;
}

export interface CaptureOptions {
  level?: Level;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: ReportUser;
  fingerprint?: string[];
}

const DEFAULT_MAX_BREADCRUMBS = 50;
const DEFAULT_USAGE_FLUSH_MS = 5_000;

export class Client {
  readonly options: InitOptions;

  private breadcrumbs: Breadcrumb[] = [];
  private user: ReportUser | undefined;
  private tags: Record<string, string>;
  private sending = false;
  private usageQueue: UsageEvent[] = [];
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private unloadHooked = false;
  private retired = false;

  constructor(options: InitOptions) {
    if (!options.endpoint?.trim()) {
      throw new Error('telemetry-collector: `endpoint` is required — the URL of your own deployment');
    }
    if (!options.ingestKey?.trim()) {
      throw new Error('telemetry-collector: `ingestKey` is required');
    }
    this.options = options;
    this.user = options.user;
    this.tags = { ...options.tags };
  }

  get endpoint(): string {
    return this.options.endpoint.replace(/\/+$/, '');
  }

  get url(): string {
    return `${this.endpoint}/i/${this.options.ingestKey}`;
  }

  get usageUrl(): string {
    return `${this.endpoint}/u/${this.options.ingestKey}`;
  }

  /**
   * True once the backend has answered `410 Gone` — this version's channel has been
   * retired and is no longer collected.
   *
   * The client then stops sending for the rest of the session. That is the whole
   * point of the server answering 410 rather than 404 or 429: it is the one status a
   * client can act on correctly. Without this, a retired version in the field keeps
   * hammering an endpoint that will never accept it again, which costs the user
   * battery and the backend its rate limit.
   *
   * Deliberately not persisted. A fresh session asks again, so un-retiring a channel
   * brings clients back without them needing to clear anything.
   */
  get isRetired(): boolean {
    return this.retired;
  }

  setUser(user: ReportUser | undefined): void {
    this.user = user;
  }

  setTags(tags: Record<string, string>): void {
    this.tags = { ...this.tags, ...tags };
  }

  addBreadcrumb(crumb: Breadcrumb): void {
    this.breadcrumbs.push({ timestamp: Math.floor(Date.now() / 1000), ...crumb });
    const max = this.options.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    if (this.breadcrumbs.length > max) this.breadcrumbs = this.breadcrumbs.slice(-max);
  }

  captureException(error: unknown, options: CaptureOptions = {}): Promise<void> {
    const chain = exceptionChain(error);
    return this.send(
      {
        kind: 'error',
        level: options.level ?? 'error',
        exception: chain.map(entry => ({
          type: entry.type,
          value: entry.value,
          ...(entry.stack ? { stacktrace: { frames: parseStack(entry.stack) } } : {}),
        })),
      },
      options,
    );
  }

  captureMessage(message: string, level: Level = 'info', options: CaptureOptions = {}): Promise<void> {
    return this.send({ kind: 'message', level, message }, options);
  }

  /**
   * User-submitted feedback. Never coalesced with anything else server-side — two
   * people reporting the same annoyance are two things to read.
   */
  sendFeedback(feedback: { message: string; screenshot?: Blob; user?: ReportUser; url?: string }): Promise<void> {
    return this.send(
      { kind: 'feedback', level: 'info', message: feedback.message, url: feedback.url },
      { user: feedback.user },
      feedback.screenshot,
    );
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /**
   * Records a usage event. Queued and sent as a batch.
   *
   * Never awaits and never throws — usage is the least important thing this library
   * does, and it must not be able to slow down or break the app it is measuring.
   */
  track(event: string, options: { value?: number; dims?: Record<string, string> } = {}): void {
    if (this.retired) return;
    try {
      this.usageQueue.push({ event, value: options.value, dims: options.dims });

      // Send early rather than drop when a burst fills the batch.
      if (this.usageQueue.length >= MAX_EVENTS_PER_REQUEST) {
        void this.flushUsage();
        return;
      }

      const wait = this.options.usageFlushMs ?? DEFAULT_USAGE_FLUSH_MS;
      if (wait <= 0) {
        void this.flushUsage();
        return;
      }

      this.hookUnload();
      this.usageTimer ??= setTimeout(() => {
        this.usageTimer = undefined;
        void this.flushUsage();
      }, wait);
      // Do not hold a Node process open just to report a pageview.
      (this.usageTimer as { unref?: () => void }).unref?.();
    } catch (error) {
      if (this.options.debug) console.error('[telemetry-collector] track failed:', error);
    }
  }

  /** Sends anything queued. Safe to call at any time, including when empty. */
  async flushUsage(): Promise<void> {
    if (this.retired) {
      this.usageQueue.length = 0;
      return;
    }
    if (this.usageTimer !== undefined) {
      clearTimeout(this.usageTimer);
      this.usageTimer = undefined;
    }

    const events = this.usageQueue.splice(0, this.usageQueue.length);
    if (events.length === 0) return;

    try {
      const body = JSON.stringify({
        events,
        release: this.options.release,
        environment: this.options.environment,
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };

      if (this.options.appSecret) {
        const timestamp = Math.floor(Date.now() / 1000);
        headers['x-report-signature'] = await signReport(this.options.appSecret, timestamp, body);
        headers['x-report-timestamp'] = String(timestamp);
      }

      this.noteStatus(await fetch(this.usageUrl, { method: 'POST', headers, body, keepalive: body.length < 60_000 }));
    } catch (error) {
      // Deliberately not requeued. A retry loop against a failing endpoint would
      // grow unboundedly in memory and hammer a backend that is already unwell, to
      // recover data whose entire value is being approximately right in aggregate.
      if (this.options.debug) console.error('[telemetry-collector] usage flush failed:', error);
    }
  }

  /** Flush queued usage when the page goes away — which is when it usually does. */
  private hookUnload(): void {
    if (this.unloadHooked) return;
    if (typeof globalThis.addEventListener !== 'function' || typeof document === 'undefined') return;

    this.unloadHooked = true;
    // `pagehide`, not `unload`: `unload` is unreliable and blocks the bfcache, and
    // `visibilitychange` to hidden is the only signal some mobile browsers give at all.
    const flush = () => void this.flushUsage();
    globalThis.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  private base(): ReportPayload {
    const payload: ReportPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      tags: { ...this.tags },
    };
    if (this.options.release) payload.release = this.options.release;
    if (this.options.environment) payload.environment = this.options.environment;
    if (this.breadcrumbs.length > 0) payload.breadcrumbs = [...this.breadcrumbs];
    if (this.user) payload.user = this.user;
    payload.sdk = { name: 'telemetry-collector-js', version: SDK_VERSION };
    return payload;
  }

  private async send(partial: ReportPayload, options: CaptureOptions, screenshot?: Blob): Promise<void> {
    // Re-entrancy guard: a failure inside the transport must not be captured,
    // which would fail again, and again.
    if (this.sending) return;

    try {
      this.sending = true;

      let payload: ReportPayload = {
        ...this.base(),
        ...partial,
        tags: { ...this.tags, ...options.tags },
      };
      if (options.extra) payload.extra = options.extra;
      if (options.user) payload.user = options.user;
      if (options.fingerprint) payload.fingerprint = options.fingerprint;
      if (typeof globalThis.location?.href === 'string') payload.url ??= globalThis.location.href;

      if (this.options.beforeSend) {
        const filtered = this.options.beforeSend(payload);
        if (!filtered) return;
        payload = filtered;
      }

      await this.transport(payload, screenshot);
    } catch (error) {
      if (this.options.debug) console.error('[telemetry-collector] failed to report:', error);
    } finally {
      this.sending = false;
    }
  }

  private async transport(payload: ReportPayload, screenshot?: Blob): Promise<void> {
    if (this.retired) return;

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {};

    // Attestation is only possible where the app secret can legitimately live.
    if (this.options.appSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      headers['x-report-signature'] = await signReport(this.options.appSecret, timestamp, body);
      headers['x-report-timestamp'] = String(timestamp);
    }

    if (screenshot) {
      const form = new FormData();
      form.set('report', body);
      form.set('screenshot', screenshot, 'screenshot.png');
      this.noteStatus(await fetch(this.url, { method: 'POST', body: form, headers, keepalive: false }));
      return;
    }

    this.noteStatus(
      await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        // Lets an in-flight report survive the page unloading, which is exactly when
        // the most interesting crashes happen.
        keepalive: body.length < 60_000,
      }),
    );
  }

  /** Stands down permanently on 410, and only on 410. */
  private noteStatus(response: { status: number } | undefined): void {
    if (response?.status !== 410) return;

    this.retired = true;
    this.usageQueue.length = 0;
    if (this.usageTimer !== undefined) {
      clearTimeout(this.usageTimer);
      this.usageTimer = undefined;
    }
    if (this.options.debug) {
      console.info('[telemetry-collector] this version has been retired; no further reports will be sent');
    }
  }
}

export const SDK_VERSION = '0.0.0';

let current: Client | undefined;

export function init(options: InitOptions): Client {
  current = new Client(options);
  return current;
}

/** Undefined until `init` — every helper below no-ops rather than throwing. */
export function getClient(): Client | undefined {
  return current;
}

export function captureException(error: unknown, options?: CaptureOptions): Promise<void> {
  return current?.captureException(error, options) ?? Promise.resolve();
}

export function captureMessage(message: string, level?: Level, options?: CaptureOptions): Promise<void> {
  return current?.captureMessage(message, level, options) ?? Promise.resolve();
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  current?.addBreadcrumb(crumb);
}

export function sendFeedback(feedback: {
  message: string;
  screenshot?: Blob;
  user?: ReportUser;
  url?: string;
}): Promise<void> {
  return current?.sendFeedback(feedback) ?? Promise.resolve();
}

export function setUser(user: ReportUser | undefined): void {
  current?.setUser(user);
}

export function setTags(tags: Record<string, string>): void {
  current?.setTags(tags);
}

export function track(event: string, options?: { value?: number; dims?: Record<string, string> }): void {
  current?.track(event, options);
}

export function flushUsage(): Promise<void> {
  return current?.flushUsage() ?? Promise.resolve();
}

/** True once the backend has reported this version's channel as retired. */
export function isRetired(): boolean {
  return current?.isRetired ?? false;
}
