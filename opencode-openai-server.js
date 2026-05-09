"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIServer = void 0;
const express_1 = __importDefault(require("express"));
const opencode_client_1 = require("./opencode-client");
const TOOL_CALL_OPEN_TAG = '<tool_call]';
const TOOL_CALL_CLOSE_TAG = '[/tool_call>';
// ==================== 服务器 ====================
class OpenAIServer {
    constructor(options = {}) {
        this.port = options.port || 4094;
        this.hostname = options.hostname || '127.0.0.1';
        this.app = (0, express_1.default)();
        this.openCodeClient = new opencode_client_1.OpenCodeClient({
            cliPath: options.cliPath,
            opencodePort: options.opencodePort,
            username: options.username,
            password: options.password,
        });
        this.setupMiddleware(options.corsOrigins || []);
        this.setupRoutes();
    }
    setupMiddleware(corsOrigins) {
        this.app.use(express_1.default.json({ limit: '10mb' }));
        this.app.use((req, res, next) => {
            const origin = req.headers.origin;
            if (origin && corsOrigins.length > 0) {
                if (corsOrigins.includes(origin) || corsOrigins.includes('*')) {
                    res.header('Access-Control-Allow-Origin', origin);
                }
            }
            else {
                res.header('Access-Control-Allow-Origin', '*');
            }
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            }
            else {
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
    setupRoutes() {
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
    async healthCheck(req, res) {
        try {
            const isRunning = await this.openCodeClient.isServiceRunning();
            res.json({
                status: isRunning ? 'ok' : 'degraded',
                service: 'OpenAI-compatible OpenCode API',
                opencode: isRunning ? 'connected' : 'disconnected',
                opencodeUrl: this.openCodeClient.getBaseUrl(),
            });
        }
        catch {
            res.json({
                status: 'degraded',
                service: 'OpenAI-compatible OpenCode API',
                opencode: 'unknown',
            });
        }
    }
    async openCodeHealth(req, res) {
        try {
            const health = await this.openCodeClient.getHealth();
            res.json(health);
        }
        catch (error) {
            res.status(502).json({ error: { message: `OpenCode \u540E\u7AEF\u4E0D\u53EF\u7528: ${error.message}` } });
        }
    }
    // ==================== 模型列表 ====================
    async listModels(req, res) {
        try {
            const models = await this.openCodeClient.listModels();
            const response = {
                object: 'list',
                data: models.map(modelId => ({
                    id: modelId,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'opencode',
                })),
            };
            res.json(response);
        }
        catch (error) {
            console.error('[OpenAI Server] \u83B7\u53D6\u6A21\u578B\u5217\u8868\u5931\u8D25:', error.message);
            res.status(500).json({
                error: { message: `Failed to list models: ${error.message}`, type: 'server_error', code: 'internal_error' },
            });
        }
    }
    async getModel(req, res) {
        try {
            const { model } = req.params;
            const models = await this.openCodeClient.listModels();
            const found = models.find(m => m === model);
            if (found) {
                res.json({ id: model, object: 'model', created: Date.now(), owned_by: 'opencode' });
            }
            else {
                res.status(404).json({
                    error: { message: `Model '${model}' not found`, type: 'invalid_request_error', code: 'model_not_found' },
                });
            }
        }
        catch (error) {
            res.status(500).json({
                error: { message: `Failed to get model: ${error.message}`, type: 'server_error', code: 'internal_error' },
            });
        }
    }
    // ==================== Chat Completions ====================
    async chatCompletions(req, res) {
        const { model, messages, stream = false, tools, tool_choice, n = 1, stop, response_format, seed, logprobs: requestLogprobs, top_logprobs, stream_options, max_completion_tokens, } = req.body;
        // 调试日志：查看 Trae 发送的完整请求内容
        console.log(`[Debug] ========== 新请求 ==========`);
        console.log(`[Debug] model: ${model}, stream: ${stream}, n: ${n}`);
        console.log(`[Debug] tool_choice: ${JSON.stringify(tool_choice)}`);
        if (tools && tools.length > 0) {
            console.log(`[Debug] tools 数量: ${tools.length}`);
            for (const tool of tools) {
                console.log(`[Debug] tool: ${JSON.stringify(tool, null, 2).substring(0, 500)}`);
            }
        }
        const systemMsg = messages.find(m => m.role === 'system');
        if (systemMsg) {
            const sysContent = typeof systemMsg.content === 'string'
                ? systemMsg.content.substring(0, 500)
                : JSON.stringify(systemMsg.content).substring(0, 500);
            console.log(`[Debug] System msg: ${sysContent}...`);
        }
        // 打印所有消息的角色和类型
        console.log(`[Debug] 消息历史 (${messages.length} 条):`);
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const contentPreview = typeof msg.content === 'string'
                ? msg.content.substring(0, 80).replace(/\n/g, '\\n')
                : (msg.content ? `[${typeof msg.content}]` : 'null');
            const toolCallsInfo = msg.tool_calls ? ` [tool_calls: ${msg.tool_calls.length}]` : '';
            const toolCallIdInfo = msg.tool_call_id ? ` [tool_call_id: ${msg.tool_call_id}]` : '';
            const nameInfo = msg.name ? ` [name: ${msg.name}]` : '';
            console.log(`[Debug]   [${i}] ${msg.role}${toolCallsInfo}${toolCallIdInfo}${nameInfo}: ${contentPreview}...`);
        }
        console.log(`[Debug] =============================`);
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
            const response = {
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
        // 调试：打印处理后的消息
        console.log(`[Debug] 处理后的消息 (${processedMessages.length} 条):`);
        for (let i = 0; i < processedMessages.length; i++) {
            const msg = processedMessages[i];
            const contentPreview = typeof msg.content === 'string'
                ? msg.content.substring(0, 100).replace(/\n/g, '\\n')
                : (msg.content ? `[${typeof msg.content}]` : 'null');
            console.log(`[Debug]   [${i}] ${msg.role}: ${contentPreview}...`);
        }
        if (response_format && (response_format.type === 'json_object' || response_format.type === 'json_schema')) {
            const jsonInstruction = response_format.type === 'json_schema' && response_format.json_schema
                ? `You must respond with a JSON object that conforms to the following schema:\n${JSON.stringify(response_format.json_schema.schema || {}, null, 2)}`
                : 'You must respond with a valid JSON object. Do not include any text outside the JSON object.';
            const existingSystem = processedMessages.find(m => m.role === 'system');
            if (existingSystem) {
                const systemContent = typeof existingSystem.content === 'string'
                    ? existingSystem.content
                    : this.extractTextFromContent(existingSystem.content);
                processedMessages = processedMessages.map(m => m.role === 'system' ? { ...m, content: `${systemContent}\n\n${jsonInstruction}` } : m);
            }
            else {
                processedMessages = [{ role: 'system', content: jsonInstruction }, ...processedMessages];
            }
        }
        try {
            if (stream) {
                await this.streamChatCompletion(req, res, completionId, created, model, processedMessages, tools, stream_options?.include_usage, systemFingerprint);
            }
            else {
                const openCodeTools = processedMessages.openCodeTools || {};
                const result = await this.openCodeClient.chat(processedMessages, { model, tools: openCodeTools });
                const parsedToolCalls = tools ? this.parseToolCallsFromResponse(result.content) : null;
                const numChoices = Math.min(n, 1);
                if (parsedToolCalls && parsedToolCalls.length > 0) {
                    const response = {
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
                }
                else {
                    const response = {
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
        }
        catch (error) {
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
    async streamChatCompletion(req, res, completionId, created, model, messages, tools, includeUsage, systemFingerprint) {
        if (tools && tools.length > 0) {
            await this.streamChatWithToolSupport(req, res, completionId, created, model, messages, tools, includeUsage, systemFingerprint);
        }
        else {
            try {
                await this.streamChatViaSSE(req, res, completionId, created, model, messages, undefined, includeUsage, systemFingerprint);
            }
            catch (sseError) {
                console.warn('[OpenAI Server] SSE \u6D41\u5F0F\u5931\u8D25\uFF0C\u56DE\u9000\u5230\u4F2A\u6D41\u5F0F:', sseError.message);
                if (!res.headersSent) {
                    await this.streamChatFallback(req, res, completionId, created, model, messages, undefined, includeUsage, systemFingerprint);
                }
            }
        }
    }
    async streamChatViaSSE(req, res, completionId, created, model, messages, tools, includeUsage, systemFingerprint) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        const fp = systemFingerprint || `fp_${this.hashString(model).substr(0, 12)}`;
        const roleChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            system_fingerprint: fp,
            choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
        let fullText = '';
        await this.openCodeClient.chatStream(messages, {
            onChunk: (delta) => {
                fullText += delta;
                const chunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    system_fingerprint: fp,
                    choices: [{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            },
            onReasoning: (delta) => {
                const chunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    system_fingerprint: fp,
                    choices: [{ index: 0, delta: { reasoning_content: delta }, logprobs: null, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            },
        }, { model, tools: messages.openCodeTools || {} });
        const finalChunk = {
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
    async streamChatWithToolSupport(req, res, completionId, created, model, messages, tools, includeUsage, systemFingerprint) {
        const fp = systemFingerprint || `fp_${this.hashString(model).substr(0, 12)}`;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        const roleChunk = {
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
        try {
            await this.openCodeClient.chatStream(messages, {
                onChunk: (delta) => {
                    fullText += delta;
                    const chunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        system_fingerprint: fp,
                        choices: [{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }],
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                },
                onReasoning: (delta) => {
                    fullReasoning += delta;
                    const chunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        system_fingerprint: fp,
                        choices: [{ index: 0, delta: { reasoning_content: delta }, logprobs: null, finish_reason: null }],
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                },
            }, { model, tools: messages.openCodeTools || {} });
        }
        finally {
            clearInterval(keepAliveInterval);
        }
        const parsedToolCalls = this.parseToolCallsFromResponse(fullText);
        if (parsedToolCalls && parsedToolCalls.length > 0) {
            for (let i = 0; i < parsedToolCalls.length; i++) {
                const tc = parsedToolCalls[i];
                const tcChunk = {
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
                                        type: 'function',
                                        function: { name: tc.function.name, arguments: tc.function.arguments },
                                    }],
                            },
                            logprobs: null,
                            finish_reason: null,
                        }],
                };
                res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
            }
            const finalChunk = {
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
        }
        else {
            if (fullReasoning) {
                const reasoningChunks = this.splitIntoChunks(fullReasoning, 10);
                for (const chunk of reasoningChunks) {
                    const data = {
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
                const data = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    system_fingerprint: fp,
                    choices: [{ index: 0, delta: { content: chunk }, logprobs: null, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            }
            const finalChunk = {
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
    async streamChatFallback(req, res, completionId, created, model, messages, _tools, includeUsage, systemFingerprint) {
        const result = await this.openCodeClient.chat(messages, { model });
        const fp = systemFingerprint || `fp_${this.hashString(model).substr(0, 12)}`;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        const roleChunk = {
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
                const data = {
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
            const data = {
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
        const finalChunk = {
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
    async completions(req, res) {
        const { model, prompt, stream = false } = req.body;
        if (!model || !prompt) {
            res.status(400).json({
                error: { message: 'Missing required fields: model, prompt', type: 'invalid_request_error', code: 'invalid_parameter' },
            });
            return;
        }
        const completionId = `cmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const created = Math.floor(Date.now() / 1000);
        try {
            const messages = Array.isArray(prompt)
                ? prompt.map(p => ({ role: 'user', content: p }))
                : [{ role: 'user', content: prompt }];
            if (stream) {
                await this.streamCompletion(req, res, completionId, created, model, messages);
            }
            else {
                const result = await this.openCodeClient.chat(messages, { model });
                const response = {
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
        }
        catch (error) {
            console.error('[OpenAI Server] Completion \u5931\u8D25:', error.message);
            if (!res.headersSent) {
                res.status(500).json({
                    error: { message: `Completion failed: ${error.message}`, type: 'server_error', code: 'internal_error' },
                });
            }
        }
    }
    async streamCompletion(req, res, completionId, created, model, messages) {
        try {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            await this.openCodeClient.chatStream(messages, {
                onChunk: (delta) => {
                    const chunk = {
                        id: completionId,
                        object: 'text_completion.chunk',
                        created,
                        model,
                        choices: [{ index: 0, text: delta, finish_reason: null }],
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                },
            }, { model });
            const finalChunk = {
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
        catch (sseError) {
            if (!res.headersSent) {
                console.warn('[OpenAI Server] \u6D41\u5F0F Completion \u5931\u8D25\uFF0C\u56DE\u9000\u5230\u4F2A\u6D41\u5F0F:', sseError.message);
                await this.streamCompletionFallback(req, res, completionId, created, model, messages);
            }
            else {
                res.write(`data: ${JSON.stringify({ error: { message: `Stream failed: ${sseError.message}` } })}\n\n`);
                res.end();
            }
        }
    }
    async streamCompletionFallback(req, res, completionId, created, model, messages) {
        const result = await this.openCodeClient.chat(messages, { model });
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        const chunks = this.splitIntoChunks(result.content, 10);
        for (const chunk of chunks) {
            const data = {
                id: completionId,
                object: 'text_completion.chunk',
                created,
                model,
                choices: [{ index: 0, text: chunk, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            await this.delay(30);
        }
        const finalChunk = {
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
    async listAgents(req, res) {
        try {
            const agents = await this.openCodeClient.listAgents();
            res.json(agents);
        }
        catch (error) {
            res.status(502).json({ error: { message: `\u83B7\u53D6\u4EE3\u7406\u5217\u8868\u5931\u8D25: ${error.message}` } });
        }
    }
    async getConfig(req, res) {
        try {
            const config = await this.openCodeClient.getConfig();
            res.json(config);
        }
        catch (error) {
            res.status(502).json({ error: { message: `\u83B7\u53D6\u914D\u7F6E\u5931\u8D25: ${error.message}` } });
        }
    }
    // ==================== 工具调用核心方法 ====================
    mapTraeToolsToOpenCode(tools) {
        const openCodeTools = {};
        for (const tool of tools) {
            const toolName = tool.function.name.toLowerCase();
            // Trae 工具名称映射到 OpenCode 内置工具
            if (toolName.includes('read') || toolName.includes('file')) {
                openCodeTools.read = true;
            }
            else if (toolName.includes('write') || toolName.includes('edit')) {
                openCodeTools.write = true;
            }
            else if (toolName.includes('search') || toolName.includes('grep')) {
                openCodeTools.codesearch = true;
            }
            else if (toolName.includes('glob') || toolName.includes('find')) {
                openCodeTools.glob = true;
            }
            else if (toolName.includes('web') || toolName.includes('search')) {
                openCodeTools.websearch = true;
            }
            else if (toolName.includes('fetch') || toolName.includes('download')) {
                openCodeTools.webfetch = true;
            }
            else if (toolName.includes('weather')) {
                openCodeTools.websearch = true; // 用 websearch 获取天气信息
            }
            else if (toolName.includes('task') || toolName.includes('agent')) {
                openCodeTools.task = true;
            }
            else if (toolName.includes('todo') || toolName.includes('tasklist')) {
                openCodeTools.todowrite = true;
            }
            else {
                // 默认启用 websearch
                openCodeTools.websearch = true;
            }
        }
        return openCodeTools;
    }
    prepareMessagesWithTools(messages, tools, toolChoice) {
        const processed = [];
        const hasToolRelatedMessages = messages.some(m => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0));
        // 移除工具系统提示词注入，改为通过 OpenCode 的 tools 参数传递
        const existingSystem = messages.find(m => m.role === 'system');
        if (existingSystem) {
            processed.push({
                role: 'system',
                content: typeof existingSystem.content === 'string'
                    ? existingSystem.content
                    : this.extractTextFromContent(existingSystem.content),
            });
        }
        // 存储工具映射到消息的属性中，供后续使用
        processed.openCodeTools = tools ? this.mapTraeToolsToOpenCode(tools) : {};
        for (const msg of messages) {
            // 移除 system 消息的跳过逻辑，因为不再注入工具提示词
            if (msg.role === 'system') {
                continue;
            }
            // 处理 assistant 的 tool_calls — 始终处理（包括 Trae 内置工具场景）
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                let content = '';
                if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    content = msg.content + '\n\n';
                }
                for (const tc of msg.tool_calls) {
                    content += `${TOOL_CALL_OPEN_TAG}\n{"name": "${tc.function.name}", "arguments": ${tc.function.arguments}}\n${TOOL_CALL_CLOSE_TAG}\n`;
                }
                processed.push({ role: 'assistant', content });
            }
            else if (msg.role === 'tool') {
                // 处理 tool 结果 — 始终处理（包括 Trae 内置工具场景）
                const toolCallId = msg.tool_call_id || 'unknown';
                const toolName = msg.name || 'unknown';
                const resultContent = typeof msg.content === 'string'
                    ? msg.content
                    : this.extractTextFromContent(msg.content);
                processed.push({
                    role: 'user',
                    content: `[Tool Result for ${toolName} (id: ${toolCallId})]:\n${resultContent}`,
                });
            }
            else {
                processed.push({ ...msg });
            }
        }
        return processed;
    }
    extractTextFromContent(content) {
        if (!content)
            return '';
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('');
        }
        return String(content);
    }
    parseToolCallsFromResponse(content) {
        const toolCalls = [];
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
            }
            catch (e) {
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
                }
                catch {
                    // not valid JSON, skip
                }
            }
        }
        return toolCalls.length > 0 ? toolCalls : null;
    }
    extractTextOutsideToolCalls(content) {
        const openEscaped = TOOL_CALL_OPEN_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const closeEscaped = TOOL_CALL_CLOSE_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${openEscaped}[\\s\\S]*?${closeEscaped}`, 'g');
        let text = content.replace(regex, '').trim();
        text = text.replace(/```(?:json)?\s*\n?\{"name":\s*"[^"]+",\s*"arguments":\s*\{[\s\S]*?\}\s*\}\n?```/g, '').trim();
        return text || '';
    }
    // ==================== 通用工具方法 ====================
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }
    splitIntoChunks(text, chunkSize) {
        const chunks = [];
        for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push(text.slice(i, i + chunkSize));
        }
        return chunks;
    }
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    estimateTokens(messages) {
        const text = messages.map(m => {
            if (typeof m.content === 'string')
                return m.content;
            if (m.content)
                return JSON.stringify(m.content);
            return '';
        }).join(' ');
        return Math.ceil(text.length / 4);
    }
    // ==================== 启动/停止 ====================
    async start() {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.port, this.hostname, () => {
                console.log(`[OpenAI Server] \u670D\u52A1\u5DF2\u542F\u52A8: http://${this.hostname}:${this.port}`);
                console.log(`[OpenAI Server] \u5065\u5EB7\u68C0\u67E5: http://${this.hostname}:${this.port}/health`);
                console.log(`[OpenAI Server] \u6A21\u578B\u5217\u8868: http://${this.hostname}:${this.port}/v1/models`);
                console.log(`[OpenAI Server] OpenCode \u540E\u7AEF: ${this.openCodeClient.getBaseUrl()}`);
                resolve();
            });
            this.server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    reject(new Error(`\u7AEF\u53E3 ${this.port} \u5DF2\u88AB\u5360\u7528`));
                }
                else {
                    reject(error);
                }
            });
        });
    }
    async stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('[OpenAI Server] \u670D\u52A1\u5DF2\u505C\u6B62');
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
}
exports.OpenAIServer = OpenAIServer;
