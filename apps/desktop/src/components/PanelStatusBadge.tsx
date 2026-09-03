import type { PanelStatusDescriptor } from '../panel-status.js';

export function PanelStatusBadge({
  status,
  id,
}: {
  status: PanelStatusDescriptor;
  id: string;
}) {
  return (
    <div className="panel-status">
      <span className={`panel-status__badge panel-status__badge--${status.state}`}>
        {status.label}
      </span>
      <p className="form-hint" id={id}>
        {status.explanation}
      </p>
    </div>
  );
}
