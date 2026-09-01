import markUrl from '../../assets/brand/agent-dock-mark.svg';

export interface AgentDockMarkProps {
  className?: string;
  label?: string;
}

/** The checked-in brand asset is the single source of truth for the in-app mark. */
export function AgentDockMark({ className, label }: AgentDockMarkProps) {
  const labelled = !!label;
  return (
    <img
      className={className}
      src={markUrl}
      alt={label ?? ''}
      aria-hidden={labelled ? undefined : true}
      draggable={false}
    />
  );
}
