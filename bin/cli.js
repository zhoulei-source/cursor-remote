#!/usr/bin/env node

import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(homedir(), '.cursor-remote');
const CONFIG_FILE = join(CONFIG_DIR, 'config.env');

// ─── 帮助信息 ───────────────────────────────────────
const HELP = `
Cursor Remote — 通过 IM 远程控制本地 Cursor Agent

用法:
  cursor-remote <命令> [选项]

命令:
  init                交互式初始化配置
  start               启动服务（默认命令）
  config              查看当前配置路径和状态

选项:
  --project=<路径>    设置默认项目路径
  --env=<路径>        指定配置文件路径（默认 ~/.cursor-remote/config.env）
  --debug             开启调试日志
  -h, --help          显示帮助信息
  -v, --version       显示版本号

快速开始:
  1. npm i -g cursor-remote
  2. cursor-remote init
  3. cursor-remote start

目前支持的 IM 平台:
  • 飞书 / Lark

飞书应用配置指南:
  1. 访问 https://open.feishu.cn 创建企业自建应用
  2. 启用「机器人」能力
  3. 事件订阅 → 选择「使用长连接接收事件」
  4. 添加事件: im.message.receive_v1
  5. 配置权限: im:message、im:message:send_as_bot、im:chat
  6. 发布应用，获取 App ID 和 App Secret
`;

// ─── 工具函数 ───────────────────────────────────────
function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

// ─── init 命令 ───────────────────────────────────────
async function cmdInit() {
  console.log('\n🚀 Cursor Remote - 初始化配置\n');

  // 检查是否已有配置
  if (existsSync(CONFIG_FILE)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = await ask(rl, '已存在配置文件，是否覆盖? (y/N)', 'N');
    if (overwrite.toLowerCase() !== 'y') {
      console.log(`\n配置文件位置: ${CONFIG_FILE}`);
      console.log('使用 cursor-remote start 启动服务\n');
      rl.close();
      return;
    }
    rl.close();
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('目前支持的 IM 平台: 飞书\n');
  console.log('请在飞书开放平台 (https://open.feishu.cn) 创建应用后填写以下信息:\n');

  const appId = await ask(rl, '飞书 App ID');
  const appSecret = await ask(rl, '飞书 App Secret');

  if (!appId || !appSecret) {
    console.error('\n❌ App ID 和 App Secret 为必填项');
    rl.close();
    process.exit(1);
  }

  const defaultProject = await ask(rl, '默认项目路径', homedir());
  const cursorAgentPath = await ask(rl, 'cursor-agent 路径（留空自动检测）', '');
  const logLevel = await ask(rl, '日志级别 (debug/info/warn/error)', 'info');

  rl.close();

  // 生成配置文件
  const envContent = [
    '# Cursor Remote 配置',
    `# 生成时间: ${new Date().toLocaleString()}`,
    '',
    '# IM 平台（目前支持: feishu）',
    'IM_PLATFORM=feishu',
    '',
    '# 飞书应用凭证',
    `FEISHU_APP_ID=${appId}`,
    `FEISHU_APP_SECRET=${appSecret}`,
    '',
    '# 默认项目目录',
    `DEFAULT_PROJECT_PATH=${defaultProject}`,
    '',
    '# cursor-agent 路径（留空自动检测）',
    cursorAgentPath ? `CURSOR_AGENT_PATH=${cursorAgentPath}` : '# CURSOR_AGENT_PATH=',
    '',
    '# 日志级别',
    `LOG_LEVEL=${logLevel}`,
    '',
    '# 流式推送间隔（毫秒）',
    'STREAM_PUSH_INTERVAL=3000',
    '',
    '# 任务超时（毫秒，默认 10 分钟）',
    'TASK_TIMEOUT=600000',
    '',
  ].join('\n');

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, envContent, 'utf-8');

  console.log(`\n✅ 配置已保存到 ${CONFIG_FILE}`);
  console.log('\n下一步:');
  console.log('  cursor-remote start          启动服务');
  console.log('  cursor-remote start --debug   调试模式启动\n');
}

// ─── config 命令 ─────────────────────────────────────
function cmdConfig() {
  console.log(`\n配置目录: ${CONFIG_DIR}`);
  console.log(`配置文件: ${CONFIG_FILE}`);
  console.log(`状态: ${existsSync(CONFIG_FILE) ? '✅ 已配置' : '❌ 未配置（请先运行 cursor-remote init）'}`);

  if (existsSync(CONFIG_FILE)) {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const lines = content.split('\n').filter((l) => l && !l.startsWith('#'));
    console.log('\n当前配置:');
    for (const line of lines) {
      const [key, ...rest] = line.split('=');
      const value = rest.join('=');
      // 隐藏敏感信息
      if (key === 'FEISHU_APP_SECRET') {
        console.log(`  ${key}=${value.slice(0, 4)}****`);
      } else {
        console.log(`  ${key}=${value}`);
      }
    }
  }
  console.log('');
}

// ─── start 命令 ──────────────────────────────────────
async function cmdStart() {
  // 确定 .env 路径优先级: --env 参数 > ~/.cursor-remote/config.env > 当前目录 .env
  const envArg = process.argv.find((a) => a.startsWith('--env='));
  let envPath;

  if (envArg) {
    envPath = resolve(envArg.split('=')[1]);
  } else if (existsSync(CONFIG_FILE)) {
    envPath = CONFIG_FILE;
  }

  if (envPath) {
    process.env.DOTENV_CONFIG_PATH = envPath;
  }

  // 命令行参数覆盖
  const projectArg = process.argv.find((a) => a.startsWith('--project='));
  if (projectArg) {
    process.env.DEFAULT_PROJECT_PATH = resolve(projectArg.split('=')[1]);
  }

  if (process.argv.includes('--debug')) {
    process.env.LOG_LEVEL = 'debug';
  }

  // 检查配置是否存在
  if (!envPath && !process.env.FEISHU_APP_ID) {
    console.error('❌ 未找到配置文件，请先运行: cursor-remote init\n');
    process.exit(1);
  }

  // 启动主程序
  await import(resolve(__dirname, '..', 'dist', 'index.js'));
}

// ─── 主入口 ──────────────────────────────────────────
const command = process.argv[2];

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(getVersion());
  process.exit(0);
}

switch (command) {
  case 'init':
    cmdInit();
    break;
  case 'config':
    cmdConfig();
    break;
  case 'start':
  case undefined:
    cmdStart();
    break;
  default:
    // 没有匹配的子命令，当作 start 处理（兼容 --project 等直接用法）
    if (command?.startsWith('--')) {
      cmdStart();
    } else {
      console.error(`未知命令: ${command}\n运行 cursor-remote --help 查看帮助`);
      process.exit(1);
    }
}
