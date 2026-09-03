export function DemoModeBanner({ onExit }: { onExit: () => void }) {
  return (
    <div className="demo-banner" role="status">
      <span>
        Demo mode — every session, provider, and event on this screen is sample data. Nothing here
        reflects a real daemon, provider, or workspace.
      </span>
      <button className="button button--primary" type="button" onClick={onExit}>
        Exit demo
      </button>
    </div>
  );
}
