import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DemoModeBanner } from '../src/components/DemoModeBanner.js';

describe('DemoModeBanner', () => {
  it('renders the fixed warning copy and no dismiss control other than Exit demo', () => {
    render(<DemoModeBanner onExit={() => {}} />);
    expect(
      screen.getByText(
        'Demo mode — every session, provider, and event on this screen is sample data. Nothing here reflects a real daemon, provider, or workspace.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('calls onExit when Exit demo is clicked', () => {
    const onExit = vi.fn();
    render(<DemoModeBanner onExit={onExit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Exit demo' }));
    expect(onExit).toHaveBeenCalledOnce();
  });
});
