import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin";
export default async function Layout({children}: {children: React.ReactNode}) { if (!(await cookies()).has("slg_admin")) redirect("/admin/login"); return <AdminShell>{children}</AdminShell>; }
