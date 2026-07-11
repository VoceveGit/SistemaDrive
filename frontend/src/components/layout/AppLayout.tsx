// frontend/src/components/layout/AppLayout.tsx

import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useSocket } from "../../hooks/useSocket";

export function AppLayout() {
  useSocket();
  const sidebarWidth = "15rem";

  return (
    <div className="min-h-screen bg-bg-base">
      <Sidebar />
      <Header sidebarWidth={sidebarWidth} />
      <main className="min-h-screen pt-16" style={{ marginLeft: sidebarWidth }}>
        <div className="p-6">{<Outlet />}</div>
      </main>
    </div>
  );
}
