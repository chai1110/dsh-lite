// webview/components/topbar.tsx — 顶栏（logo + 会话名 + 连接点 + ＋新建）。
import { useState, type ReactElement } from 'react';

import type { ModelGroupUi } from '../../src/panel/protocol';
import { Icon } from '../lib/codicon';
import { connectionStateClass } from '../lib/util';

interface TopbarProps {
  ready: boolean;
  activeTitle: string;
  connection: string;
  onToggleDropdown: () => void;
  onNewSession: () => void;
  /** M16：模型目录与当前模型（undefined=未拉取） */
  models?: ModelGroupUi[] | null;
  modelsError?: string | null;
  currentModel?: { provider: string; model: string } | null;
  onModelSelect: (provider: string, model: string) => void;
}

export function Topbar(props: TopbarProps): ReactElement {
  const {
    ready,
    activeTitle,
    connection,
    onToggleDropdown,
    onNewSession,
    models,
    modelsError,
    currentModel,
    onModelSelect,
  } = props;
  // M16：模型选择下拉（独立于会话历史下拉）
  const [modelOpen, setModelOpen] = useState(false);
  const currentLabel = currentModel
    ? modelShortName(currentModel.model)
    : models
      ? '选择模型'
      : '模型…';
  // M9b：宿主注入的品牌 logo URL（assets/icon.svg）；扩展未携带图标时为空（UI 回退 codicon）
  const brandLogo: string | undefined = (window as { DSH_LOGO?: string }).DSH_LOGO;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="btn session-btn"
          type="button"
          title={ready ? '点开查看全部历史会话 / 切换会话' : '查看历史会话（当前未就绪）'}
          onClick={onToggleDropdown}
        >
          {brandLogo ? (
            <img className="brand-logo" src={brandLogo} alt="DSH Lite" />
          ) : (
            <span className="brand-mark">
              <Icon n="comment-discussion" />
            </span>
          )}
          <span className="session-btn-title">{ready ? activeTitle : 'DSH Lite'}</span>
          {/* M13.3：历史入口对齐 Codex —— 时钟历史图标，点开展开全部会话 */}
          <Icon n="history" />
        </button>
      </div>
      <div className="topbar-right">
        <button
          className="btn model-btn"
          type="button"
          disabled={!ready}
          title={modelsError ? `模型目录拉取失败：${modelsError}（点按重试）` : '选择模型'}
          onClick={() => {
            setModelOpen((v) => !v);
            if (!models && !modelsError) onModelSelect('__fetch__', '');
          }}
        >
          <Icon n="circuit-board" />
          <span className="model-btn-label">{modelsError ? '模型!' : currentLabel}</span>
          <Icon n="chevron-down" />
        </button>
        <span
          className={`conn-dot ${connectionStateClass(connection)}`}
          title={`连接：${connection}`}
        />
        <button
          className="btn btn-icon btn-new"
          type="button"
          disabled={!ready}
          title="新建会话"
          onClick={onNewSession}
        >
          <Icon n="add" />
        </button>
        {modelOpen ? (
          <div className="model-dropdown" role="listbox">
            {modelsError ? (
              <div className="model-group-name model-error">{modelsError}</div>
            ) : models == null ? (
              <div className="model-group-name model-error">模型目录拉取中…</div>
            ) : (
              models.map((g) => (
                <div key={g.id} className="model-group">
                  <div className="model-group-name">{g.name}</div>
                  {g.models.map((m) => {
                    const selected = currentModel?.provider === g.id && currentModel?.model === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`model-option${selected ? ' selected' : ''}`}
                        onClick={() => {
                          setModelOpen(false);
                          if (!selected) onModelSelect(g.id, m.id);
                        }}
                      >
                        <span className="model-option-name">{m.name}</span>
                        {selected ? <span className="model-check">✓</span> : null}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** 模型 id → 短名（去掉供应商前缀噪音，如 deepseek-flash → DeepSeek V4.1 Flash 由目录 name 承担；
 *  这里兜底取 id 尾段）。 */
function modelShortName(model: string): string {
  const seg = model.split('-');
  return seg.slice(-2).join('-');
}
