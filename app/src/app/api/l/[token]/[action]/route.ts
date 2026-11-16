import { NextRequest, NextResponse } from "next/server";
import { proxy } from "@/lib/proxy";
async function handler(req: NextRequest, ctx: { params: Promise<{ token: string; action: string }> }) {
  const { token, action } = await ctx.params;
  const allowed: Record<string, string> = { status: "GET", rates: "POST", shipment: "POST", "label.pdf": "GET", documents: "GET", document: "GET", "duty-tax-estimate": "POST" };
  if (allowed[action] !== req.method || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return proxy(req, `/v1/${action}`, token);
}
export { handler as GET, handler as POST };
