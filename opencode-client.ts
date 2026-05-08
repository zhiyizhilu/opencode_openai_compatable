import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * OpenCode 本地客户端
 * 通过 opencode serve 暴露的官方 HTTP REST API 通信
 * 参考文档: https://opencode.ai/docs/zh-cn/server/
 */
export class OpenCodeClient {
  private baseUrl: string = 'http://127.0.0.1:4095';
  private process: ChildProcess | null = null;
  private cliPath: string = '';
  private isStarting: boolean = false;
  private startPromise: Promise<void> | null = null;

  constructor(cliPath?: string) {
    this.cliPath = cliPath || this.findCliPath();
  }

  /**
   * 自动查找 OpenCode CLI 路径
   */
  private findCliPath(): string {
    const platform = os.platform();
    const home = os.homedir();
    
    const candidates: string[] = [];
    
    if (platform === 'win32') {
      // Windows 候选路径 - npm 全局安装通常使用 .cmd 文件
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      
      candidates.push(
        // fnm 安装路径
        path.join(home, 'AppData', 'Roaming', 'fnm', 'node-versions', 'v22.21.1', 'installation', 'opencode.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
        // 其他常见路径
        path.join(home, '.opencode', 'bin', 'opencode.exe'),
        path.join(home, '.opencode', 'bin', 'opencode.cmd'),
        path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
        path.join(localAppData, 'opencode', 'opencode.exe'),
        'opencode.cmd',
        'opencode'
      );
    } else if (platform === 'darwin') {
      // macOS 候选路径
      candidates.push(
        path.join(home, '.opencode', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
        '/opt/homebrew/bin/opencode',
        'opencode'
      );
    } else {
      // Linux 候选路径
      candidates.push(
        path.join(home, '.opencode', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
        '/usr/bin/opencode',
        'opencode'
      );
    }

    // 检查哪个路径存在
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          console.log('[OpenCode] 找到 CLI:', candidate);
          return candidate;
        }
      } catch (e) {
        // 继续检查下一个
      }
    }

    // 尝试从 PATH 中查找
    console.log('[OpenCode] 未找到 CLI 文件，尝试使用 PATH 中的 opencode');
    return platform === 'win32' ? 'opencode.cmd' : 'opencode';
  }

  /**
   * 检查 OpenCode 服务是否已启动
   * 使用官方 /global/health 端点
   */
  private async isServiceRunning(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/global/health`, {
        timeout: 2000
      });
      return response.status === 200 && response.data?.healthy === true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 启动 OpenCode 本地服务
   * 使用 opencode serve 命令，默认端口 4095
   */
  private async startService(): Promise<void> {
    if (this.isStarting && this.startPromise) {
      return this.startPromise;
    }

    this.isStarting = true;
    this.startPromise = new Promise((resolve, reject) => {
      console.log('[OpenCode] 正在启动本地服务，CLI 路径:', this.cliPath);

      // Windows 上执行 .cmd 文件需要 shell: true
      const isWindows = os.platform() === 'win32';
      const useShell = isWindows || this.cliPath.endsWith('.cmd') || this.cliPath.endsWith('.ps1');
      
      // 使用 opencode serve 启动 HTTP API 服务（官方文档推荐）
      // 默认监听 http://127.0.0.1:4095
      const port = '4095';
      this.process = spawn(this.cliPath, ['serve', '--port', port, '--hostname', '127.0.0.1'], {
        detached: false,
        windowsHide: true,
        shell: useShell,
        env: { ...process.env }
      });

      let output = '';
      let errorOutput = '';

      this.process.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;
        console.log('[OpenCode]', text.trim());

        // 检查输出中是否包含服务地址
        const match = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i);
        if (match) {
          this.baseUrl = match[0];
        }
      });

      this.process.stderr?.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        console.error('[OpenCode stderr]', text.trim());
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

      // 等待服务启动（轮询 /global/health）
      const checkInterval = setInterval(async () => {
        if (await this.isServiceRunning()) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          console.log('[OpenCode] 服务已启动:', this.baseUrl);
          this.isStarting = false;
          resolve();
        }
      }, 500);

      // 30秒超时
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

  /**
   * 确保服务已启动
   */
  async ensureStarted(): Promise<void> {
    if (await this.isServiceRunning()) {
      return;
    }
    await this.startService();
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  /**
   * 从消息内容中提取纯文本（兼容字符串和数组格式）
   */
  private extractTextContent(content: string | any[]): string {
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

  /**
   * 发送聊天消息
   * 使用官方 REST API：
   *   1. POST /session  -> 创建会话
   *   2. POST /session/:id/message -> 发送消息并获取回复
   * 参考: https://opencode.ai/docs/zh-cn/server/#消息
   */
  async chat(messages: Array<{ role: string; content: string | any[] }>, options: {
    model?: string;
    temperature?: number;
    stream?: boolean;
  } = {}): Promise<string> {
    await this.ensureStarted();

    // 第一步：创建新会话
    let sessionId: string;
    try {
      const sessionResp = await axios.post(
        `${this.baseUrl}/session`,
        {},
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      sessionId = sessionResp.data?.id;
      if (!sessionId) {
        throw new Error('创建会话失败：未返回 session id');
      }
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : '';
      throw new Error(`OpenCode 创建会话失败: ${err.message} ${detail}`);
    }

    // 第二步：取最后一条用户消息内容发送
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMessage) {
      throw new Error('没有用户消息可发送');
    }

    const textContent = this.extractTextContent(lastUserMessage.content);
    if (!textContent) {
      throw new Error('用户消息内容为空');
    }

    // 构建消息体（官方格式）
    const messageBody: any = {
      parts: [
        {
          type: 'text',
          text: textContent
        }
      ]
    };

    // 如果指定了模型，解析 providerID/modelID
    if (options.model && options.model !== 'auto') {
      const parts = options.model.split('/');
      if (parts.length >= 2) {
        messageBody.model = {
          providerID: parts[0],
          modelID: parts.slice(1).join('/')
        };
      }
    }

    try {
      const msgResp = await axios.post(
        `${this.baseUrl}/session/${sessionId}/message`,
        messageBody,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 120000
        }
      );

      // 官方响应格式: { info: Message, parts: Part[] }
      const parts = msgResp.data?.parts;
      if (!Array.isArray(parts)) {
        console.error('[OpenCode] 返回数据:', JSON.stringify(msgResp.data).substring(0, 300));
        throw new Error('OpenCode 返回内容为空');
      }

      // 从 parts 中提取文本内容（assistant 的回复）
      const textContent = parts
        .filter((p: any) => p.type === 'text' && p.text)
        .map((p: any) => p.text)
        .join('');

      if (!textContent) {
        console.error('[OpenCode] parts 数据:', JSON.stringify(parts).substring(0, 300));
        throw new Error('OpenCode 返回内容为空');
      }

      // 异步清理会话（不阻塞结果返回）
      axios.delete(`${this.baseUrl}/session/${sessionId}`).catch(() => {});

      return textContent;
    } catch (err: any) {
      // 清理失败的会话
      axios.delete(`${this.baseUrl}/session/${sessionId}`).catch(() => {});
      throw err;
    }
  }

  /**
   * 列出可用模型
   * 通过官方 /config/providers 接口获取所有提供商的模型列表
   */
  async listModels(): Promise<string[]> {
    await this.ensureStarted();

    try {
      // 使用官方 GET /config/providers 接口
      const response = await axios.get(`${this.baseUrl}/config/providers`, {
        timeout: 10000
      });

      // 官方响应格式: { providers: Provider[], default: { [key: string]: string } }
      const payload = response.data?.data || response.data || {};
      const providers = Array.isArray(payload.providers) ? payload.providers :
                       Array.isArray(payload) ? payload : [];
      
      const models: string[] = [];
      
      for (const provider of providers) {
        const providerID = String(provider?.id || '').trim();
        if (!providerID) continue;
        
        const providerModels = provider.models;
        if (Array.isArray(providerModels)) {
          // 模型是数组格式
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
          // 模型是对象格式（key-value）
          for (const key of Object.keys(providerModels)) {
            if (key.trim()) {
              models.push(`${providerID}/${key.trim()}`);
            }
          }
        }
      }
      
      // 去重并排序
      return [...new Set(models)].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      console.error('[OpenCode] 获取模型列表失败:', e);
      // 返回默认的免费模型列表
      return [
        'opencode/mimo-v2-omni-free',
        'opencode/mimo-v2-pro-free',
        'opencode/minimax-m2.5-free',
        'opencode/nemotron-3-super-free',
        'opencode/big-pickle',
        'opencode/gpt-5-nano'
      ];
    }
  }

  /**
   * 获取 OpenCode 免费模型列表（硬编码，作为备用）
   */
  getDefaultFreeModels(): string[] {
    return [
      'opencode/mimo-v2-omni-free',
      'opencode/mimo-v2-pro-free', 
      'opencode/minimax-m2.5-free',
      'opencode/nemotron-3-super-free',
      'opencode/big-pickle',
      'opencode/gpt-5-nano'
    ];
  }
}

// 单例实例
let clientInstance: OpenCodeClient | null = null;

export function getOpenCodeClient(cliPath?: string): OpenCodeClient {
  if (!clientInstance) {
    clientInstance = new OpenCodeClient(cliPath);
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
 * 检测 OpenCode CLI 是否已安装，返回检测到的路径
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
  
  // 检查文件是否存在
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { found: true, path: candidate, message: '检测到 OpenCode CLI' };
    }
  }
  
  // 尝试使用 which/where 命令查找
  try {
    const { execSync } = require('child_process');
    const cmd = platform === 'win32' ? 'where opencode' : 'which opencode';
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const foundPath = result.trim().split('\n')[0];
    if (foundPath && fs.existsSync(foundPath)) {
      return { found: true, path: foundPath, message: '检测到 OpenCode CLI' };
    }
  } catch {
    // 命令执行失败，继续返回未找到
  }
  
  return { found: false, path: '', message: '未检测到 OpenCode CLI，请先安装：npm install -g opencode-ai' };
}
