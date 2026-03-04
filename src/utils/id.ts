import { nanoid } from 'nanoid';

/** 生成唯一的任务 ID */
export function generateTaskId(): string {
  return `task-${nanoid(10)}`;
}
