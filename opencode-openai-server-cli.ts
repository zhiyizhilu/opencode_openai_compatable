#!/usr/bin/env node

import { OpenAIServer } from './opencode-openai-server';
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';

const program = new Command();

program
  .name('opencode-openai-server')
  .description('OpenAI 兼容的 OpenCode API 服务器')
  .version('1.0.0')
  .option('-p, --port <number>', '服务器端口', '4094')
  .option('-c, --cli-path <path>', 'OpenCode CLI 路径')
  .option('-h, --help', '显示帮助信息')
  .parse(process.argv);

const options = program.opts();

async function main() {
  const port = parseInt(options.port, 10);
  const cliPath = options.cliPath;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('错误: 端口号必须是 1-65535 之间的数字');
    process.exit(1);
  }

  if (cliPath && !fs.existsSync(cliPath)) {
    console.error(`错误: OpenCode CLI 路径不存在: ${cliPath}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('OpenAI 兼容的 OpenCode API 服务器');
  console.log('='.repeat(60));
  console.log(`端口: ${port}`);
  console.log(`CLI 路径: ${cliPath || '自动检测'}`);
  console.log('='.repeat(60));
  console.log();

  const server = new OpenAIServer(port, cliPath);

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
