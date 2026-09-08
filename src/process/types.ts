// src/process/types.ts — 探测/进程层共享类型（纯模块，不依赖 vscode）
/** 探测结果：dsh=免鉴权旧版，dsh-auth=新版带令牌鉴权，foreign=非 DSH 占用，down=空闲 */
export type ProbeResult = 'dsh' | 'dsh-auth' | 'foreign' | 'down';

/** 服务层对外快照（docs/api/connection.md §3） */
export type ServiceState = 'idle' | 'detecting' | 'starting' | 'waiting' | 'ready' | 'failed' | 'stopping';

export interface ServiceSnapshot {
  state: ServiceState;
  /** 自启实例 stdout 解析出的带 ?token= 就绪地址（ready 后有值；供换 cookie 与日志） */
  authUrl: string | null;
  /** 实际使用的端口（含回退结果） */
  port: number;
  /** 失败原因 code（仅 failed 时有值） */
  errorCode: string | null;
  /** 由插件自起并持有（本设计恒为 true，保留字段便于断言与日志） */
  owned: boolean;
}

export type ServiceErrorCode =
  | 'dshNotFound'
  | 'nodeNotFound'
  | 'spawnEinval'
  | 'portOccupied'
  | 'startTimeout'
  | 'startCrashed'
  | 'tokenParse';
