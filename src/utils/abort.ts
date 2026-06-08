/**
 * Abort utilities for cancelable async operations.
 */

export class OperationAbortedError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export class OperationTimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

function toAbortError(signal: AbortSignal, message?: string): Error {
  const fallback = message ?? 'Operation aborted';
  const reason = signal.reason;

  if (reason instanceof Error) {
    return reason;
  }

  if (typeof reason === 'string' && reason.trim().length > 0) {
    return new OperationAbortedError(reason);
  }

  if (reason && typeof reason === 'object' && 'message' in reason) {
    const reasonMessage = (reason as { message?: unknown }).message;
    if (typeof reasonMessage === 'string' && reasonMessage.trim().length > 0) {
      return new OperationAbortedError(reasonMessage);
    }
  }

  return new OperationAbortedError(fallback);
}

export function throwIfAborted(signal?: AbortSignal, message?: string): void {
  if (!signal || !signal.aborted) {
    return;
  }
  throw toAbortError(signal, message);
}

export function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  message?: string
): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(toAbortError(signal, message));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(toAbortError(signal, message));
    };

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    promise
      .then((value) => {
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createTimeoutController(
  timeoutMs: number,
  message?: string
): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timeoutMessage = message ?? `Operation timed out after ${timeoutMs}ms`;

  const timer = setTimeout(() => {
    controller.abort(new OperationTimeoutError(timeoutMessage));
  }, timeoutMs);

  const dispose = (): void => {
    clearTimeout(timer);
  };

  controller.signal.addEventListener('abort', dispose, { once: true });

  return {
    controller,
    dispose,
  };
}
