// src/panel/errors.ts — 连接层错误码 → 展示文案（工作稿；M5 打磨 i18n）
import type { LiteErrorCode } from '../model';

const ERROR_TEXT: Record<LiteErrorCode, string> = {
  'err.dshNotFound': '未找到 dsh，请安装或将路径填入 dshLite.executablePath',
  'err.nodeNotFound': '未找到 node.exe（请检查 PATH）',
  'err.spawnEinval': '启动参数无效，请重试',
  'err.portOccupied': '端口全部被占用，请释放端口后重试',
  'err.startTimeout': 'dsh 启动超时，请重试',
  'err.startCrashed': 'dsh 启动后崩溃，请查看日志',
  'err.tokenParse': '未能取得启动令牌，请重试',
  'err.cookieExchange': '认证交换失败，请重试',
  'err.wsUnreachable': '连接断开且自动重连失败，请点击重连',
  'err.connectionLost': '已与 dsh 断开，点击重连可重新拉起',
};

export function describeErr(code: LiteErrorCode | string): string {
  return ERROR_TEXT[code as LiteErrorCode] ?? code;
}

/** 阶段 → 状态条主文案（工作稿） */
export function describePhase(phase: string): string {
  switch (phase) {
    case 'idle':
      return '未连接';
    case 'connecting':
      return '连接中…';
    case 'ready':
      return '已连接';
    case 'error':
      return '连接出错';
    case 'offline':
      return '已断开';
    default:
      return phase;
  }
}
