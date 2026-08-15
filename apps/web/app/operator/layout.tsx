import type { Metadata } from 'next';
import { StaffShell } from '@/components/StaffShell';

export const metadata: Metadata = { title: 'Operator ERP' };

export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell app="operator">{children}</StaffShell>;
}
