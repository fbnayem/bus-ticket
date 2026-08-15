import type { Metadata } from 'next';
import { StaffShell } from '@/components/StaffShell';

export const metadata: Metadata = { title: 'Admin Console' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell app="admin">{children}</StaffShell>;
}
