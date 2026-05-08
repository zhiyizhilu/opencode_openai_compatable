import express, { Request, Response } from 'express';
import { OpenCodeClient } from './opencode-client';

// ==================== 类型定义 ====================

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | any[];
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'length' | 'content_filter' | null;
  }>;
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

    // CORS 中间件
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      // 默认允许所有来源，额外允许配置的来源
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

    // 请求日志
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
    // OpenAI 兼容端点
    this.app.get('/v1/models', this.listModels.bind(this));
    this.app.get('/v1/models/:model', this.getModel.bind(this));
    this.app.post('/v1/chat/completions', this.chatCompletions.bind(this));
    this.app.post('/v1/completions', this.completions.bind(this));

    // 健康检查（同时检查 OpenCode 后端）
    this.app.get('/health', this.healthCheck.bind(this));

    // 代理端点 - 暴露 OpenCode 原生 API 的部分能力
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
      res.status(502).json({ error: { message: `OpenCode 后端不可用: ${error.message}` } });
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
      console.error('[OpenAI Server] 获取模型列表失败:', error.message);
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
    const { model, messages, stream = false } = req.body as ChatCompletionRequest;

    if (!model || !messages || !Array.isArray(messages)) {
      res.status(400).json({
        error: { message: 'Missing required fields: model, messages', type: 'invalid_request_error', code: 'invalid_parameter' },
      });
      return;
    }

    const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      if (stream) {
        await this.streamChatCompletion(req, res, completionId, created, model, messages);
      } else {
        const content = await this.openCodeClient.chat(messages, { model });

        const response: ChatCompletionResponse = {
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: this.estimateTokens(messages),
            completion_tokens: this.estimateTokens([{ role: 'assistant', content }]),
            total_tokens: this.estimateTokens([...messages, { role: 'assistant', content }]),
          },
        };
        res.json(response);
      }
    } catch (error: any) {
      console.error('[OpenAI Server] Chat completion 失败:', error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: `Chat completion failed: ${error.message}`, type: 'server_error', code: 'internal_error' },
        });
      }
    }
  }

  /**
   * 真正的流式 Chat Completion
   * 通过 OpenCode 的 SSE 事件流实时转发
   */
  private async streamChatCompletion(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
  ): Promise<void> {
    // 先尝试使用 SSE 事件流实现真正的流式
    try {
      await this.streamChatViaSSE(req, res, completionId, created, model, messages);
    } catch (sseError: any) {
      // SSE 流式失败时回退到伪流式
      console.warn('[OpenAI Server] SSE 流式失败，回退到伪流式:', sseError.message);
      if (!res.headersSent) {
        await this.streamChatFallback(req, res, completionId, created, model, messages);
      }
    }
  }

  /**
   * 通过 OpenCode SSE 事件流实现真正的流式响应
   */
  private async streamChatViaSSE(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 发送首个 chunk（role）
    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    // 使用 client 的 chatStream 方法
    const fullText = await this.openCodeClient.chatStream(messages, (delta) => {
      const chunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }, { model });

    // 发送结束 chunk
    const finalChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /**
   * 伪流式回退：先获取完整内容，再分段发送
   */
  private async streamChatFallback(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
  ): Promise<void> {
    const content = await this.openCodeClient.chat(messages, { model });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 角色 chunk
    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    // 分段发送内容
    const chunks = this.splitIntoChunks(content, 10);
    for (const chunk of chunks) {
      const data: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      await this.delay(30);
    }

    // 结束 chunk
    const finalChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
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
        const content = await this.openCodeClient.chat(messages, { model });

        const response: CompletionResponse = {
          id: completionId,
          object: 'text_completion',
          created,
          model,
          choices: [{ index: 0, text: content, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: this.estimateTokens(messages),
            completion_tokens: this.estimateTokens([{ role: 'assistant', content }]),
            total_tokens: this.estimateTokens([...messages, { role: 'assistant', content }]),
          },
        };
        res.json(response);
      }
    } catch (error: any) {
      console.error('[OpenAI Server] Completion 失败:', error.message);
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
    // 尝试真正的流式
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
      // 回退到伪流式
      if (!res.headersSent) {
        console.warn('[OpenAI Server] 流式 Completion 失败，回退到伪流式:', sseError.message);
        await this.streamCompletionFallback(req, res, completionId, created, model, messages);
      } else {
        // headers 已发送，无法回退
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
    const content = await this.openCodeClient.chat(messages, { model });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const chunks = this.splitIntoChunks(content, 10);
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
      res.status(502).json({ error: { message: `获取代理列表失败: ${error.message}` } });
    }
  }

  private async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await this.openCodeClient.getConfig();
      res.json(config);
    } catch (error: any) {
      res.status(502).json({ error: { message: `获取配置失败: ${error.message}` } });
    }
  }

  // ==================== 工具方法 ====================

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

  private estimateTokens(messages: Array<{ role?: string; content: string | any[] }>): number {
    const text = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' ');
    return Math.ceil(text.length / 4);
  }

  // ==================== 启动/停止 ====================

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, this.hostname, () => {
        console.log(`[OpenAI Server] 服务已启动: http://${this.hostname}:${this.port}`);
        console.log(`[OpenAI Server] 健康检查: http://${this.hostname}:${this.port}/health`);
        console.log(`[OpenAI Server] 模型列表: http://${this.hostname}:${this.port}/v1/models`);
        console.log(`[OpenAI Server] OpenCode 后端: ${this.openCodeClient.getBaseUrl()}`);
        resolve();
      });

      this.server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 已被占用`));
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
          console.log('[OpenAI Server] 服务已停止');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
