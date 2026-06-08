import { setImmediate as setImmediateCallback } from 'timers';

import {
  OperationAbortedError,
  OperationTimeoutError,
  createTimeoutController,
  throwIfAborted,
  withAbort,
} from '../../src/utils/abort';

describe('Abort utilities', () => {
  describe('throwIfAborted', () => {
    it('does nothing when signal is undefined or not aborted', () => {
      expect(() => throwIfAborted()).not.toThrow();

      const controller = new AbortController();
      expect(() => throwIfAborted(controller.signal)).not.toThrow();
    });

    it('rethrows original error reasons without wrapping', () => {
      const controller = new AbortController();
      const error = new Error('original');
      controller.abort(error);

      expect(() => throwIfAborted(controller.signal)).toThrow(error);
    });

    it('wraps string and object reasons into OperationAbortedError', () => {
      const withString = new AbortController();
      withString.abort(' please stop ');
      expect(() => throwIfAborted(withString.signal)).toThrow(
        new OperationAbortedError(' please stop ')
      );

      const withObject = new AbortController();
      withObject.abort({ message: 'object reason' });
      expect(() => throwIfAborted(withObject.signal)).toThrow(
        new OperationAbortedError('object reason')
      );
    });

    it('uses fallback message when reason is missing', () => {
      const fakeSignal = {
        aborted: true,
        reason: undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as AbortSignal;

      expect(() => throwIfAborted(fakeSignal, 'custom fallback')).toThrow(
        new OperationAbortedError('custom fallback')
      );
    });
  });

  describe('withAbort', () => {
    it('returns the original promise when no signal is provided', async () => {
      const result = await withAbort(Promise.resolve(42));
      expect(result).toBe(42);
    });

    it('rejects immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort('stop');

      await expect(withAbort(Promise.resolve(0), controller.signal)).rejects.toThrow(
        OperationAbortedError
      );
    });

    it('resolves when the wrapped promise fulfills before aborting', async () => {
      const controller = new AbortController();
      const result = await withAbort(Promise.resolve('ok'), controller.signal);
      expect(result).toBe('ok');
    });

    it('rejects when the signal aborts while the promise is pending', async () => {
      const controller = new AbortController();
      let resolveFn: ((value: string) => void) | undefined;
      const deferred = new Promise<string>((resolve) => {
        resolveFn = resolve;
      });

      const rejection = withAbort(deferred, controller.signal);
      controller.abort('during pending');
      resolveFn?.('late');

      await expect(rejection).rejects.toThrow(new OperationAbortedError('during pending'));
    });
  });

  describe('createTimeoutController', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('aborts with OperationTimeoutError when the timer fires', () => {
      const { controller } = createTimeoutController(1000);
      const onAbort = jest.fn();
      controller.signal.addEventListener('abort', onAbort);

      jest.advanceTimersByTime(1000);

      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBeInstanceOf(OperationTimeoutError);
      expect((controller.signal.reason as OperationTimeoutError).message).toBe(
        'Operation timed out after 1000ms'
      );
    });

    it('stops the timer when disposed before aborting', async () => {
      const { controller, dispose } = createTimeoutController(5, 'timeout');

      dispose();

      jest.advanceTimersByTime(10);
      expect(controller.signal.aborted).toBe(false);

      controller.abort();

      await new Promise((resolve) => setImmediateCallback(resolve));
      expect(controller.signal.reason).not.toBeInstanceOf(OperationTimeoutError);
    });
  });
});
