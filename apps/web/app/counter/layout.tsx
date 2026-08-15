import type { Metadata } from 'next';
import { StaffShell } from '@/components/StaffShell';
import { CounterServiceWorker } from '@/components/CounterServiceWorker';

export const metadata: Metadata = { title: 'Counter POS' };

export default function CounterLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffShell app="counter">
      <CounterServiceWorker />
      {children}
    </StaffShell>
  );
}
