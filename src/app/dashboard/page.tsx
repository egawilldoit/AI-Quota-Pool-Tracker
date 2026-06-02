import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function DashboardPage() {
  return <DashboardClient />;
}
