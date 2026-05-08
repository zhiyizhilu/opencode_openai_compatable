#!/usr/bin/env node

import { OpenAIServer } from './opencode-openai-server';
import { Command } from 'commander';
import * as fs from 'fs';

const program = new Command();

program
  .name('opencode-openai-server')
  .description('OpenAI 兼容的 OpenCode API 服务器')
  .version('2.0.0')
  .option('-p, --port <number>', 'OpenAI 兼容服务端口（对外）', '4094')
  .option('-H, --hostname <string>', '监听主机名', '127.0.0.1')
  .option('--opencode-port <number>', 'OpenCode 原生服务端口（对内）', '4095')
  .option('-c, --cli-path <path>', 'OpenCode CLI 路径（默认自动检测）')
  .option('--cors <origins>', '额外允许的浏览器来源（逗号分隔，可多次使用）', collectCors, [])
  .option('--username <string>', 'OpenCode 服务器认证用户名')
  .option('--password <string>', 'OpenCode 服务器认证密码')
  .parse(process.argv);

function collectCors(value: string, previous: string[]): string[] {
  // 支持逗号分隔和多次传递
  const origins = value.split(',').map(s => s.trim()).filter(Boolean);
  return previous.concat(origins);
}

const options = program.opts();

async function main() {
  const port = parseInt(options.port, 10);
  const hostname = options.hostname || '127.0.0.1';
  const opencodePort = parseInt(options.opencodePort, 10);
  const cliPath = options.cliPath;
  const corsOrigins: string[] = options.cors || [];
  const username = options.username || process.env.OPENCODE_SERVER_USERNAME || '';
  const password = options.password || process.env.OPENCODE_SERVER_PASSWORD || '';

  // 参数校验
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('错误: OpenAI 兼容服务端口号必须是 1-65535 之间的数字');
    process.exit(1);
  }

  if (isNaN(opencodePort) || opencodePort < 1 || opencodePort > 65535) {
    console.error('错误: OpenCode 原生服务端口号必须是 1-65535 之间的数字');
    process.exit(1);
  }

  if (port === opencodePort) {
    console.error('错误: OpenAI 兼容端口和 OpenCode 原生端口不能相同');
    process.exit(1);
  }

  if (cliPath && !fs.existsSync(cliPath)) {
    console.error(`错误: OpenCode CLI 路径不存在: ${cliPath}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('OpenAI 兼容的 OpenCode API 服务器 v2.0');
  console.log('='.repeat(60));
  console.log(`OpenAI 兼容端口:  ${port} (${hostname})`);
  console.log(`OpenCode 原生端口: ${opencodePort}`);
  console.log(`CLI 路径:          ${cliPath || '自动检测'}`);
  console.log(`CORS 来源:         ${corsOrigins.length > 0 ? corsOrigins.join(', ') : '允许所有'}`);
  console.log(`认证:              ${password ? '已启用 (用户: ' + (username || 'opencode') + ')' : '未启用'}`);
  console.log('='.repeat(60));
  console.log();

  const server = new OpenAIServer({
    port,
    hostname,
    opencodePort,
    cliPath,
    corsOrigins,
    username,
    password,
  });

  try {
    await server.start();

    process.on('SIGINT', async () => {
      console.log('\n正在停止服务器...');
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n正在停止服务器...');
      await server.stop();
      process.exit(0);
    });

  } catch (error: any) {
    console.error('服务器启动失败:', error.message);
    process.exit(1);
  }
}

main();
