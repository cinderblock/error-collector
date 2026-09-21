/**
 * Node integration.
 *
 * Server-side reporters can hold the app secret, so this is where attestation is
 * worth turning on: pass `appSecret` to `init` and every report is signed, which
 * lets triage separate what provably came from your own services from what merely
 * arrived at a world-open endpoint.
 */

import type { Client } from './client.js';

export interface NodeOptions {
  captureUncaught?: boolean;
  captureRejections?: boolean;
  /**
   * Whether to let the process die after reporting an uncaught exception.
   *
   * Defaults to true, and should stay true. Node's own default is to exit, and a
   * process that keeps running after an uncaught exception is in an undefined
   * state — the reporter's job is to make sure the crash was recorded first, not
   * to paper over it.
   */
  exitOnUncaught?: boolean;
  /** How long to wait for the report to leave before exiting. */
  flushTimeoutMs?: number;
}

export function installNodeHandlers(client: Client, options: NodeOptions = {}): () => void {
  const { captureUncaught = true, captureRejections = true, exitOnUncaught = true, flushTimeoutMs = 2_000 } = options;

  const teardown: (() => void)[] = [];

  if (captureUncaught) {
    const onUncaught = (error: Error) => {
      void withTimeout(client.captureException(error, { level: 'fatal' }), flushTimeoutMs).then(() => {
        if (exitOnUncaught) {
          // 1, matching Node's own exit code for an uncaught exception, so
          // supervisors and CI see what they expect.
          process.exit(1);
        }
      });
    };
    process.on('uncaughtException', onUncaught);
    teardown.push(() => process.off('uncaughtException', onUncaught));
  }

  if (captureRejections) {
    const onRejection = (reason: unknown) => {
      void client.captureException(reason, { level: 'error', tags: { unhandled_rejection: 'true' } });
    };
    process.on('unhandledRejection', onRejection);
    teardown.push(() => process.off('unhandledRejection', onRejection));
  }

  return () => {
    for (const undo of teardown) undo();
  };
}

/** A hung report must not stop the process from exiting. */
function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms).unref?.())]);
}
