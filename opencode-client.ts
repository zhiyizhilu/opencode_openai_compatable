import { spawn, ChildProcess } from 'child_process';
import axios, { AxiosInstance } from 'axios';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { EventEmitter } from 'events';

/**
 * OpenCode 本地客户端
 * 通过 opencode serve 暴露的官方 HTTP REST API 通信
 * 参考文档: https://opencode.ai/docs/server/
 */
export class OpenCodeClient {
  private baseUrl: string = 'http://127.0.0.1:4095';
  private process: ChildProcess | null = null;
  private cliPath: string = '';
  private isStarting: boolean = false;
  private startPromise: Promise<void> | null = null;
  private username: string = '';
  private password: string = '';
  private httpClient: AxiosInstance;

  constructor(options?: { cliPath?: string; opencodePort?: number; username?: string; password?: string }) {
    this.cliPath = options?.cliPath || this.findCliPath();
    if (options?.opencodePort) {
      this.baseUrl = `http://127.0.0.1:${options.opencodePort}`;
    }
    if (options?.username) this.username = options.username;
    if (options?.password) this.password = options.password;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 300000,
      headers: this.getAuthHeaders(),
    });
  }

  /** 构建认证头 */
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.username || this.password) {
      const credentials = Buffer.from(`${this.username || 'opencode'}:${this.password}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }
    return headers;
  }

  /** 自动查找 OpenCode CLI 路径 */
  private findCliPath(): string {
    const platform = os.platform();
    const home = os.homedir();
    const candidates: string[] = [];

    if (platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      candidates.push(
        path.join(home, 'AppData', 'Roaming', 'fnm', 'node-versions', 'v22.21.1', 'installation', 'opencode.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
        path.join(home, '.opencode', 'bin', 'opencode.exe'),
        path.join(home, '.opencode', 'bin', 'opencode.cmd'),
        path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
        path.join(localAppData, 'opencode', 'opencode.exe'),
        'opencode.cmd',
        'opencode'
      );
    } else if (platform === 'darwin') {
      candidates.push(
        path.join(home, '.opencode', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
        '/opt/homebrew/bin/opencode',
        'opencode'
      );
    } else {
      candidates.push(
        path.join(home, '.opencode', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
        '/usr/bin/opencode',
        'opencode'
      );
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          console.log('[OpenCode] 找到 CLI:', candidate);
          return candidate;
        }
      } catch (e) { /* continue */ }
    }

    console.log('[OpenCode] 未找到 CLI 文件，尝试使用 PATH 中的 opencode');
    return platform === 'win32' ? 'opencode.cmd' : 'opencode';
  }

  /** 检查 OpenCode 服务是否已启动（官方 GET /global/health） */
  async isServiceRunning(): Promise<boolean> {
    try {
      const response = await this.httpClient.get('/global/health', { timeout: 2000 });
      return response.status === 200 && response.data?.healthy === true;
    } catch (e) {
      return false;
    }
  }

  /** 启动 OpenCode 本地服务（opencode serve） */
  private async startService(): Promise<void> {
    if (this.isStarting && this.startPromise) {
      return this.startPromise;
    }

    this.isStarting = true;
    this.startPromise = new Promise((resolve, reject) => {
      console.log('[OpenCode] 正在启动本地服务，CLI 路径:', this.cliPath);

      const isWindows = os.platform() === 'win32';
      const useShell = isWindows || this.cliPath.endsWith('.cmd') || this.cliPath.endsWith('.ps1');

      // 从 baseUrl 提取端口号
      const port = this.baseUrl.split(':').pop() || '4095';

      // 构建环境变量，支持认证
      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (this.password) {
        env['OPENCODE_SERVER_PASSWORD'] = this.password;
        if (this.username) {
          env['OPENCODE_SERVER_USERNAME'] = this.username;
        }
      }

      this.process = spawn(this.cliPath, ['serve', '--port', port, '--hostname', '127.0.0.1'], {
        detached: false,
        windowsHide: true,
        shell: useShell,
        env,
      });

      this.process.stdout?.on('data', (data) => {
        const text = data.toString();
        console.log('[OpenCode]', text.trim());
        const match = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i);
        if (match) {
          this.baseUrl = match[0];
          this.httpClient.defaults.baseURL = this.baseUrl;
        }
      });

      this.process.stderr?.on('data', (data) => {
        console.error('[OpenCode stderr]', data.toString().trim());
      });

      this.process.on('error', (err) => {
        console.error('[OpenCode] 启动失败:', err.message);
        this.isStarting = false;
        reject(new Error(`OpenCode 启动失败: ${err.message}`));
      });

      this.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[OpenCode] 进程退出，代码: ${code}`);
        }
        this.process = null;
      });

      // 轮询 /global/health 等待服务就绪
      const checkInterval = setInterval(async () => {
        if (await this.isServiceRunning()) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          console.log('[OpenCode] 服务已启动:', this.baseUrl);
          this.isStarting = false;
          resolve();
        }
      }, 500);

      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        this.isStarting = false;
        if (this.process) {
          this.process.kill();
          this.process = null;
        }
        reject(new Error('OpenCode 服务启动超时'));
      }, 30000);
    });

    return this.startPromise;
  }

  /** 确保服务已启动 */
  async ensureStarted(): Promise<void> {
    if (await this.isServiceRunning()) {
      return;
    }
    await this.startService();
  }

  /** 停止服务 */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  /** 获取服务健康状态 */
  async getHealth(): Promise<{ healthy: boolean; version: string }> {
    const resp = await this.httpClient.get('/global/health');
    return resp.data;
  }

  /** 列出所有项目 */
  async listProjects(): Promise<any[]> {
    const resp = await this.httpClient.get('/project');
    return resp.data;
  }

  /** 获取当前项目 */
  async getCurrentProject(): Promise<any> {
    const resp = await this.httpClient.get('/project/current');
    return resp.data;
  }

  /** 获取配置信息 */
  async getConfig(): Promise<any> {
    const resp = await this.httpClient.get('/config');
    return resp.data;
  }

  /** 列出所有可用代理 */
  async listAgents(): Promise<any[]> {
    const resp = await this.httpClient.get('/agent');
    return resp.data;
  }

  /** 创建新会话 */
  async createSession(options?: { parentID?: string; title?: string }): Promise<any> {
    const resp = await this.httpClient.post('/session', options || {});
    return resp.data;
  }

  /** 获取会话详情 */
  async getSession(sessionId: string): Promise<any> {
    const resp = await this.httpClient.get(`/session/${sessionId}`);
    return resp.data;
  }

  /** 删除会话 */
  async deleteSession(sessionId: string): Promise<boolean> {
    const resp = await this.httpClient.delete(`/session/${sessionId}`);
    return resp.data;
  }

  /** 列出会话中的消息 */
  async listMessages(sessionId: string, limit?: number): Promise<any[]> {
    const params: any = {};
    if (limit) params.limit = limit;
    const resp = await this.httpClient.get(`/session/${sessionId}/message`, { params });
    return resp.data;
  }

  /** 发送消息并等待响应（同步） */
  async sendMessage(sessionId: string, options: {
    messageID?: string;
    model?: { providerID: string; modelID: string };
    agent?: string;
    system?: string;
    parts: Array<{ type: string; text: string }>;
  }): Promise<{ info: any; parts: any[] }> {
    const body: any = { parts: options.parts };
    if (options.messageID) body.messageID = options.messageID;
    if (options.model) body.model = options.model;
    if (options.agent) body.agent = options.agent;
    if (options.system) body.system = options.system;

    const resp = await this.httpClient.post(`/session/${sessionId}/message`, body);
    return resp.data;
  }

  /** 异步发送消息（不等待响应） */
  async sendMessageAsync(sessionId: string, options: {
    messageID?: string;
    model?: { providerID: string; modelID: string };
    agent?: string;
    system?: string;
    parts: Array<{ type: string; text: string }>;
  }): Promise<void> {
    const body: any = { parts: options.parts };
    if (options.messageID) body.messageID = options.messageID;
    if (options.model) body.model = options.model;
    if (options.agent) body.agent = options.agent;
    if (options.system) body.system = options.system;

    await this.httpClient.post(`/session/${sessionId}/prompt_async`, body);
  }

  /** 中止正在运行的会话 */
  async abortSession(sessionId: string): Promise<boolean> {
    const resp = await this.httpClient.post(`/session/${sessionId}/abort`);
    return resp.data;
  }

  /** 获取会话差异 */
  async getSessionDiff(sessionId: string, messageID?: string): Promise<any[]> {
    const params: any = {};
    if (messageID) params.messageID = messageID;
    const resp = await this.httpClient.get(`/session/${sessionId}/diff`, { params });
    return resp.data;
  }

  /** 订阅 SSE 事件流（GET /event） */
  subscribeEvents(): EventEmitter & { close: () => void } {
    const emitter = new EventEmitter() as EventEmitter & { close: () => void };
    const controller = new AbortController();

    const url = `${this.baseUrl}/event`;

    (async () => {
      try {
        const response = await fetch(url, {
          headers: this.getAuthHeaders(),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          emitter.emit('error', new Error(`SSE 连接失败: ${response.status}`));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              try {
                const event = JSON.parse(data);
                emitter.emit('event', event);
                // 根据事件类型分发
                if (event.type) {
                  emitter.emit(event.type, event);
                }
              } catch {
                // 忽略非 JSON 数据
              }
            } else if (line.startsWith('event: ')) {
              // SSE event type 行
            }
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          emitter.emit('error', err);
        }
      }
    })();

    emitter.close = () => controller.abort();
    return emitter;
  }

  /**
   * 从消息内容中提取纯文本
   */
  private extractTextContent(content: string | any[] | null): string {
    if (!content) return '';
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('');
    }
    return String(content || '');
  }

  private buildMessageTextFromHistory(messages: Array<{ role: string; content: string | any[] | null }>): string {
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length === 0) {
      return '';
    }

    const onlyUserMessages = nonSystemMessages.filter(m => m.role === 'user');
    if (nonSystemMessages.length === 1 && onlyUserMessages.length === 1) {
      return this.extractTextContent(onlyUserMessages[0].content);
    }

    const parts: string[] = [];
    for (const msg of nonSystemMessages) {
      const text = this.extractTextContent(msg.content);
      if (!text) continue;

      switch (msg.role) {
        case 'user':
          parts.push(`[User]: ${text}`);
          break;
        case 'assistant':
          parts.push(`[Assistant]: ${text}`);
          break;
        default:
          parts.push(`[${msg.role}]: ${text}`);
          break;
      }
    }

    return parts.join('\n\n');
  }

  /**
   * 发送聊天消息（非流式）
   * 流程：创建会话 -> 发送消息 -> 提取回复 -> 清理会话
   */
  async chat(messages: Array<{ role: string; content: string | any[] | null }>, options: {
    model?: string;
    temperature?: number;
    agent?: string;
    system?: string;
  } = {}): Promise<{ content: string; reasoning?: string }> {
    await this.ensureStarted();

    // 创建新会话
    let sessionId: string;
    try {
      const sessionResp = await this.httpClient.post('/session', {});
      sessionId = sessionResp.data?.id;
      if (!sessionId) {
        throw new Error('创建会话失败：未返回 session id');
      }
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : '';
      throw new Error(`OpenCode 创建会话失败: ${err.message} ${detail}`);
    }

    try {
      const textContent = this.buildMessageTextFromHistory(messages);
      if (!textContent) {
        throw new Error('没有可发送的消息内容');
      }

      const messageBody: any = {
        parts: [{ type: 'text', text: textContent }],
      };

      const systemMessage = options.system || messages.find(m => m.role === 'system');
      if (systemMessage) {
        messageBody.system = typeof systemMessage === 'string' ? systemMessage : this.extractTextContent(
          typeof systemMessage.content === 'string' ? systemMessage.content : (systemMessage as any).content || ''
        );
      }

      if (options.model && options.model !== 'auto') {
        const parts = options.model.split('/');
        if (parts.length >= 2) {
          messageBody.model = { providerID: parts[0], modelID: parts.slice(1).join('/') };
        }
      }

      if (options.agent) {
        messageBody.agent = options.agent;
      }

      const msgResp = await this.httpClient.post(`/session/${sessionId}/message`, messageBody, {
        timeout: 300000,
      });

      const parts = msgResp.data?.parts;
      if (!Array.isArray(parts)) {
        console.error('[OpenCode] 返回数据:', JSON.stringify(msgResp.data).substring(0, 300));
        throw new Error('OpenCode 返回内容为空');
      }

      const replyText = parts
        .filter((p: any) => p.type === 'text' && p.text)
        .map((p: any) => p.text)
        .join('');

      const reasoningText = parts
        .filter((p: any) => p.type === 'reasoning' && p.text)
        .map((p: any) => p.text)
        .join('\n');

      if (!replyText && !reasoningText) {
        const toolParts = parts.filter((p: any) => p.type === 'tool');
        if (toolParts.length > 0) {
          const toolTexts = toolParts.map((p: any) => {
            const state = p.state || {};
            const toolName = p.tool || 'unknown';
            if (state.status === 'completed' && state.output) {
              return `[Tool: ${toolName}] ${state.output}`;
            }
            if (state.status === 'error' && state.error) {
              return `[Tool Error: ${toolName}] ${state.error}`;
            }
            return `[Tool: ${toolName}] ${state.status || 'unknown'}`;
          });
          return { content: toolTexts.join('\n\n') };
        }
        console.error('[OpenCode] parts 数据:', JSON.stringify(parts).substring(0, 300));
        throw new Error('OpenCode 返回内容为空');
      }

      this.httpClient.delete(`/session/${sessionId}`).catch(() => {});

      return {
        content: replyText || '',
        reasoning: reasoningText || undefined,
      };
    } catch (err: any) {
      this.httpClient.delete(`/session/${sessionId}`).catch(() => {});
      throw err;
    }
  }

  /**
   * 流式聊天（通过 SSE 事件流实现真正的流式响应）
   * 流程：创建会话 -> 订阅事件流 -> 异步发送消息 -> 实时接收事件 -> 清理
   */
  async chatStream(
    messages: Array<{ role: string; content: string | any[] | null }>,
    onChunk: (text: string) => void,
    options: {
      model?: string;
      temperature?: number;
      agent?: string;
      system?: string;
    } = {},
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    await this.ensureStarted();

    // 创建新会话
    let sessionId: string;
    try {
      const sessionResp = await this.httpClient.post('/session', {});
      sessionId = sessionResp.data?.id;
      if (!sessionId) {
        throw new Error('创建会话失败：未返回 session id');
      }
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : '';
      throw new Error(`OpenCode 创建会话失败: ${err.message} ${detail}`);
    }

    try {
      const textContent = this.buildMessageTextFromHistory(messages);
      if (!textContent) {
        throw new Error('没有可发送的消息内容');
      }

      const messageBody: any = {
        parts: [{ type: 'text', text: textContent }],
      };

      const systemMessage = options.system || messages.find(m => m.role === 'system');
      if (systemMessage) {
        messageBody.system = typeof systemMessage === 'string' ? systemMessage : this.extractTextContent(
          typeof systemMessage.content === 'string' ? systemMessage.content : (systemMessage as any).content || ''
        );
      }

      if (options.model && options.model !== 'auto') {
        const parts = options.model.split('/');
        if (parts.length >= 2) {
          messageBody.model = { providerID: parts[0], modelID: parts.slice(1).join('/') };
        }
      }

      if (options.agent) {
        messageBody.agent = options.agent;
      }

      const eventSource = this.subscribeEvents();

      return new Promise<string>((resolve, reject) => {
        let fullText = '';
        let resolved = false;

        const cleanup = () => {
          eventSource.close();
          // 异步清理会话
          this.httpClient.delete(`/session/${sessionId}`).catch(() => {});
        };

        // 监听消息相关事件
        // OpenCode SSE 事件格式: { type: string, properties: { ... } }
        // 关键事件类型:
        //   message.part.delta  - 流式增量文本 { sessionID, messageID, partID, field: "text", delta: "增量文本" }
        //   message.part.updated - 文本部分完整更新 { sessionID, part: { type, text, ... } }
        //   session.idle         - 会话完成
        //   session.status       - 会话状态变化 { status: { type: "busy"|"idle" } }
        eventSource.on('event', (event: any) => {
          const props = event.properties || {};

          // 只处理当前会话的事件
          if (props.sessionID && props.sessionID !== sessionId) return;

          // 流式增量文本事件（真正的 token-by-token 推送）
          if (event.type === 'message.part.delta' && props.field === 'text' && props.delta) {
            const partType = props.partType || 'text';
            if (partType === 'reasoning' && onReasoning) {
              onReasoning(props.delta);
            } else {
              fullText += props.delta;
              onChunk(props.delta);
            }
          }

          if (event.type === 'message.part.updated') {
            const part = props.part;
            if (part?.type === 'text' && part?.text) {
              if (!fullText) {
                fullText = part.text;
                onChunk(part.text);
              } else if (part.text.length > fullText.length && part.text.startsWith(fullText)) {
                const delta = part.text.slice(fullText.length);
                fullText = part.text;
                onChunk(delta);
              }
            }
            if (part?.type === 'reasoning' && part?.text && onReasoning) {
              onReasoning(part.text);
            }
            if (part?.type === 'tool' && part?.state?.status === 'completed' && part?.state?.output) {
              const toolInfo = `\n[Tool: ${part.tool || 'unknown'}] ${part.state.output}\n`;
              fullText += toolInfo;
              onChunk(toolInfo);
            }
          }

          // 会话空闲 = 完成
          if (event.type === 'session.idle') {
            if (!resolved) {
              resolved = true;
              cleanup();
              resolve(fullText);
            }
          }
        });

        eventSource.on('error', (err: any) => {
          if (!resolved) {
            resolved = true;
            cleanup();
            // 如果已收到部分文本，返回它而不是报错
            if (fullText) {
              resolve(fullText);
            } else {
              reject(err);
            }
          }
        });

        // 异步发送消息（不等待完整响应，通过 SSE 流式接收）
        this.sendMessageAsync(sessionId, messageBody).catch(err => {
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(err);
          }
        });

        // 超时保护（5分钟）
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            if (fullText) {
              resolve(fullText);
            } else {
              reject(new Error('流式响应超时'));
            }
          }
        }, 300000);
      });
    } catch (err: any) {
      this.httpClient.delete(`/session/${sessionId}`).catch(() => {});
      throw err;
    }
  }

  /**
   * 列出可用模型
   * 通过官方 GET /config/providers 接口获取所有提供商的模型列表
   */
  async listModels(): Promise<string[]> {
    await this.ensureStarted();

    try {
      const response = await this.httpClient.get('/config/providers');
      const payload = response.data?.data || response.data || {};
      const providers = Array.isArray(payload.providers) ? payload.providers :
                       Array.isArray(payload) ? payload : [];

      const models: string[] = [];

      for (const provider of providers) {
        const providerID = String(provider?.id || '').trim();
        if (!providerID) continue;

        const providerModels = provider.models;
        if (Array.isArray(providerModels)) {
          for (const item of providerModels) {
            const modelID = String(
              typeof item === 'string' ? item :
              item?.id || item?.model || item?.name || ''
            ).trim();
            if (modelID) {
              models.push(`${providerID}/${modelID}`);
            }
          }
        } else if (providerModels && typeof providerModels === 'object') {
          for (const key of Object.keys(providerModels)) {
            if (key.trim()) {
              models.push(`${providerID}/${key.trim()}`);
            }
          }
        }
      }

      return [...new Set(models)].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      console.error('[OpenCode] 获取模型列表失败:', e);
      return this.getDefaultFreeModels();
    }
  }

  /** 获取默认免费模型列表（作为备用） */
  getDefaultFreeModels(): string[] {
    return [
      'opencode/mimo-v2-omni-free',
      'opencode/mimo-v2-pro-free',
      'opencode/minimax-m2.5-free',
      'opencode/nemotron-3-super-free',
      'opencode/big-pickle',
      'opencode/gpt-5-nano',
    ];
  }

  /** 获取 baseUrl */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}

// 单例实例
let clientInstance: OpenCodeClient | null = null;

export function getOpenCodeClient(options?: { cliPath?: string; opencodePort?: number; username?: string; password?: string }): OpenCodeClient {
  if (!clientInstance) {
    clientInstance = new OpenCodeClient(options);
  }
  return clientInstance;
}

export function resetOpenCodeClient(): void {
  if (clientInstance) {
    clientInstance.stop().catch(() => {});
    clientInstance = null;
  }
}

/**
 * 检测 OpenCode CLI 是否已安装
 */
export function detectOpenCodePath(): { found: boolean; path: string; message: string } {
  const platform = os.platform();
  const home = os.homedir();
  const candidates: string[] = [];

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(home, 'AppData', 'Roaming', 'fnm', 'node-versions', 'v22.21.1', 'installation', 'opencode.cmd'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
      path.join(home, '.opencode', 'bin', 'opencode.exe'),
      path.join(home, '.opencode', 'bin', 'opencode.cmd'),
      path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
      path.join(localAppData, 'opencode', 'opencode.exe')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(home, '.opencode', 'bin', 'opencode'),
      '/usr/local/bin/opencode',
      '/opt/homebrew/bin/opencode',
      '/usr/bin/opencode'
    );
  } else {
    candidates.push(
      path.join(home, '.opencode', 'bin', 'opencode'),
      '/usr/local/bin/opencode',
      '/usr/bin/opencode',
      path.join(home, '.local', 'bin', 'opencode')
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { found: true, path: candidate, message: '检测到 OpenCode CLI' };
    }
  }

  try {
    const { execSync } = require('child_process');
    const cmd = platform === 'win32' ? 'where opencode' : 'which opencode';
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const foundPath = result.trim().split('\n')[0];
    if (foundPath && fs.existsSync(foundPath)) {
      return { found: true, path: foundPath, message: '检测到 OpenCode CLI' };
    }
  } catch { /* continue */ }

  return { found: false, path: '', message: '未检测到 OpenCode CLI，请先安装：npm install -g opencode-ai' };
}
