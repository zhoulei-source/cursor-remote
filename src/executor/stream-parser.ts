/**
 * Cursor Agent 输出流解析器
 * 解析 cursor agent 的 stdout 输出，提取结构化信息
 */

/** 解析后的输出块类型 */
export interface IParsedChunk {
  /** 原始文本 */
  raw: string;
  /** 是否是进度信息 */
  isProgress: boolean;
  /** 提取的文件路径（如果有） */
  filePath?: string;
  /** 是否是最终输出 */
  isFinal: boolean;
}

/**
 * 从 cursor agent 输出中提取修改的文件列表
 * 解析常见的文件操作模式
 */
export function extractChangedFiles(output: string): string[] {
  const files = new Set<string>();

  // 匹配常见的文件操作模式
  const patterns = [
    // "Created file: xxx" 或 "Wrote to: xxx"
    /(?:Created|Wrote|Modified|Updated|Edited|Deleted)\s+(?:file:\s*|to:\s*)?(\S+\.\w+)/gi,
    // "Writing xxx..." 或 "Editing xxx..."
    /(?:Writing|Editing|Creating|Modifying)\s+(\S+\.\w+)/gi,
    // 路径格式：包含 / 的文件路径
    /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/gm,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const filePath = match[1];
      // 过滤掉明显不是文件路径的匹配
      if (filePath && !filePath.startsWith('http') && !filePath.includes('node_modules')) {
        files.add(filePath);
      }
    }
  }

  return [...files];
}

/**
 * 清理 ANSI 转义序列
 * cursor agent 的终端输出可能包含颜色和控制字符
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\].*?\x07/g, '');
}

/**
 * 将输出截断到合理长度
 * 飞书消息有长度限制
 */
export function truncateOutput(output: string, maxLength: number = 3000): string {
  if (output.length <= maxLength) return output;

  const head = output.slice(0, 500);
  const tail = output.slice(-maxLength + 600);
  return `${head}\n\n... (省略 ${output.length - maxLength + 100} 字符) ...\n\n${tail}`;
}
