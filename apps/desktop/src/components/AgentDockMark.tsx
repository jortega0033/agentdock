export interface AgentDockMarkProps {
  className?: string;
  label?: string;
}

/** Themeable inline copy of the canonical Dock Gate mark in assets/brand. */
export function AgentDockMark({ className, label }: AgentDockMarkProps) {
  const labelled = !!label;
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role={labelled ? 'img' : undefined}
      aria-label={label}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      <path d="M8 14h14v7h-7v22h7v7H8V14Zm48 0H42v7h7v22h-7v7h14V14Z" fill="currentColor" />
      <path d="m32 16 9 5.5v11L32 38l-9-5.5v-11L32 16Z" fill="currentColor" />
      <rect x="28" y="44" width="8" height="6" rx="2" fill="currentColor" />
    </svg>
  );
}
