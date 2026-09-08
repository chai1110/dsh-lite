// src/config.ts — dshLite.* 配置读取封装。
// 字段与 package.json 的 contributes.configuration 一一对应，默认值也保持一致。
// M0 只提供读取能力，实际消费者在 M1+（连接层/输入框行为）。
import * as vscode from 'vscode';

export type ComposerEnterBehavior = 'send' | 'newline';
export type FollowUpQueueMode = 'queue' | 'steer';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AdvancedConfig {
  /** 固定监听端口，被占用时由连接层回退（M1）。 */
  port: number;
  logLevel: LogLevel;
}

export interface DshLiteConfig {
  /** 空串表示自动探测 dsh 可执行文件。 */
  executablePath: string;
  autoStart: boolean;
  openOnStartup: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  followUpQueueMode: FollowUpQueueMode;
  /** 多根工作区时用第几个根作为会话 cwd。 */
  workspaceRootIndex: number;
  advanced: AdvancedConfig;
}

/** 读取当前生效的配置快照。配置变更后需重新调用，不要缓存结果。 */
export function getConfig(): DshLiteConfig {
  const cfg = vscode.workspace.getConfiguration('dshLite');
  return {
    executablePath: cfg.get<string>('executablePath', ''),
    autoStart: cfg.get<boolean>('autoStart', true),
    openOnStartup: cfg.get<boolean>('openOnStartup', false),
    composerEnterBehavior: cfg.get<ComposerEnterBehavior>('composerEnterBehavior', 'send'),
    followUpQueueMode: cfg.get<FollowUpQueueMode>('followUpQueueMode', 'queue'),
    workspaceRootIndex: cfg.get<number>('workspaceRootIndex', 0),
    advanced: {
      port: cfg.get<number>('advanced.port', 3082),
      logLevel: cfg.get<LogLevel>('advanced.logLevel', 'info'),
    },
  };
}
