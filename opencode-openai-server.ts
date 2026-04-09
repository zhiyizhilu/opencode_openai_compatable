import express, { Request, Response } from 'express';
import { OpenCodeClient } from './opencode-client';
import { Readable } from 'stream';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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

export class OpenAIServer {
  private app: express.Application;
  private server: any;
  private port: number;
  private openCodeClient: OpenCodeClient;

  constructor(port: number = 3000, cliPath?: string) {
    this.port = port;
    this.app = express();
    this.openCodeClient = new OpenCodeClient(cliPath);
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });
  }

  private setupRoutes(): void {
    this.app.get('/v1/models', this.listModels.bind(this));
    this.app.get('/v1/models/:model', this.getModel.bind(this));
    this.app.post('/v1/chat/completions', this.chatCompletions.bind(this));
    this.app.post('/v1/completions', this.completions.bind(this));
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'OpenAI-compatible OpenCode API' });
    });
  }

  private async listModels(req: Request, res: Response): Promise<void> {
    try {
      const models = await this.openCodeClient.listModels();
      const response: ModelsResponse = {
        object: 'list',
        data: models.map((modelId, index) => ({
          id: modelId,
          object: 'model',
          created: Date.now(),
          owned_by: 'opencode'
        }))
      };
      res.json(response);
    } catch (error: any) {
      console.error('[OpenAI Server] 获取模型列表失败:', error.message);
      res.status(500).json({
        error: {
          message: `Failed to list models: ${error.message}`,
          type: 'server_error',
          code: 'internal_error'
        }
      });
    }
  }

  private async getModel(req: Request, res: Response): Promise<void> {
    try {
      const { model } = req.params;
      const models = await this.openCodeClient.listModels();
      const found = models.find(m => m === model);
      
      if (found) {
        const response: Model = {
          id: model,
          object: 'model',
          created: Date.now(),
          owned_by: 'opencode'
        };
        res.json(response);
      } else {
        res.status(404).json({
          error: {
            message: `Model '${model}' not found`,
            type: 'invalid_request_error',
            code: 'model_not_found'
          }
        });
      }
    } catch (error: any) {
      console.error('[OpenAI Server] 获取模型失败:', error.message);
      res.status(500).json({
        error: {
          message: `Failed to get model: ${error.message}`,
          type: 'server_error',
          code: 'internal_error'
        }
      });
    }
  }

  private async chatCompletions(req: Request, res: Response): Promise<void> {
    const { model, messages, temperature, stream = false } = req.body as ChatCompletionRequest;

    if (!model || !messages || !Array.isArray(messages)) {
      res.status(400).json({
        error: {
          message: 'Missing required fields: model, messages',
          type: 'invalid_request_error',
          code: 'invalid_parameter'
        }
      });
      return;
    }

    const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      if (stream) {
        await this.streamChatCompletion(req, res, completionId, created, model, messages, temperature);
      } else {
        const content = await this.openCodeClient.chat(messages, {
          model,
          temperature
        });

        const response: ChatCompletionResponse = {
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: this.estimateTokens(messages),
            completion_tokens: this.estimateTokens([{ role: 'assistant', content }]),
            total_tokens: this.estimateTokens([...messages, { role: 'assistant', content }])
          }
        };

        res.json(response);
      }
    } catch (error: any) {
      console.error('[OpenAI Server] Chat completion 失败:', error.message);
      res.status(500).json({
        error: {
          message: `Chat completion failed: ${error.message}`,
          type: 'server_error',
          code: 'internal_error'
        }
      });
    }
  }

  private async streamChatCompletion(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
    temperature?: number
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const content = await this.openCodeClient.chat(messages, {
        model,
        temperature
      });

      const chunks = this.splitIntoChunks(content, 10);

      for (let i = 0; i < chunks.length; i++) {
        const chunk: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {
              role: i === 0 ? 'assistant' : undefined,
              content: chunks[i]
            },
            finish_reason: null
          }]
        };

        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await this.delay(50);
      }

      const finalChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      };

      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error: any) {
      console.error('[OpenAI Server] 流式响应失败:', error.message);
      res.write(`data: ${JSON.stringify({
        error: {
          message: `Stream failed: ${error.message}`,
          type: 'server_error',
          code: 'internal_error'
        }
      })}\n\n`);
      res.end();
    }
  }

  private async completions(req: Request, res: Response): Promise<void> {
    const { model, prompt, temperature, stream = false } = req.body as CompletionRequest;

    if (!model || !prompt) {
      res.status(400).json({
        error: {
          message: 'Missing required fields: model, prompt',
          type: 'invalid_request_error',
          code: 'invalid_parameter'
        }
      });
      return;
    }

    const completionId = `cmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      const messages: ChatMessage[] = Array.isArray(prompt)
        ? prompt.map(p => ({ role: 'user', content: p }))
        : [{ role: 'user', content: prompt }];

      if (stream) {
        await this.streamCompletion(req, res, completionId, created, model, messages, temperature);
      } else {
        const content = await this.openCodeClient.chat(messages, {
          model,
          temperature
        });

        const response: CompletionResponse = {
          id: completionId,
          object: 'text_completion',
          created,
          model,
          choices: [{
            index: 0,
            text: content,
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: this.estimateTokens(messages),
            completion_tokens: this.estimateTokens([{ role: 'assistant', content }]),
            total_tokens: this.estimateTokens([...messages, { role: 'assistant', content }])
          }
        };

        res.json(response);
      }
    } catch (error: any) {
      console.error('[OpenAI Server] Completion 失败:', error.message);
      res.status(500).json({
        error: {
          message: `Completion failed: ${error.message}`,
          type: 'server_error',
          code: 'internal_error'
        }
      });
    }
  }

  private async streamCompletion(
    req: Request,
    res: Response,
    completionId: string,
    created: number,
    model: string,
    messages: ChatMessage[],
    temperature?: number
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const content = await this.openCodeClient.chat(messages, {
        model,
        temperature
      });

      const chunks = this.splitIntoChunks(content, 10);

      for (let i = 0; i < chunks.length; i++) {
        const chunk: CompletionChunk = {
          id: completionId,
          object: 'text_completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            text: chunks[i],
            finish_reason: null
          }]
        };

        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await this.delay(50);
      }

      const finalChunk: CompletionChunk = {
        id: completionId,
        object: 'text_completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          text: '',
          finish_reason: 'stop'
        }]
      };

      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error: any) {
      console.error('[OpenAI Server] 流式响应失败:', error.message);
      res.write(`data: ${JSON.stringify({
        error: {
          message: `Stream failed: ${error.message}`,
          type: 'server_error',
          code: 'internal_error'
        }
      })}\n\n`);
      res.end();
    }
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

  private estimateTokens(messages: ChatMessage[]): number {
    const text = messages.map(m => m.content).join(' ');
    return Math.ceil(text.length / 4);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`[OpenAI Server] 服务已启动: http://127.0.0.1:${this.port}`);
        console.log(`[OpenAI Server] 健康检查: http://127.0.0.1:${this.port}/health`);
        console.log(`[OpenAI Server] 模型列表: http://127.0.0.1:${this.port}/v1/models`);
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
