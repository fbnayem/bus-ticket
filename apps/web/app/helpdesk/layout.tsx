import type { Metadata } from 'next';
import { StaffShell } from '@/components/StaffShell';

export const metadata: Metadata = { title: 'Support Console' };

export default function HelpdeskLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell app="helpdesk">{children}</StaffShell>;
}
