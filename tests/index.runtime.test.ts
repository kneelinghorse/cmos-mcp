import { afterEach, beforeEach, describe, expect, test, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

type LoadedModule = Awaited<ReturnType<typeof loadIndexModule>>;

async function loadIndexModule() {
  jest.resetModules();

  const existingSigint = process.listeners('SIGINT');
  const existingSigterm = process.listeners('SIGTERM');

  const mockServer = {
    setRequestHandler: jest.fn(),
    setNotificationHandler: jest.fn(),
    connect: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  };
  const serverCtor = jest.fn(() => mockServer);

  const mockTransport = {};
  const transportCtor = jest.fn(() => mockTransport);

  jest.doMock('@modelcontextprotocol/sdk/server/index.js', () => ({
    Server: serverCtor,
  }));

  jest.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: transportCtor,
  }));

  const errorCode = {
    InternalError: 'internal_error',
    MethodNotFound: 'method_not_found',
  };

  class McpError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  jest.doMock('@modelcontextprotocol/sdk/types.js', () => ({
    ListToolsRequestSchema: { id: 'list' },
    CallToolRequestSchema: { id: 'call' },
    ErrorCode: errorCode,
    McpError,
  }));

  // s77-m03: the boot-time tokenizer preload was removed from initializeServer(),
  // so the #714/#721 cold-load flake (Sprint 70 m01 mocked it away) no longer
  // exists — startup never touches the tokenizer. The Claude tokenizer now loads
  // lazily on first count(), which these logging/wiring tests never trigger, so no
  // stub is needed.
  const indexModule = await import('../src/index');
  const { ErrorHandler } = await import('../src/errors/handler');
  const { MissionProtocolError } = await import('../src/errors/mission-error');

  // Sprint 70 m01: stub the real startup runners by default so initializeServer()
  // does ZERO real I/O. Left real, they open the shared-CMOS_CONFIG_DIR registry
  // SQLite (WAL-contended across the many parallel jest workers) and read the
  // credential store — under heavy concurrent load that blew the 5000ms test
  // timeout and its late-settling promises bled console output into sibling tests
  // (the #714/#721 flaky). Tests that assert a specific runner's behavior override
  // these AFTER loadIndexModule() returns; jest.resetModules() in afterEach drops
  // the singleton, so no reset is needed here.
  indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
    totalBefore: 0,
    pruned: 0,
    remaining: 0,
    error: null,
  }));
  indexModule.__test__.setStartupProjectKeyRecoveryRunner(async () => ({
    checked: false,
    status: 'skipped-no-project',
    message: 'test-stub: project key recovery skipped',
  }));
  indexModule.__test__.setStartupCredentialCheckRunner(async () => ({
    status: 'has-user-scoped-keys',
    warned: false,
    userScopedKeyCount: 0,
    dashboardConfigured: false,
  }));
  indexModule.__test__.setStartupBundledEnvCheckRunner(() => ({
    installedFromNpm: false,
    envFilePath: null,
    envFileBundled: false,
  }));

  const newSigint = process
    .listeners('SIGINT')
    .filter((listener) => !existingSigint.includes(listener));
  const newSigterm = process
    .listeners('SIGTERM')
    .filter((listener) => !existingSigterm.includes(listener));

  const cleanup = () => {
    for (const listener of newSigint) {
      process.removeListener('SIGINT', listener);
    }
    for (const listener of newSigterm) {
      process.removeListener('SIGTERM', listener);
    }
  };

  return {
    indexModule,
    mockServer,
    serverCtor,
    transportCtor,
    ErrorHandler,
    MissionProtocolError,
    newSigint,
    newSigterm,
    cleanup,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

const createMockContext = () =>
  ({
    defaultModel: 'claude',
    loader: {},
    registryParser: {} as any,
    packCombiner: {} as any,
    listDomainsTool: {} as any,
    createMissionTool: {} as any,
    combinePacksTool: {} as any,
    optimizeTokensTool: {} as any,
    splitMissionTool: {} as any,
    suggestSplitsTool: {} as any,
    tokenCounter: {} as any,
  }) as any;

describe('Mission Protocol entry lifecycle', () => {
  test('initializeServer logs initialization details and returns context', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));

    try {
      const result = await moduleData.indexModule.__test__.initializeServer();

      expect(result).toBe(context);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Initializing MCP server'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('CMOS schema version: 2.1'));
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Roots support: probed on first call')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sender attribution self-test: cwd -> /tmp/current-project')
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('initializeServer logs "pruned N stale entries" when startup prune finds drift', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));
    moduleData.indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
      totalBefore: 12,
      pruned: 7,
      remaining: 5,
      error: null,
    }));

    try {
      await moduleData.indexModule.__test__.initializeServer();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('pruned 7 stale entries from project registry')
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(5 remaining)'));
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetStartupRegistryPruneRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('initializeServer logs healthy state when startup prune finds nothing to remove', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));
    moduleData.indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
      totalBefore: 3,
      pruned: 0,
      remaining: 3,
      error: null,
    }));

    try {
      await moduleData.indexModule.__test__.initializeServer();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Project registry healthy: 3 entries, no stale entries pruned')
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetStartupRegistryPruneRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('initializeServer emits a soft WARN when registry prune errors but continues startup', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));
    moduleData.indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
      totalBefore: null,
      pruned: 0,
      remaining: null,
      error: 'registry file locked',
    }));

    try {
      const result = await moduleData.indexModule.__test__.initializeServer();
      expect(result).toBe(context);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Registry prune skipped: registry file locked')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('continuing startup with unpruned registry')
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetStartupRegistryPruneRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('initializeServer emits a P0 warning when attribution self-test flags install-root risk', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: null,
      source: null,
      errorCode: 'SENDER_UNRESOLVABLE',
      warning:
        'SERVER_INSTALL_ROOT would have been the implicit sender. Remediation: run from the client project or rely on advertised MCP roots.',
    }));

    try {
      await moduleData.indexModule.__test__.initializeServer();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sender attribution self-test: unresolved (SENDER_UNRESOLVABLE)')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[P0] Sender attribution self-test warning')
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SERVER_INSTALL_ROOT'));
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('initializeServer wraps failures with mission error', async () => {
    const moduleData = await loadIndexModule();
    const failure = new Error('registry unavailable');
    const wrapped = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'failed',
      context: { module: 'server' },
    });

    moduleData.indexModule.__test__.setContextBuilder(async () => {
      throw failure;
    });
    const handleSpy = jest.spyOn(moduleData.ErrorHandler, 'handle').mockReturnValue(wrapped);

    try {
      await expect(moduleData.indexModule.__test__.initializeServer()).rejects.toBe(wrapped);
      expect(handleSpy).toHaveBeenCalledWith(
        failure,
        'server.initialize',
        { module: 'server' },
        expect.objectContaining({ rethrow: false })
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetContextBuilder();
      handleSpy.mockRestore();
    }
  });

  test('registerToolHandlers registers list handler and sanitizes execution errors', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, ErrorHandler } = moduleData;

    const definitions = [{ name: 'demo_tool' }];
    const definitionsSpy = jest
      .spyOn(indexModule, 'getToolDefinitions')
      .mockReturnValue(definitions as any);

    const context = createMockContext();
    const executionError = new Error('boom');

    const execSpy = jest
      .spyOn(indexModule, 'executeMissionProtocolTool')
      .mockRejectedValue(executionError);

    const missionError = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'wrapped',
      context: { module: 'server' },
    });
    const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockReturnValue(missionError);
    const publicSpy = jest.spyOn(ErrorHandler, 'toPublicError').mockReturnValue({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'Tool execution failed',
      correlationId: 'cid-123',
      retryable: false,
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      indexModule.__test__.registerToolHandlers(context);

      expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);
      const listHandler = mockServer.setRequestHandler.mock.calls[0][1] as () => any;
      const listResponse = await listHandler();
      expect(Array.isArray(listResponse.tools)).toBe(true);
      expect(listResponse.tools.length).toBeGreaterThan(0);

      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<unknown>;
      await expect(
        callHandler({
          params: {
            name: 'dangerous_tool',
            arguments: Object.fromEntries(
              Array.from({ length: 12 }, (_, idx) => [`key${idx}`, idx])
            ),
          },
        })
      ).rejects.toMatchObject({
        code: 'internal_error',
        message: expect.stringContaining('correlationId=cid-123'),
      });

      expect(handleSpy).toHaveBeenCalledTimes(1);
      const [errorArg, operationArg, contextArg] = handleSpy.mock.calls[0];
      expect(errorArg).toBeInstanceOf(Error);
      expect((errorArg as Error).message).toContain('Unknown tool: dangerous_tool');
      expect(operationArg).toBe('server.execute_tool');
      expect(contextArg).toMatchObject({
        module: 'server',
        data: expect.objectContaining({
          tool: 'dangerous_tool',
          args: expect.objectContaining({ key0: 0 }),
        }),
      });
    } finally {
      moduleData.cleanup();
      definitionsSpy.mockRestore();
      consoleSpy.mockRestore();
      handleSpy.mockRestore();
      publicSpy.mockRestore();
      execSpy.mockRestore();
    }
  });

  test('registerToolHandlers omits sanitized args when input is not an object', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, ErrorHandler } = moduleData;
    const context = createMockContext();

    const executionError = new Error('explode');
    const missionError = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'wrapped',
      context: { module: 'server' },
    });

    const execSpy = jest
      .spyOn(indexModule, 'executeMissionProtocolTool')
      .mockRejectedValue(executionError);

    const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockReturnValue(missionError);
    const publicSpy = jest.spyOn(ErrorHandler, 'toPublicError').mockReturnValue({
      code: missionError.code,
      category: missionError.category,
      message: 'Tool execution failed',
      correlationId: undefined,
      retryable: false,
    });

    try {
      indexModule.__test__.registerToolHandlers(context);
      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<unknown>;

      await expect(
        callHandler({
          params: {
            name: 'string_args_tool',
            arguments: 'non-object arguments',
          },
        })
      ).rejects.toMatchObject({
        code: 'internal_error',
        message: expect.stringContaining('Tool execution failed'),
      });

      const [, , contextArg] = handleSpy.mock.calls[0];
      expect(contextArg).toBeDefined();
      expect(contextArg?.data).toEqual({ tool: 'string_args_tool' });
    } finally {
      moduleData.cleanup();
      execSpy.mockRestore();
      handleSpy.mockRestore();
      publicSpy.mockRestore();
    }
  });

  // Sprint 74 m03: a write-path handler that throws an unhandled (non-McpError)
  // exception must surface a structured CmosToolResult error (code+message+
  // suggestion) as an isError result — never a bare JSON-RPC -32603 that swallows
  // the real cause. Reported by aquex.ai (msg aa124685): forceComplete + capture
  // crashed with a bare -32603 'Tool execution failed' and no actionable detail.
  test('buildToolExecutionErrorResult wraps an unhandled exception as a structured isError result (not a throw)', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule } = moduleData;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = indexModule.buildToolExecutionErrorResult(
        'cmos_sprint',
        { action: 'complete', forceComplete: true },
        new Error('SQLITE_CONSTRAINT: stable_event_id is not unique')
      );

      // Returned, not thrown; flagged as an error result.
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      // Carries the machine code, the REAL underlying message, and a suggestion —
      // not the generic 'Tool execution failed' that toPublicError would substitute.
      expect(text).toContain('TOOL_EXECUTION_ERROR');
      expect(text).toContain('SQLITE_CONSTRAINT: stable_event_id is not unique');
      expect(text).toMatch(/Suggestion:/);

      const structured = result.structuredContent as {
        success: boolean;
        error: { code: string; message: string; suggestion: string };
      };
      expect(structured.success).toBe(false);
      expect(structured.error.code).toBe('TOOL_EXECUTION_ERROR');
      expect(structured.error.message).toContain('cmos_sprint');
      expect(structured.error.message).toContain('SQLITE_CONSTRAINT');
      expect(structured.error.suggestion.length).toBeGreaterThan(0);
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
    }
  });

  test.each(['cmos_sprint', 'cmos_session'])(
    'CallTool handler returns a structured isError result (no bare -32603) when the %s write handler throws',
    async (toolName) => {
      const moduleData = await loadIndexModule();
      const { indexModule, mockServer } = moduleData;
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Force the cross-module handler to throw a plain (non-McpError) exception,
      // simulating the aquex.ai store-specific write crash.
      const cmosBarrel = await import('../src/tools/cmos');
      const handlerName = toolName === 'cmos_sprint' ? 'cmosSprint' : 'cmosSession';
      const handlerSpy = jest
        .spyOn(cmosBarrel, handlerName as 'cmosSprint' | 'cmosSession')
        .mockRejectedValue(new Error('simulated store-specific write crash') as never);

      const context = createMockContext();
      try {
        indexModule.__test__.registerToolHandlers(context);
        const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
          request: any
        ) => Promise<any>;

        const request =
          toolName === 'cmos_sprint'
            ? {
                params: {
                  name: 'cmos_sprint',
                  arguments: {
                    action: 'complete',
                    sprintId: 'sprint-1',
                    forceComplete: true,
                    projectRoot: '/tmp/cmos-m03-wiring-test',
                  },
                },
              }
            : {
                params: {
                  name: 'cmos_session',
                  arguments: {
                    action: 'capture',
                    category: 'decision',
                    content: 'x',
                    projectRoot: '/tmp/cmos-m03-wiring-test',
                  },
                },
              };

        // Must RESOLVE to a structured error result, NOT reject with an McpError.
        const result = await callHandler(request);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('TOOL_EXECUTION_ERROR');
        expect(text).toContain('simulated store-specific write crash');
        expect(text).toMatch(/Suggestion:/);
      } finally {
        moduleData.cleanup();
        handlerSpy.mockRestore();
        consoleSpy.mockRestore();
      }
    }
  );

  test('registerToolHandlers reports when server context is missing', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, ErrorHandler } = moduleData;
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');

    try {
      indexModule.__test__.registerToolHandlers(null as unknown as any);
      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<unknown>;

      await expect(
        callHandler({ params: { name: 'cmos_project_list', arguments: {} } })
      ).rejects.toBeInstanceOf(Error);

      expect(handleSpy).toHaveBeenCalled();
      const [innerError] = handleSpy.mock.calls[0];
      expect(innerError).toBeInstanceOf(Error);
      expect((innerError as Error).message).toBe('Server context not initialized');
    } finally {
      moduleData.cleanup();
      handleSpy.mockRestore();
    }
  });

  test('main connects server and logs startup details', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, transportCtor } = moduleData;
    const context = createMockContext();
    indexModule.__test__.setContextBuilder(async () => context);
    indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await indexModule.__test__.main();

      expect(mockServer.setRequestHandler).toHaveBeenCalled();
      expect(mockServer.connect).toHaveBeenCalled();
      expect(transportCtor).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('cmos-mcp MCP server running on stdio')
      );
    } finally {
      moduleData.cleanup();
      indexModule.__test__.resetStartupAttributionSelfTestRunner();
      indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('main routes --whoami through the CLI runner and skips stdio startup', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, transportCtor } = moduleData;
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', originalArgv[1] ?? 'index.js', '--whoami'];

    const runner = jest.fn(async () => 0);
    indexModule.__test__.setWhoamiCliRunner(runner);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await indexModule.__test__.main();

      expect(runner).toHaveBeenCalledTimes(1);
      expect(mockServer.connect).not.toHaveBeenCalled();
      expect(transportCtor).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      moduleData.cleanup();
      indexModule.__test__.resetWhoamiCliRunner();
      consoleSpy.mockRestore();
    }
  });

  test('main exits non-zero when --whoami runner reports fail-closed', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule } = moduleData;
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', originalArgv[1] ?? 'index.js', '--whoami'];

    indexModule.__test__.setWhoamiCliRunner(async () => 1);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(indexModule.__test__.main()).rejects.toThrow('exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.argv = originalArgv;
      moduleData.cleanup();
      indexModule.__test__.resetWhoamiCliRunner();
      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  test('main handles startup failures via ErrorHandler and exits', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, ErrorHandler } = moduleData;
    const failure = new Error('init failure');

    const missionError = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'startup failed',
      context: { module: 'server' },
    });
    indexModule.__test__.setContextBuilder(async () => {
      throw failure;
    });

    const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockReturnValue(missionError);
    const publicSpy = jest.spyOn(ErrorHandler, 'toPublicError').mockReturnValue({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'Mission Protocol server startup failed.',
      correlationId: 'cid-xyz',
      retryable: false,
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await indexModule.__test__.main();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Server startup failed (correlationId=cid-xyz)')
      );
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
      indexModule.__test__.resetContextBuilder();
      handleSpy.mockRestore();
      publicSpy.mockRestore();
    }
  });

  test('SIGINT handler attempts graceful shutdown and exits', async () => {
    const moduleData = await loadIndexModule();
    const { mockServer, newSigint } = moduleData;

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const handler = newSigint[newSigint.length - 1];
      expect(handler).toBeDefined();
      await expect(handler?.({} as any)).rejects.toThrow('exit:0');
      expect(mockServer.close).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Received SIGINT, shutting down gracefully')
      );
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('SIGTERM handler attempts graceful shutdown and exits', async () => {
    const moduleData = await loadIndexModule();
    const { mockServer, newSigterm } = moduleData;

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const handler = newSigterm[newSigterm.length - 1];
      expect(handler).toBeDefined();
      await expect(handler?.({} as any)).rejects.toThrow('exit:0');
      expect(mockServer.close).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Received SIGTERM, shutting down gracefully')
      );
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('runStartupRegistryPrune (real implementation)', () => {
  const ENV_KEY = 'CMOS_CONFIG_DIR';
  let savedEnv: string | undefined;
  let configDir: string;

  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-prune-'));
    process.env[ENV_KEY] = configDir;
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    await fs.rm(configDir, { recursive: true, force: true });
  });

  test('drops entries whose cmos database is missing and reports counts', async () => {
    jest.resetModules();
    const { ProjectRegistry } = await import('../src/intelligence/project-registry');
    const indexModule = await import('../src/index');

    ProjectRegistry.resetInstance();
    const liveProject = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
    await fs.mkdir(path.join(liveProject, 'cmos', 'db'), { recursive: true });
    await fs.writeFile(path.join(liveProject, 'cmos', 'db', 'cmos.sqlite'), '');

    const registry = await ProjectRegistry.create();
    await registry.register(liveProject);

    const deadProject = await fs.mkdtemp(path.join(os.tmpdir(), 'dead-'));
    await fs.mkdir(path.join(deadProject, 'cmos', 'db'), { recursive: true });
    await fs.writeFile(path.join(deadProject, 'cmos', 'db', 'cmos.sqlite'), '');
    await registry.register(deadProject);
    await fs.rm(deadProject, { recursive: true, force: true });

    try {
      const result = await indexModule.__test__.runStartupRegistryPrune();
      expect(result.error).toBeNull();
      expect(result.totalBefore).toBe(2);
      expect(result.pruned).toBe(1);
      expect(result.remaining).toBe(1);
    } finally {
      await fs.rm(liveProject, { recursive: true, force: true });
      ProjectRegistry.resetInstance();
    }
  });

  test('reports zero pruned on a clean registry', async () => {
    jest.resetModules();
    const { ProjectRegistry } = await import('../src/intelligence/project-registry');
    const indexModule = await import('../src/index');

    ProjectRegistry.resetInstance();
    const liveProject = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
    await fs.mkdir(path.join(liveProject, 'cmos', 'db'), { recursive: true });
    await fs.writeFile(path.join(liveProject, 'cmos', 'db', 'cmos.sqlite'), '');

    const registry = await ProjectRegistry.create();
    await registry.register(liveProject);

    try {
      const result = await indexModule.__test__.runStartupRegistryPrune();
      expect(result.error).toBeNull();
      expect(result.pruned).toBe(0);
      expect(result.remaining).toBe(1);
    } finally {
      await fs.rm(liveProject, { recursive: true, force: true });
      ProjectRegistry.resetInstance();
    }
  });
});

describe('runStartupBundledEnvCheck (Sprint 62 m02)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-env-check-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test('reports installedFromNpm=false for a dev-tree path', async () => {
    const indexModule = await import('../src/index');
    // Use a tmpdir that does NOT contain a node_modules segment.
    const result = indexModule.__test__.runStartupBundledEnvCheck(tmpRoot);
    expect(result.installedFromNpm).toBe(false);
    expect(result.envFileBundled).toBe(false);
    expect(result.envFilePath).toBeNull();
  });

  test('reports envFileBundled=true when running from node_modules with a .env present', async () => {
    const indexModule = await import('../src/index');
    const fakeInstallRoot = path.join(tmpRoot, 'node_modules', '@aquex', 'cmos-mcp');
    await fs.mkdir(fakeInstallRoot, { recursive: true });
    await fs.writeFile(
      path.join(fakeInstallRoot, '.env'),
      'CMOS_DASHBOARD_API_KEY=cmk_should_never_have_shipped\n'
    );

    const result = indexModule.__test__.runStartupBundledEnvCheck(fakeInstallRoot);
    expect(result.installedFromNpm).toBe(true);
    expect(result.envFileBundled).toBe(true);
    expect(result.envFilePath).toBe(path.join(fakeInstallRoot, '.env'));
  });

  test('reports envFileBundled=false when running from node_modules without a .env', async () => {
    const indexModule = await import('../src/index');
    const fakeInstallRoot = path.join(tmpRoot, 'node_modules', '@aquex', 'cmos-mcp');
    await fs.mkdir(fakeInstallRoot, { recursive: true });
    // No .env created.

    const result = indexModule.__test__.runStartupBundledEnvCheck(fakeInstallRoot);
    expect(result.installedFromNpm).toBe(true);
    expect(result.envFileBundled).toBe(false);
    expect(result.envFilePath).toBe(path.join(fakeInstallRoot, '.env'));
  });

  test('never throws on a non-existent install root', async () => {
    const indexModule = await import('../src/index');
    const ghost = path.join(tmpRoot, 'node_modules', 'does-not-exist');
    expect(() => indexModule.__test__.runStartupBundledEnvCheck(ghost)).not.toThrow();
    const result = indexModule.__test__.runStartupBundledEnvCheck(ghost);
    expect(result.installedFromNpm).toBe(true);
    expect(result.envFileBundled).toBe(false);
  });
});
