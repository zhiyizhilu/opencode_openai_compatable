# OpenAI 兼容的 OpenCode API 服务器 v2.0

将 OpenCode 本地服务转换为 OpenAI 兼容的 REST API，支持所有主要的 OpenAI API 端点。

## 功能特性

- 完全兼容 OpenAI API 格式
- 支持所有主要端点：
  - `POST /v1/chat/completions` - 对话补全（支持流式）
  - `GET /v1/models` - 列出可用模型
  - `GET /v1/models/:model` - 获取模型详情
  - `POST /v1/completions` - 文本补全（支持流式）
- **真正的流式响应**：通过 OpenCode 的 SSE 事件流实现实时推送，SSE 失败时自动回退到伪流式
- **Tool/Function Calling**：支持 OpenAI 格式的 `tools` 和 `tool_choice` 参数（`none` / `auto` / `required` / 指定函数），通过 `«tool_call»` / `«/tool_call»` 标签实现工具调用协议
- **思考链（Reasoning）内容**：支持 `reasoning_content` 字段，在流式和非流式响应中回传模型的思考过程
- **`response_format` 支持**：支持 `json_object` 和 `json_schema` 两种响应格式，自动注入 JSON Schema 指令到系统消息
- **多模态消息内容支持**：兼容 OpenAI 数组格式的消息内容（`content: string | any[]`），自动提取文本部分
- **Token 用量报告**：在响应中返回 `prompt_tokens`、`completion_tokens`、`total_tokens`、`reasoning_tokens`、`cached_tokens` 等用量信息；流式响应可通过 `stream_options.include_usage` 控制
- **完整 OpenAI 请求参数**：支持 `temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`stop`、`n`、`seed`、`frequency_penalty`、`presence_penalty`、`logprobs`、`top_logprobs` 等参数
- **系统指纹**：返回 `system_fingerprint` 字段，便于追踪服务端版本
- **代理选择**：支持通过 `agent` 参数选择 OpenCode 的不同代理
- **OpenCode CLI 检测**：内置 `detectOpenCodePath()` 函数，自动检测 CLI 安装路径，支持多平台
- **全局 CLI 安装**：支持通过 `npm install -g` 全局安装为命令行工具
- 支持 OpenCode 服务器认证（Basic Auth）
- 自动模型映射（通过 `GET /config/providers` 获取）
- CORS 支持
- 额外的 OpenCode 代理端点（`/opencode/health`、`/opencode/agents`、`/opencode/config`）
- 请求日志
- 错误处理和优雅降级（流式超时回退）

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
# 使用默认端口
npm start

# 使用自定义端口
npm run dev -- -p 8080

# 指定监听主机名
npm run dev -- -H 0.0.0.0

# 指定 OpenCode CLI 路径
npm run dev -- -c /path/to/opencode

# 启用认证
npm run dev -- --username admin --password mysecret
```

### 端口说明

服务采用**双端口架构**，两个端口分工明确：

| 端口 | 角色 | 说明 | 配置方式 |
|------|------|------|----------|
| **4094** | OpenAI 兼容 API（对外） | 用户直接请求的入口，提供 OpenAI 格式的 REST API。对此端口的请求会被自动翻译并转发到 OpenCode 原生服务。 | 通过 `-p` 参数修改 |
| **4095** | OpenCode 原生服务（对内） | OpenCode CLI 启动的内部 HTTP API 服务（`opencode serve --port 4095`），供端口 4094 调用。对用户透明，无需直接访问。 | 通过 `--opencode-port` 参数修改 |

**请求处理流程**：

```
用户/客户端 -> 端口 4094 (OpenAI 兼容层) --转发--> 端口 4095 (OpenCode 原生 API) --> AI 模型
                  |
                  └-- 返回 OpenAI 格式响应 <-- 翻译响应 <--------------┘
```

**流式响应流程（SSE 事件流）**：

```
用户/客户端 --stream=true--> 端口 4094
                                    |
                                    +-- 订阅 OpenCode SSE /event --> 实时接收增量文本
                                    +-- 异步发送消息 /session/:id/prompt_async
                                    |
                                    └-- 实时推送 OpenAI 格式 SSE chunks --> 用户/客户端
```

### 服务端点

OpenAI 兼容服务在端口 4094 上暴露以下端点：

- **健康检查**: `GET http://127.0.0.1:4094/health`
- **模型列表**: `GET http://127.0.0.1:4094/v1/models`
- **获取模型详情**: `GET http://127.0.0.1:4094/v1/models/:model`
- **对话补全**: `POST http://127.0.0.1:4094/v1/chat/completions`
- **文本补全**: `POST http://127.0.0.1:4094/v1/completions`

OpenCode 代理端点：

- **OpenCode 健康状态**: `GET http://127.0.0.1:4094/opencode/health`
- **代理列表**: `GET http://127.0.0.1:4094/opencode/agents`
- **配置信息**: `GET http://127.0.0.1:4094/opencode/config`

## API 使用示例

### 1. 获取模型列表

```bash
curl http://127.0.0.1:4094/v1/models
```

### 2. 对话补全（非流式）

```bash
curl -X POST http://127.0.0.1:4094/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己"}
    ],
    "temperature": 0.7
  }'
```

### 3. 对话补全（流式）

```bash
curl -X POST http://127.0.0.1:4094/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己"}
    ],
    "temperature": 0.7,
    "stream": true
  }'
```

### 4. 指定代理

```bash
curl -X POST http://127.0.0.1:4094/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "messages": [{"role": "user", "content": "分析这段代码"}],
    "agent": "code-analysis"
  }'
```

### 5. 文本补全

```bash
curl -X POST http://127.0.0.1:4094/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "prompt": "你好，请用一句话介绍你自己",
    "temperature": 0.7
  }'
```

### 6. 构建并运行测试

```bash
# 编译 TypeScript 源码
npm run build

# 启动服务器后，运行集成测试
npm test
```

## 使用 OpenAI SDK

由于 API 完全兼容 OpenAI 格式，你可以直接使用 OpenAI 官方 SDK。

### Python 示例

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:4094/v1",
    api_key="dummy"  # 不需要真实的 API key
)

response = client.chat.completions.create(
    model="opencode/gpt-5-nano",
    messages=[
        {"role": "user", "content": "你好，请用一句话介绍你自己"}
    ]
)

print(response.choices[0].message.content)
```

### JavaScript 示例

```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:4094/v1',
  apiKey: 'dummy'  // 不需要真实的 API key
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: 'opencode/gpt-5-nano',
    messages: [
      { role: 'user', content: '你好，请用一句话介绍你自己' }
    ]
  });

  console.log(completion.choices[0].message.content);
}

main();
```

## 可用模型

服务会自动从 OpenCode 获取可用模型列表，以下为常见的免费模型示例（实际列表以 OpenCode 返回为准）：

- `opencode/mimo-v2-omni-free`
- `opencode/mimo-v2-pro-free`
- `opencode/minimax-m2.5-free`
- `opencode/nemotron-3-super-free`
- `opencode/big-pickle`
- `opencode/gpt-5-nano`

## 命令行参数

```bash
opencode-openai-server [options]

选项:
  -p, --port <number>           OpenAI 兼容服务端口 (默认: 4094)
  -H, --hostname <string>       监听主机名 (默认: 127.0.0.1)
  --opencode-port <number>      OpenCode 原生服务端口 (默认: 4095)
  -c, --cli-path <path>         OpenCode CLI 路径 (默认: 自动检测)
  --cors <origins>              额外允许的浏览器来源 (逗号分隔，可多次使用)
  --username <string>           OpenCode 服务器认证用户名 (或设置 OPENCODE_SERVER_USERNAME)
  --password <string>           OpenCode 服务器认证密码 (或设置 OPENCODE_SERVER_PASSWORD)
  -h, --help                    显示帮助信息
  -V, --version                 显示版本号
```

### 认证

如果 OpenCode 服务器启用了认证，可以通过命令行参数或环境变量传递凭据：

```bash
# 方式一：命令行参数
npm start -- --username admin --password mysecret

# 方式二：环境变量
OPENCODE_SERVER_USERNAME=admin OPENCODE_SERVER_PASSWORD=mysecret npm start
```

### CORS 配置

```bash
# 允许特定来源
npm start -- --cors http://localhost:5173 --cors https://app.example.com

# 逗号分隔
npm start -- --cors "http://localhost:5173,https://app.example.com"
```

## 技术架构

- **服务器**: Express.js
- **客户端**: 通过 OpenCode 官方 REST API (`opencode serve`) 通信
- **流式响应**: 优先使用 OpenCode SSE 事件流 (`GET /event`)，失败时回退到伪流式
- **语言**: TypeScript

### 核心特性（v2.0）

基于 OpenCode 官方文档，相比 v1.0 的主要改进：

1. **真正的流式响应**：利用 OpenCode 的 SSE 事件流（`GET /event`）+ 异步消息发送（`POST /session/:id/prompt_async`），实现从 OpenCode 到客户端的实时增量文本推送
2. **认证支持**：支持 `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` 基本认证
3. **system 消息传递**：利用 OpenCode `POST /session/:id/message` 的 `system` 参数
4. **代理选择**：利用 OpenCode 的 `agent` 参数选择不同代理
5. **更多 CLI 选项**：`-H` / `--hostname`、`--opencode-port`、`--cors`、`--username`、`--password`
6. **OpenCode 代理端点**：新增 `/opencode/health`、`/opencode/agents`、`/opencode/config`
7. **优雅降级**：SSE 流式失败时自动回退到伪流式
8. **思考链内容**：支持 `reasoning_content` 在流式和非流式响应中返回模型的思考过程
9. **Tool/Function Calling 增强**：支持 `tool_choice` 的 `none` / `auto` / `required` / 指定函数四种模式
10. **`response_format` 支持**：支持 `json_object` 和 `json_schema`，自动注入 JSON Schema 指令到系统消息
11. **`max_completion_tokens`**：支持 OpenAI 新版参数名称兼容
12. **Token 用量报告**：在非流式和流式响应中报告 `prompt_tokens`、`completion_tokens`、`total_tokens`、`reasoning_tokens`；流式响应可通过 `stream_options.include_usage` 控制
13. **完整 OpenAI 参数支持**：`temperature`、`top_p`、`stop`、`n`、`seed`、`frequency_penalty`、`presence_penalty`、`logprobs`、`top_logprobs`

## 文件结构

```
opencode/
├── opencode-client.ts              # OpenCode 原生客户端（SSE 流式、认证、会话管理、模型列表）
├── opencode-openai-server.ts       # OpenAI 兼容服务器（流式 + 回退 + Tool Calling + 12 个端点）
├── opencode-openai-server-cli.ts   # CLI 启动脚本（Commander，完整参数支持）
├── test.ts                         # 集成测试脚本（8 个测试用例）
├── package.json                    # 项目配置（Express + Axios + Commander）
├── tsconfig.json                   # TypeScript 配置（ES2020、Strict）
├── start-server.bat                # Windows 启动脚本
├── 服务器 _ OpenCode.md             # OpenCode 原生服务 API 参考文档
├── dist/                           # TypeScript 编译输出（`npm run build` 生成）
│   ├── opencode-client.js / .d.ts / .js.map / .d.ts.map
│   ├── opencode-openai-server.js / .d.ts / .js.map / .d.ts.map
│   ├── opencode-openai-server-cli.js / .d.ts / .js.map / .d.ts.map
│   ├── test.js / .d.ts / .js.map / .d.ts.map
├── .gitignore                      # Git 忽略规则
└── README.md                       # 本文件
```

## 注意事项

1. 确保 OpenCode CLI 已正确安装并可用（`npm install -g opencode-ai`）
2. **端口 4094** 是对外提供 OpenAI 兼容 API 的入口；如需更改，使用 `-p` 参数
3. **端口 4095** 是 OpenCode 原生服务的内部端口（由 `opencode serve` 启动）；如需更改，使用 `--opencode-port` 参数
4. 两个端口不能相同
5. 流式响应优先使用 SSE 事件流实现真正的实时推送，失败时自动回退到伪流式
6. 不需要真实的 API key，可以使用任意字符串
7. 如果启用了 OpenCode 认证，请通过 `--username` 和 `--password` 或环境变量提供凭据
8. 消息内容支持字符串和数组两种格式，兼容 OpenAI 多模态消息结构
9. `dist/` 目录是 TypeScript 编译产物，运行集成测试前需执行 `npm run build`
10. 工具调用使用 `«tool_call»` / `«/tool_call»` 标签包裹 JSON 格式的函数调用请求

## 故障排除

### 端口被占用

如果端口 4094 被占用，使用其他端口：

```bash
npm start -- -p 8080
```

如果端口 4095 被占用，使用其他端口：

```bash
npm start -- --opencode-port 4097
```

### OpenCode CLI 未找到

如果自动检测失败，手动指定 CLI 路径：

```bash
npm start -- -c /path/to/opencode
```

### 服务启动失败

1. 检查 OpenCode CLI 是否已安装：`npm install -g opencode-ai`
2. 检查端口 4094 和 4095 是否被占用
3. 查看日志输出获取详细错误信息

### 流式响应不工作

1. 检查 OpenCode 服务是否正常运行（访问 `/opencode/health`）
2. 服务器会自动回退到伪流式模式
3. 查看 `[OpenAI Server]` 日志中是否有 SSE 相关错误

### 测试运行失败

```bash
# 确保先编译 TypeScript 源码
npm run build
# 然后运行集成测试
npm test
```

## 许可证

MIT
