import type { Metadata } from 'next';
import { StaffShell } from '@/components/StaffShell';

export const metadata: Metadata = { title: 'Driver & Crew' };

export default function DriverLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell app="driver">{children}</StaffShell>;
}
