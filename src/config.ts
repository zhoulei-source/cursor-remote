import { config as dotenvConfig } from 'dotenv';
import { resolve, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';

// 加载 .env 文件（优先级: CLI 指定 > ~/.feishu-cursor/config.env > 当前目录 .env）
const customEnvPath = process.env['DOTENV_CONFIG_PATH'];
const homeConfigPath = join(homedir(), '.cursor-remote', 'config.env');

if (customEnvPath && existsSync(customEnvPath)) {
  dotenvConfig({ path: customEnvPath });
} else if (existsSync(homeConfigPath)) {
  dotenvConfig({ path: homeConfigPath });
} else {
  dotenvConfig();
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少必要的环境变量: ${key}，请检查 .env 文件`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function optionalEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (isNaN(parsed)) {
    throw new Error(`环境变量 ${key} 的值不是有效的数字: ${value}`);
  }
  return parsed;
}

/** 飞书应用配置 */
export interface IFeishuConfig {
  appId: string;
  appSecret: string;
}

/** Cursor Agent 配置 */
export interface ICursorConfig {
  /** cursor-agent 二进制路径 */
  agentPath: string;
  /** 默认工作目录 */
  defaultProjectPath: string;
  /** 任务超时（毫秒） */
  taskTimeout: number;
}

/** 流式推送配置 */
export interface IStreamConfig {
  pushInterval: number;
}

/** 日志配置 */
export interface ILogConfig {
  level: string;
}

/** 安全配置 */
export interface ISecurityConfig {
  allowedUserIds: string[];
}

/** 全局配置 */
export interface IAppConfig {
  feishu: IFeishuConfig;
  cursor: ICursorConfig;
  stream: IStreamConfig;
  log: ILogConfig;
  security: ISecurityConfig;
}

function resolveCursorAgentPath(): string {
  const envPath = process.env['CURSOR_AGENT_PATH'];

  // 优先使用环境变量指定的路径
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(resolved)) return resolved;
    throw new Error(`CURSOR_AGENT_PATH 指定的路径不存在: ${resolved}`);
  }

  // 默认安装路径
  const home = homedir();
  const defaultPath = resolve(home, '.local/bin/cursor-agent');
  if (existsSync(defaultPath)) return defaultPath;

  // 尝试 PATH 中查找
  return 'cursor-agent';
}

export function loadConfig(): IAppConfig {
  const config: IAppConfig = {
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
    },
    cursor: {
      agentPath: resolveCursorAgentPath(),
      defaultProjectPath: optionalEnv('DEFAULT_PROJECT_PATH', homedir()),
      taskTimeout: optionalEnvNumber('TASK_TIMEOUT', 600_000),
    },
    stream: {
      pushInterval: optionalEnvNumber('STREAM_PUSH_INTERVAL', 3000),
    },
    log: {
      level: optionalEnv('LOG_LEVEL', 'info'),
    },
    security: {
      allowedUserIds: optionalEnv('ALLOWED_USER_IDS', '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    },
  };

  // 校验默认项目路径
  if (!existsSync(config.cursor.defaultProjectPath)) {
    throw new Error(`DEFAULT_PROJECT_PATH 不存在: ${config.cursor.defaultProjectPath}`);
  }

  return config;
}

/** 将 ALLOWED_USER_IDS 持久化写入配置文件 */
export function saveAllowedUserId(userId: string): void {
  const configPath = process.env['DOTENV_CONFIG_PATH']
    || join(homedir(), '.cursor-remote', 'config.env');

  if (!existsSync(configPath)) return;

  let content = readFileSync(configPath, 'utf-8');

  if (/^ALLOWED_USER_IDS=/m.test(content)) {
    content = content.replace(/^ALLOWED_USER_IDS=.*$/m, `ALLOWED_USER_IDS=${userId}`);
  } else {
    content += `\nALLOWED_USER_IDS=${userId}\n`;
  }

  writeFileSync(configPath, content, 'utf-8');
}
