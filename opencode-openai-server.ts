import express, { Request, Response } from 'express';
import { OpenCodeClient } from './opencode-client';

// ==================== 类型定义 ====================

interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | any[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

interface StreamOptions {
  include_usage?: boolean;
}

interface ResponseFormat {
  type?: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    schema?: Record<string, any>;
    strict?: boolean;
  };
}

interface Logprobs {
  content: Array<{
    token: string;
    logprob: number;
    bytes: number[] | null;
    top_logprobs: Array<{
      token: string;
      logprob: number;
      bytes: number[] | null;
    }> | null;
  }> | null;
  refusal: Array<{
    token: string;
    logprob: number;
    bytes: number[] | null;
    top_logprobs: Array<{
      token: string;
      logprob: number;
      bytes: number[] | null;
    }> | null;
  }> | null;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  stream_options?: StreamOptions;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  n?: number;
  stop?: string | string[];
  response_format?: ResponseFormat;
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  system_fingerprint: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string | null;
      refusal?: string | null;
      tool_calls?: ToolCall[];
    };
    logprobs: Logprobs | null;
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  system_fingerprint: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      reasoning_content?: string | null;
      refusal?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    logprobs: Logprobs | null;
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

interface Model {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

interface ModelsResponse {
  object: 'list';
  data: Model[];
}

interface CompletionRequest {
  model: string;
  prompt: string | string[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

interface CompletionResponse {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: 'stop' | 'length' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface CompletionChunk {
  id: string;
  object: 'text_completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: 'stop' | 'length' | 'content_filter' | null;
  }>;
}

interface OpenAIServerOptions {
  port?: number;
  hostname?: string;
  corsOrigins?: string[];
  cliPath?: string;
  opencodePort?: number;
  username?: string;
  password?: string;
}

const TOOL_CALL_OPEN_TAG = '\u276Etool_call\u276F';
const TOOL_CALL_CLOSE_TAG = '\u276E/tool_call\u276F';

// ==================== 服务器 ====================

export class OpenAIServer {
  private app: express.Application;
  private server: any;
  private port: number;
  private hostname: string;
  private openCodeClient: OpenCodeClient;

  constructor(options: OpenAIServerOptions = {}) {
    this.port = options.port || 4094;
    this.hostname = options.hostname || '127.0.0.1';
    this.app = express();
    this.openCodeClient = new OpenCodeClient({
      cliPath: options.cliPath,
      opencodePort: options.opencodePort,
      username: options.username,
      password: options.password,
    });
    this.setupMiddleware(options.corsOrigins || []);
    this.setupRoutes();
  }

  private setupMiddleware(corsOrigins: string[]): void {
    this.app.use(express.json({ limit: '10mb' }));

    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && corsOrigins.length > 0) {
        if (corsOrigins.includes(origin) || corsOrigins.includes('*')) {
          res.header('Access-Control-Allow-Origin', origin);
        }
      } else {
        res.header('Access-Control-Allow-Origin', '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        if (!req.path.startsWith('/health')) {
          console.log(`[API] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
        }
      });
      next();
    });
  }

  private setupRoutes(): void {
    this.app.get('/v1/models', this.listModels.bind(this));
    this.app.get('/v1/models/:model', this.getModel.bind(this));
    this.app.post('/v1/chat/completions', this.chatCompletions.bind(this));
    this.app.post('/v1/completions', this.completions.bind(this));

    this.app.get('/health', this.healthCheck.bind(this));

    this.app.get('/opencode/health', this.openCodeHealth.bind(this));
    this.app.get('/opencode/agents', this.listAgents.bind(this));
    this.app.get('/opencode/config', this.getConfig.bind(this));
  }

  // ==================== 健康检查 ====================

  private async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const isRunning = await this.openCodeClient.isServiceRunning();
      res.json({
        status: isRunning ? 'ok' : 'degraded',
        service: 'OpenAI-compatible OpenCode API',
        opencode: isRunning ? 'connected' : 'disconnected',
        opencodeUrl: this.openCodeClient.getBaseUrl(),
      });
    } catch {
      res.json({
        status: 'degraded',
        service: 'OpenAI-compatible OpenCode API',
        opencode: 'unknown',
      });
    }
  }

  private async openCodeHealth(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.openCodeClient.getHealth();
      res.json(health);
    } catch (error: any) {
      res.status(502).json({ error: { message: `OpenCode \u540E\u7AEF\u4E0D\u53EF\u7528: ${error.message}` } });
    }
  }

  // ==================== 模型列表 ====================

  private async listModels(req: Request, res: Response): Promise<void> {
    try {
      const models = await this.openCodeClient.listModels();
      const response: ModelsResponse = {
        object: 'list',
        data: models.map(modelId => ({
          id: modelId,
          object: 'model' as const,
          created: Date.now(),
          owned_by: 'opencode',
        })),
      };
      res.json(response);
    } catch (error: any) {
      console.error('[OpenAI Server] \u83B7\u53D6\u6A21\u578B\u5217\u8868\u5931\u8D25:', error.message);
      res.status(500).json({
        error: { message: `Failed to list models: ${error.message}`, type: 'server_error', code: 'internal_error' },
      });
    }
  }

  private async getModel(req: Request, res: Response): Promise<void> {
    try {
      const { model } = req.params;
      const models = await this.openCodeClient.listModels();
      const found = models.find(m => m === model);

      if (found) {
        res.json({ id: model, object: 'model', created: Date.now(), owned_by: 'opencode' });
      } else {
        res.status(404).json({
          error: { message: `Model '${model}' not found`, type: 'invalid_request_error', code: 'model_not_found' },
        });
      }
    } catch (error: any) {
      res.status(500).json({
        error: { message: `Failed to get model: ${error.message}`, type: 'server_error', code: 'internal_error' },
      });
    }
  }

  // ==================== Chat Completions ====================

  private async chatCompletions(req: Request, res: Response): Promise<void> {
    const {
      model, messages, stream = false, tools, tool_choice,
      n = 1, stop, response_format, seed, logprobs: requestLogprobs,
      top_logprobs, stream_options, max_completion_tokens,
    } = req.body as ChatCompletionRequest;

    if (!model || !messages || !Array.isArray(messages)) {
      res.status(400).json({
        error: { message: 'Missing required fields: model, messages', type: 'invalid_request_error', code: 'invalid_parameter' },
      });
      return;
    }

    const systemFingerprint = `fp_${this.hashString(model + Date.now()).substr(0, 12)}`;

    if (tool_choice === 'none') {
      const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const created = Math.floor(Date.now() / 1000);
      const response: ChatCompletionResponse = {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        system_fingerprint: systemFingerprint,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          logprobs: null,
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      res.json(response);
      return;
    }

    const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const created = Math.floor(Date.now() / 1000);

    let processedMessages = this.prepareMessagesWithTools(messages, tools, tool_choice);

    if (response_format && (response_format.type === 'json_object' || response_format.type === 'json_schema')) {
      const jsonInstruction = response_format.type === 'json_schema' && response_format.json_schema
        ? `You must respond with a JSON object that conforms to the following schema:\n${JSON.stringify(response_format.json_schema.schema || {}, null, 2)}`
        : 'You must respond with a valid JSON object. Do not include any text outside the JSON object.';
      const existingSystem = processedMessages.find(m => m.role === 'system');
      if (existingSystem) {
        const systemContent = typeof existingSystem.content === 'string'
          ? existingSystem.content
          : this.extractTextFromContent(existingSystem.content);
        processedMessages = processedMessages.map(m =>
          m.role === 'system' ? { ...m, content: `${systemContent}\n\n${jsonInstruction}` } : m
        );
      } else {
        processedMessages = [{ role: 'system', content: jsonInstruction }, ...processedMessages];
      }
    }

    try {
      if (stream) {
        await this.streamChatCompletion(
          req, res, completionId, created, model, processedMessages, tools,
          stream_options?.include_usage, systemFingerprint,
        );
      } else {
        const result = await this.openCodeClient.chat(processedMessages, { model });

        const parsedToolCalls = tools ? this.parseToolCallsFromResponse(result.content) : null;

        const numChoices = Math.min(n, 1);

        if (parsedToolCalls && parsedToolCalls.length > 0) {
          const response: ChatCompletionResponse = {
            id: completionId,
            object: 'chat.completion',
            created,
            model,
            system_fingerprint: systemFingerprint,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                reasoning_content: result.reasoning || null,
                tool_calls: parsedToolCalls,
              },
              logprobs: null,
              finish_reason: 'tool_calls',
            }],
            usage: {
              prompt_tokens: this.estimateTokens(processedMessages),
              completion_tokens: this.estimateTokens([{ role: 'assistant', content: result.content }]),
              total_tokens: this.estimateTokens([...processedMessages, { role: 'assistant', content: result.content }]),
              completion_tokens_details: {
                reasoning_tokens: result.reasoning ? this.estimateTokens([{ role: 'assistant', content: result.reasoning }]) : 0,
              },
            },
          };
          res.json(response);
        } else {
          const response: ChatCompletionResponse = {
            id: completionId,
            object: 'chat.completion',
            created,
            model,
            system_fingerprint: systemFingerprint,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: result.content,
                reasoning_content: result.reasoning || null,
              },
              logprobs: null,
              finish_reason: 'stop',
            }],
            usage: {
              prompt_tokens: this.estimateTokens(processedMessages),
              completion_tokens: this.estimateTokens([{ role: 'assistant', content: result.content }]),
              total_tokens: this.estimateTokens([...processedMessages, { role: 'assistant', content: result.content }]),
              completion_tokens_details: {
                reasoning_tokens: result.reasoning ? this.estimateTokens([{ role: 'assistant', content: result.reasoning }]) : 0,
              },
            },
          };
          res.json(response);
        }
      }
    } catch (error: any) {
      console.error('[OpenAI Server] Chat completion \u5931\u8D25:', error.message);
      if (!res.headersSent) {
        const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
        res.status(isTimeout ? 504 : 500).json({
          error: {
            message: isTimeout
              ? 'Model response timed out. The model may be overloaded or the request too complex.'
              : `Chat completion failed: ${error.message}`,
            type: isTimeout ? 'timeout_error' : 'server_error',
            code: isTimeout ? 'timeout' : 'internal_error',
          },
        });
      }
    }
  }

  private async streamChatCompletion(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    includeUsage?: boolean,
    systemFingerprint?: string,
  ): Promise<void> {
    if (tools && tools.length > 0) {
      await this.streamChatWithToolSupport(req, res, completionId, created, model, messages, tools, includeUsage, systemFingerprint);
    } else {
      try {
        await this.streamChatViaSSE(req, res, completionId, created, model, messages, undefined, includeUsage, systemFingerprint);
      } catch (sseError: any) {
        console.warn('[OpenAI Server] SSE \u6D41\u5F0F\u5931\u8D25\uFF0C\u56DE\u9000\u5230\u4F2A\u6D41\u5F0F:', sseError.message);
        if (!res.headersSent) {
          await this.streamChatFallback(req, res, completionId, created, model, messages, undefined, includeUsage, systemFingerprint);
        }
      }
    }
  }

  private async streamChatViaSSE(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    includeUsage?: boolean,
    systemFingerprint?: string,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const fp = systemFingerprint || `fp_${this.hashString(model).substr(0, 12)}`;

    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      system_fingerprint: fp,
      choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    let fullText = '';

    const onChunk = (delta: string) => {
      fullText += delta;
      const chunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: fp,
        choices: [{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    const onReasoning = (delta: string) => {
      const chunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: fp,
        choices: [{ index: 0, delta: { reasoning_content: delta }, logprobs: null, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    await this.openCodeClient.chatStream(messages, onChunk, { model }, onReasoning);

    const finalChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      system_fingerprint: fp,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
      ...(includeUsage ? {
        usage: {
          prompt_tokens: this.estimateTokens(messages),
          completion_tokens: this.estimateTokens([{ role: 'assistant', content: fullText }]),
          total_tokens: this.estimateTokens([...messages, { role: 'assistant', content: fullText }]),
        },
      } : {}),
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);

    res.write('data: [DONE]\n\n');
    res.end();
  }

  private async streamChatWithToolSupport(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    includeUsage?: boolean,
    systemFingerprint?: string,
  ): Promise<void> {
    const fp = systemFingerprint || `fp_${this.hashString(model).substr(0, 12)}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      system_fingerprint: fp,
      choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    const keepAliveInterval = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 5000);

    let fullText = '';
    let fullReasoning = '';

    const onChunk = (delta: string) => {
      fullText += delta;
    };

    const onReasoning = (delta: string) => {
      fullReasoning += delta;
    };

    try {
      await this.openCodeClient.chatStream(messages, onChunk, { model }, onReasoning);
    } finally {
      clearInterval(keepAliveInterval);
    }

    const parsedToolCalls = this.parseToolCallsFromResponse(fullText);

    if (parsedToolCalls && parsedToolCalls.length > 0) {
      for (let i = 0; i < parsedToolCalls.length; i++) {
        const tc = parsedToolCalls[i];
        const tcChunk: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          system_fingerprint: fp,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.function.name, arguments: tc.function.arguments },
              }],
            },
            logprobs: null,
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
      }
      const finalChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: fp,
        choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'tool_calls' }],
        ...(includeUsage ? {
          usage: {
            prompt_tokens: this.estimateTokens(messages),
            completion_tokens: this.estimateTokens([{ role: 'assistant', content: fullText }]),
            total_tokens: this.estimateTokens([...messages, { role: 'assistant', content: fullText }]),
          },
        } : {}),
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    } else {
      if (fullReasoning) {
        const reasoningChunks = this.splitIntoChunks(fullReasoning, 10);
        for (const chunk of reasoningChunks) {
          const data: ChatCompletionChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            system_fingerprint: fp,
            choices: [{ index: 0, delta: { reasoning_content: chunk }, logprobs: null, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      }
      const chunks = this.splitIntoChunks(fullText, 10);
      for (const chunk of chunks) {
        const data: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          system_fingerprint: fp,
          choices: [{ index: 0, delta: { content: chunk }, logprobs: null, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
      const finalChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: fp,
        choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
        ...(includeUsage ? {
          usage: {
            prompt_tokens: this.estimateTokens(messages),
            completion_tokens: this.estimateTokens([{ role: 'assistant', content: fullText }]),
            total_tokens: this.estimateTokens([...messages, { role: 'assistant', content: fullText }]),
          },
        } : {}),
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  }

  private async streamChatFallback(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    includeUsage?: boolean,
    systemFingerprint?: string,
  ): Promise<void> {
    const result = await this.openCodeClient.chat(messages, { model });

    const fp = systemFingerprint || `fp_${this.hashString(model).substr(0, 12)}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      system_fingerprint: fp,
      choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    if (result.reasoning) {
      const reasoningChunks = this.splitIntoChunks(result.reasoning, 10);
      for (const chunk of reasoningChunks) {
        const data: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          system_fingerprint: fp,
          choices: [{ index: 0, delta: { reasoning_content: chunk }, logprobs: null, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        await this.delay(30);
      }
    }

    const chunks = this.splitIntoChunks(result.content, 10);
    for (const chunk of chunks) {
      const data: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: fp,
        choices: [{ index: 0, delta: { content: chunk }, logprobs: null, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      await this.delay(30);
    }

    const finalChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      system_fingerprint: fp,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
      ...(includeUsage ? {
        usage: {
          prompt_tokens: this.estimateTokens(messages),
          completion_tokens: this.estimateTokens([{ role: 'assistant', content: result.content }]),
          total_tokens: this.estimateTokens([...messages, { role: 'assistant', content: result.content }]),
        },
      } : {}),
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);

    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ==================== Completions ====================

  private async completions(req: Request, res: Response): Promise<void> {
    const { model, prompt, stream = false } = req.body as CompletionRequest;

    if (!model || !prompt) {
      res.status(400).json({
        error: { message: 'Missing required fields: model, prompt', type: 'invalid_request_error', code: 'invalid_parameter' },
      });
      return;
    }

    const completionId = `cmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      const messages: ChatMessage[] = Array.isArray(prompt)
        ? prompt.map(p => ({ role: 'user' as const, content: p }))
        : [{ role: 'user' as const, content: prompt }];

      if (stream) {
        await this.streamCompletion(req, res, completionId, created, model, messages);
      } else {
        const result = await this.openCodeClient.chat(messages, { model });

        const response: CompletionResponse = {
          id: completionId,
          object: 'text_completion',
          created,
          model,
          choices: [{ index: 0, text: result.content, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: this.estimateTokens(messages),
            completion_tokens: this.estimateTokens([{ role: 'assistant', content: result.content }]),
            total_tokens: this.estimateTokens([...messages, { role: 'assistant', content: result.content }]),
          },
        };
        res.json(response);
      }
    } catch (error: any) {
      console.error('[OpenAI Server] Completion \u5931\u8D25:', error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: `Completion failed: ${error.message}`, type: 'server_error', code: 'internal_error' },
        });
      }
    }
  }

  private async streamCompletion(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
  ): Promise<void> {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      await this.openCodeClient.chatStream(messages, (delta) => {
        const chunk: CompletionChunk = {
          id: completionId,
          object: 'text_completion.chunk',
          created,
          model,
          choices: [{ index: 0, text: delta, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }, { model });

      const finalChunk: CompletionChunk = {
        id: completionId,
        object: 'text_completion.chunk',
        created,
        model,
        choices: [{ index: 0, text: '', finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (sseError: any) {
      if (!res.headersSent) {
        console.warn('[OpenAI Server] \u6D41\u5F0F Completion \u5931\u8D25\uFF0C\u56DE\u9000\u5230\u4F2A\u6D41\u5F0F:', sseError.message);
        await this.streamCompletionFallback(req, res, completionId, created, model, messages);
      } else {
        res.write(`data: ${JSON.stringify({ error: { message: `Stream failed: ${sseError.message}` } })}\n\n`);
        res.end();
      }
    }
  }

  private async streamCompletionFallback(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
  ): Promise<void> {
    const result = await this.openCodeClient.chat(messages, { model });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const chunks = this.splitIntoChunks(result.content, 10);
    for (const chunk of chunks) {
      const data: CompletionChunk = {
        id: completionId,
        object: 'text_completion.chunk',
        created,
        model,
        choices: [{ index: 0, text: chunk, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      await this.delay(30);
    }

    const finalChunk: CompletionChunk = {
      id: completionId,
      object: 'text_completion.chunk',
      created,
      model,
      choices: [{ index: 0, text: '', finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ==================== 代理端点 ====================

  private async listAgents(req: Request, res: Response): Promise<void> {
    try {
      const agents = await this.openCodeClient.listAgents();
      res.json(agents);
    } catch (error: any) {
      res.status(502).json({ error: { message: `\u83B7\u53D6\u4EE3\u7406\u5217\u8868\u5931\u8D25: ${error.message}` } });
    }
  }

  private async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await this.openCodeClient.getConfig();
      res.json(config);
    } catch (error: any) {
      res.status(502).json({ error: { message: `\u83B7\u53D6\u914D\u7F6E\u5931\u8D25: ${error.message}` } });
    }
  }

  // ==================== 工具调用核心方法 ====================

  private generateToolSystemPrompt(tools: ToolDefinition[], toolChoice?: ToolChoice): string {
    const toolDescriptions = tools.map(tool => {
      const fn = tool.function;
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : '{}';
      return `### ${fn.name}\n${fn.description || ''}\nParameters:\n${params}`;
    }).join('\n\n');

    let choiceInstruction = '';
    if (toolChoice === 'required') {
      choiceInstruction = '\nYou MUST call at least one tool in your response. Do not respond with only text.';
    } else if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      choiceInstruction = `\nYou MUST call the function "${toolChoice.function.name}" in your response.`;
    }

    return [
      'You have access to the following tools:',
      '',
      toolDescriptions,
      '',
      `To call a tool, output a JSON block in the following format:`,
      `${TOOL_CALL_OPEN_TAG}`,
      `{"name": "function_name", "arguments": {"arg1": "value1", "arg2": "value2"}}`,
      `${TOOL_CALL_CLOSE_TAG}`,
      '',
      `You can call multiple tools by using multiple ${TOOL_CALL_OPEN_TAG}/${TOOL_CALL_CLOSE_TAG} blocks.`,
      'You may also include text before or after the tool calls.',
      `If you do not need to call any tool, just respond normally without any ${TOOL_CALL_OPEN_TAG}/${TOOL_CALL_CLOSE_TAG} blocks.`,
      choiceInstruction,
    ].join('\n');
  }

  private prepareMessagesWithTools(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    toolChoice?: ToolChoice,
  ): ChatMessage[] {
    const processed: ChatMessage[] = [];
    const hasToolRelatedMessages = messages.some(
      m => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0)
    );

    if (tools && tools.length > 0) {
      const toolPrompt = this.generateToolSystemPrompt(tools, toolChoice);
      const existingSystem = messages.find(m => m.role === 'system');
      if (existingSystem) {
        const systemContent = typeof existingSystem.content === 'string'
          ? existingSystem.content
          : this.extractTextFromContent(existingSystem.content);
        processed.push({
          role: 'system',
          content: `${systemContent}\n\n${toolPrompt}`,
        });
      } else {
        processed.push({ role: 'system', content: toolPrompt });
      }
    }

    for (const msg of messages) {
      if (tools && tools.length > 0 && msg.role === 'system') {
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        let content = '';
        if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
          content = msg.content + '\n\n';
        }
        for (const tc of msg.tool_calls) {
          content += `${TOOL_CALL_OPEN_TAG}\n{"name": "${tc.function.name}", "arguments": ${tc.function.arguments}}\n${TOOL_CALL_CLOSE_TAG}\n`;
        }
        processed.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        const toolCallId = msg.tool_call_id || 'unknown';
        const toolName = msg.name || 'unknown';
        const resultContent = typeof msg.content === 'string'
          ? msg.content
          : this.extractTextFromContent(msg.content);
        processed.push({
          role: 'user',
          content: `[Tool Result for ${toolName} (id: ${toolCallId})]:\n${resultContent}`,
        });
      } else {
        processed.push({ ...msg });
      }
    }

    return processed;
  }

  private extractTextFromContent(content: string | any[] | null): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('');
    }
    return String(content);
  }

  private parseToolCallsFromResponse(content: string): ToolCall[] | null {
    const toolCalls: ToolCall[] = [];

    const openEscaped = TOOL_CALL_OPEN_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const closeEscaped = TOOL_CALL_CLOSE_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${openEscaped}\\s*([\\s\\S]*?)\\s*${closeEscaped}`, 'g');
    let match;

    while ((match = regex.exec(content)) !== null) {
      const jsonStr = match[1].trim();
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.name) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || {}),
            },
          });
        }
      } catch (e) {
        console.warn('[OpenAI Server] \u89E3\u6790\u5DE5\u5177\u8C03\u7528 JSON \u5931\u8D25:', jsonStr.substring(0, 100));
      }
    }

    if (toolCalls.length === 0) {
      const jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
      while ((match = jsonBlockRegex.exec(content)) !== null) {
        const jsonStr = match[1].trim();
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.name && parsed.arguments) {
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              type: 'function',
              function: {
                name: parsed.name,
                arguments: typeof parsed.arguments === 'string'
                  ? parsed.arguments
                  : JSON.stringify(parsed.arguments),
              },
            });
          }
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item.name && item.arguments) {
                toolCalls.push({
                  id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  type: 'function',
                  function: {
                    name: item.name,
                    arguments: typeof item.arguments === 'string'
                      ? item.arguments
                      : JSON.stringify(item.arguments),
                  },
                });
              }
            }
          }
        } catch {
          // not valid JSON, skip
        }
      }
    }

    return toolCalls.length > 0 ? toolCalls : null;
  }

  private extractTextOutsideToolCalls(content: string): string {
    const openEscaped = TOOL_CALL_OPEN_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const closeEscaped = TOOL_CALL_CLOSE_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${openEscaped}[\\s\\S]*?${closeEscaped}`, 'g');
    let text = content.replace(regex, '').trim();
    text = text.replace(/```(?:json)?\s*\n?\{"name":\s*"[^"]+",\s*"arguments":\s*\{[\s\S]*?\}\s*\}\n?```/g, '').trim();
    return text || '';
  }

  // ==================== 通用工具方法 ====================

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private splitIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private estimateTokens(messages: Array<{ role?: string; content: string | any[] | null }>): number {
    const text = messages.map(m => {
      if (typeof m.content === 'string') return m.content;
      if (m.content) return JSON.stringify(m.content);
      return '';
    }).join(' ');
    return Math.ceil(text.length / 4);
  }

  // ==================== 启动/停止 ====================

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, this.hostname, () => {
        console.log(`[OpenAI Server] \u670D\u52A1\u5DF2\u542F\u52A8: http://${this.hostname}:${this.port}`);
        console.log(`[OpenAI Server] \u5065\u5EB7\u68C0\u67E5: http://${this.hostname}:${this.port}/health`);
        console.log(`[OpenAI Server] \u6A21\u578B\u5217\u8868: http://${this.hostname}:${this.port}/v1/models`);
        console.log(`[OpenAI Server] OpenCode \u540E\u7AEF: ${this.openCodeClient.getBaseUrl()}`);
        resolve();
      });

      this.server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`\u7AEF\u53E3 ${this.port} \u5DF2\u88AB\u5360\u7528`));
        } else {
          reject(error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[OpenAI Server] \u670D\u52A1\u5DF2\u505C\u6B62');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
