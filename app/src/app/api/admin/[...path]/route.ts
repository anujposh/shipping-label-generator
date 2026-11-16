import { NextRequest, NextResponse } from "next/server";
import { proxy } from "@/lib/proxy";
async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  const rules: [RegExp, string[]][] = [
    [/^auth\/(login|logout)$/, ["POST"]], [/^vendors$/, ["GET", "POST"]],
    [/^vendors\/[a-zA-Z0-9-]+$/, ["PATCH"]], [/^links$/, ["GET", "POST"]], [/^companies$/, ["GET"]],
    [/^links\/[a-zA-Z0-9-]+\/revoke$/, ["POST"]], [/^shipments$/, ["GET"]],
    [/^shipments\/[a-zA-Z0-9-]+$/, ["GET"]], [/^audit$/, ["GET"]],
    [/^shipments\/[a-zA-Z0-9-]+\/label\.pdf$/, ["GET"]],
    [/^shipments\/[a-zA-Z0-9-]+\/void$/, ["POST"]],
  ];
  if (!rules.some(([pattern, methods]) => pattern.test(path) && methods.includes(req.method))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return proxy(req, `/admin/${path}`);
}
export { handler as GET, handler as POST, handler as PATCH };
