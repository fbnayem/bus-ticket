import type { Metadata } from 'next';
import { StaffShell } from '@/components/StaffShell';

export const metadata: Metadata = { title: 'Agent Portal' };

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell app="agent">{children}</StaffShell>;
}
