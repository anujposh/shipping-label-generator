import { VendorFlow } from "@/components/vendor-flow";
export default async function Page({ params }: { params: Promise<{ token: string }> }) { const { token } = await params; return <VendorFlow token={token} view="shipment" />; }
