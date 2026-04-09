# OpenAI 兼容的 OpenCode API 服务器

将 OpenCode 本地服务转换为 OpenAI 兼容的 REST API，支持所有主要的 OpenAI API 端点。

## 功能特性

- ✅ 完全兼容 OpenAI API 格式
- ✅ 支持所有主要端点：
  - `POST /v1/chat/completions` - 对话补全（支持流式）
  - `GET /v1/models` - 列出可用模型
  - `POST /v1/completions` - 文本补全
- ✅ 支持流式响应（SSE）
- ✅ 自动模型映射
- ✅ CORS 支持
- ✅ 错误处理和日志记录

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
# 使用默认端口 4094
npm start

# 使用自定义端口
npm run dev -- -p 8080

# 指定 OpenCode CLI 路径
npm run dev -- -c /path/to/opencode
```

### 服务端点

启动后，服务将在 `http://127.0.0.1:4094` 上运行：

- **健康检查**: `GET http://127.0.0.1:4094/health`
- **模型列表**: `GET http://127.0.0.1:4094/v1/models`
- **对话补全**: `POST http://127.0.0.1:4094/v1/chat/completions`
- **文本补全**: `POST http://127.0.0.1:4094/v1/completions`

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

### 4. 文本补全

```bash
curl -X POST http://127.0.0.1:4094/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "prompt": "你好，请用一句话介绍你自己",
    "temperature": 0.7
  }'
```

## 使用 OpenAI SDK

由于 API 完全兼容 OpenAI 格式，你可以直接使用 OpenAI 官方 SDK：

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

服务会自动从 OpenCode 获取可用模型列表，常见的免费模型包括：

- `opencode/gpt-5-nano`
- `opencode/mimo-v2-omni-free`
- `opencode/mimo-v2-pro-free`
- `opencode/minimax-m2.5-free`
- `opencode/nemotron-3-super-free`
- `opencode/big-pickle`

## 命令行参数

```bash
opencode-openai-server [options]

选项:
  -p, --port <number>    服务器端口 (默认: 4094)
  -c, --cli-path <path>  OpenCode CLI 路径 (默认: 自动检测)
  -h, --help             显示帮助信息
```

## 技术架构

- **服务器**: Express.js
- **客户端**: 复用现有的 OpenCodeClient 类
- **语言**: TypeScript
- **端口**: 默认 4094
- **OpenCode 端口**: 4095

## 文件结构

```
opencode/
├── opencode-client.ts              # OpenCode 原始客户端
├── opencode-openai-server.ts       # OpenAI 兼容服务器
├── opencode-openai-server-cli.ts   # CLI 启动脚本
├── package.json                    # 项目配置
├── tsconfig.json                   # TypeScript 配置
└── README.md                       # 本文件
```

## 注意事项

1. 确保 OpenCode CLI 已正确安装并可用
2. 服务启动时会自动启动 OpenCode 本地服务
3. 默认使用端口 4094，确保端口未被占用
4. 流式响应使用 SSE (Server-Sent Events) 格式
5. 不需要真实的 API key，可以使用任意字符串

## 故障排除

### 端口被占用

如果端口 4094 被占用，使用其他端口：

```bash
npm start -- -p 8080
```

### OpenCode CLI 未找到

如果自动检测失败，手动指定 CLI 路径：

```bash
npm start -- -c /path/to/opencode
```

### 服务启动失败

1. 检查 OpenCode CLI 是否已安装：`npm install -g opencode-ai`
2. 检查端口是否被占用
3. 查看日志输出获取详细错误信息

## 许可证

MIT
