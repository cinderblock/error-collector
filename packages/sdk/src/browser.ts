/**
 * Browser integration: global handlers, automatic breadcrumbs, and screenshots.
 */

import type { Client } from './client.js';

export interface BrowserOptions {
  /** Capture `window.onerror`. */
  captureUnhandled?: boolean;
  /** Capture `unhandledrejection`. */
  capturePromises?: boolean;
  /** Record clicks and navigations as breadcrumbs. */
  breadcrumbs?: boolean;
  /** Record `console.error` / `console.warn` calls as breadcrumbs. */
  consoleBreadcrumbs?: boolean;
}

/** Returns a function that removes every listener it installed. */
export function installBrowserHandlers(client: Client, options: BrowserOptions = {}): () => void {
  const { captureUnhandled = true, capturePromises = true, breadcrumbs = true, consoleBreadcrumbs = true } = options;

  const teardown: (() => void)[] = [];

  if (captureUnhandled) {
    const onError = (event: ErrorEvent) => {
      // `event.error` is absent for cross-origin script errors, where the browser
      // gives only "Script error." — reporting the message alone is still worth
      // more than dropping it, since the count tells you it is happening.
      void client.captureException(event.error ?? event.message ?? 'Script error.', { level: 'error' });
    };
    globalThis.addEventListener('error', onError);
    teardown.push(() => globalThis.removeEventListener('error', onError));
  }

  if (capturePromises) {
    const onRejection = (event: PromiseRejectionEvent) => {
      void client.captureException(event.reason, { level: 'error', tags: { unhandled_rejection: 'true' } });
    };
    globalThis.addEventListener('unhandledrejection', onRejection);
    teardown.push(() => globalThis.removeEventListener('unhandledrejection', onRejection));
  }

  if (breadcrumbs) {
    const onClick = (event: Event) => {
      const target = event.target as Element | null;
      if (!target?.tagName) return;
      client.addBreadcrumb({ type: 'ui', category: 'click', message: describeElement(target) });
    };
    // Capture phase, so a click is recorded even if the handler that crashes calls
    // stopPropagation before it bubbles.
    globalThis.addEventListener('click', onClick, { capture: true, passive: true });
    teardown.push(() => globalThis.removeEventListener('click', onClick, { capture: true }));
  }

  if (consoleBreadcrumbs) {
    for (const level of ['error', 'warn'] as const) {
      const original = console[level];
      console[level] = (...args: unknown[]) => {
        client.addBreadcrumb({
          type: 'console',
          category: 'console',
          level: level === 'warn' ? 'warning' : 'error',
          message: args.map(stringify).join(' ').slice(0, 500),
        });
        original.apply(console, args);
      };
      teardown.push(() => {
        console[level] = original;
      });
    }
  }

  return () => {
    for (const undo of teardown) undo();
  };
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const classes =
    typeof element.className === 'string' && element.className
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
  const label = element.textContent?.trim().slice(0, 40);
  return `${element.tagName.toLowerCase()}${id}${classes}${label ? ` "${label}"` : ''}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export type ScreenshotMode = 'dom' | 'display';

export interface ScreenshotOptions {
  /**
   * `dom` renders the page from the DOM — no permission prompt, works everywhere,
   * but cannot see cross-origin iframes, `<canvas>` tainted by cross-origin
   * content, or anything the browser paints outside the document (native selects,
   * scrollbars). `display` asks the OS for the real pixels, which is exact but
   * requires a user gesture and shows a picker.
   */
  mode?: ScreenshotMode;
  /**
   * DOM renderer. The SDK deliberately bundles none — html2canvas and friends are
   * hundreds of kilobytes, which is not a cost to impose on every app for a
   * feature many never use. Pass your own, or load html2canvas on the page and
   * this falls back to the global.
   */
  renderer?: (element: HTMLElement) => Promise<HTMLCanvasElement>;
  element?: HTMLElement;
  type?: string;
  quality?: number;
}

/** Resolves to `null` rather than throwing — a missing screenshot must never cost the report. */
export async function captureScreenshot(options: ScreenshotOptions = {}): Promise<Blob | null> {
  try {
    return options.mode === 'display' ? await captureDisplay(options) : await captureDom(options);
  } catch {
    return null;
  }
}

async function captureDom(options: ScreenshotOptions): Promise<Blob | null> {
  const element = options.element ?? document.body;
  const renderer =
    options.renderer ??
    (globalThis as { html2canvas?: (element: HTMLElement) => Promise<HTMLCanvasElement> }).html2canvas;
  if (!renderer) return null;

  return canvasToBlob(await renderer(element), options);
}

async function captureDisplay(options: ScreenshotOptions): Promise<Blob | null> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    // One frame has to be decoded before the video reports real dimensions.
    await new Promise(resolve => requestAnimationFrame(resolve));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    return canvasToBlob(canvas, options);
  } finally {
    // Leaving the capture running would keep the browser's "sharing your screen"
    // indicator up indefinitely.
    for (const track of stream.getTracks()) track.stop();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, options: ScreenshotOptions): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, options.type ?? 'image/png', options.quality));
}
