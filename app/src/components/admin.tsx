"use client";
import { VendorSnapshot } from "./vendor-snapshot";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./shared/data-table";
import { AddressFields, Field } from "./fields";
import { ApiError, emptyAddress, message, request } from "@/lib/client";

type Row = Record<string, unknown> & { id: string | number };
const text = (v: unknown) => v == null ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v);
export function AdminShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return <div className="admin"><aside className="sidebar"><div className="brand">DISPATCH<br /><span className="text-[10px] font-normal">INTERNAL WORKSPACE</span></div><nav>{["vendors", "links", "shipments", "audit"].map(key => <a key={key} href={`/admin/${key}`} aria-current={path.includes(key) ? "page" : undefined}>{key[0].toUpperCase() + key.slice(1)}</a>)}</nav><button className="secondary mt-8" onClick={async () => { await request("/api/admin/auth/logout", {}); window.location.assign("/admin/login"); }}>Sign out</button></aside><main className="workspace">{children}</main></div>;
}
export function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  return <main className="vendor max-w-lg"><div className="brand">DISPATCH / INTERNAL</div><section className="panel"><h1>Welcome back.</h1><p>Sign in to manage vendor shipping.</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await request("/api/admin/auth/login", { email, password }); window.location.assign("/admin/vendors"); } catch (e) { setError(message(e)); setBusy(false); } }}><fieldset disabled={busy} className="grid gap-5"><Field label="Email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /><Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />{error && <div role="alert" className="notice error">{error}</div>}<button type="submit">{busy ? "Signing in..." : "Sign in"}</button></fieldset></form></section></main>;
}
function Modal({ title, children, onClose, busy = false }: { title: string; children: React.ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" aria-busy={busy} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}><div className="toolbar"><h2 id="dialog-title">{title}</h2><button aria-label="Close dialog" disabled={busy} onClick={onClose}>Close</button></div>{children}</dialog>;
}
export function AdminList({ section }: { section: "vendors" | "links" | "shipments" | "audit" }) {
  const [rows, setRows] = useState<Row[]>([]); const [vendors, setVendors] = useState<Row[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [revision, setRevision] = useState(0); const [vendorId, setVendorId] = useState(""); const [status, setStatus] = useState("");
  const [modal, setModal] = useState<"create" | "reveal" | null>(null); const [confirm, setConfirm] = useState<Row | null>(null); const [busy, setBusy] = useState(false); const [formError, setFormError] = useState(""); const [token, setToken] = useState(""); const [copied, setCopied] = useState(false);
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [notes, setNotes] = useState(""); const [days, setDays] = useState("7"); const [maxUses, setMaxUses] = useState(1);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]); const [companiesConfigured, setCompaniesConfigured] = useState<boolean | null>(null); const [companyId, setCompanyId] = useState("");
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const query = new URLSearchParams(); if (vendorId) query.set("vendorId", vendorId); if (status) query.set("status", status);
    request<Record<string, Row[]> | Row[]>(`/api/admin/${section}?${query}`).then(data => { if (active) setRows(Array.isArray(data) ? data : data[section] ?? data.items ?? data.events ?? []); }).catch(e => { if (e instanceof ApiError && e.status === 401) window.location.assign("/admin/login"); else if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, vendorId, status, revision]);
  useEffect(() => { if (section === "links" || section === "shipments") request<{ vendors: Row[] }>("/api/admin/vendors").then(d => setVendors(d.vendors ?? [])).catch(e => setError(message(e))); }, [section]);
  useEffect(() => {
    if (section !== "links" || modal !== "create") return;
    let active = true;
    request<{ companies: { id: string; name: string }[]; configured: boolean }>("/api/admin/companies").then(data => { if (active) { setCompanies(data.companies); setCompaniesConfigured(data.configured); } }).catch(e => { if (active) setFormError(message(e)); });
    return () => { active = false; };
  }, [section, modal]);
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFormError("");
    try {
      if (section === "vendors") { if (!name.trim()) throw new Error("Enter a vendor name."); await request("/api/admin/vendors", { name: name.trim(), contactEmail: email, notes }); setModal(null); }
      else { const data = await request<{ token: string }>("/api/admin/links", { expiresInDays: Number(days), maxUses, ...(companyId ? { bcCompanyId: companyId, bcCompanyName: companies.find(c => String(c.id) === companyId)?.name ?? "" } : {}) }); if (!data.token) throw new Error("The link was created but its token was not returned. Revoke it and create another."); setToken(data.token); setCopied(false); setModal("reveal"); }
      setRevision(n => n + 1);
    } catch(e) { setFormError(message(e)); } finally { setBusy(false); }
  }
  const keys = section === "vendors" ? ["name", "contact_email", "archived_at", "created_at"] : section === "links" ? ["id", "vendor_id", "expires_at", "use_count", "max_uses", "revoked_at"] : section === "shipments" ? ["id", "vendor_id", "status", "carrier", "service_type", "tracking_number", "created_at"] : ["event_type", "actor", "ip_address", "created_at", "shipment_id"];
  const columns: ColumnDef<Row, unknown>[] = keys.map(key => ({ accessorKey: key, header: key.replaceAll("_", " ").replace(/^./, c => c.toUpperCase()), cell: ({ row }) => { const value = row.original[key] ?? row.original[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]; return key === "status" ? <span className="badge">{text(value)}</span> : text(value); } }));
  const fullLink = token && typeof window !== "undefined" ? `${window.location.origin}/l/${encodeURIComponent(token)}` : "";
  return <><header className="toolbar"><div><div className="eyebrow">Shipping operations</div><h1>{section[0].toUpperCase() + section.slice(1)}</h1><p className="mb-0 text-sm">{section === "audit" ? "Read-only history of shipping and account activity." : `Manage ${section} in your shipping workspace.`}</p></div>{["vendors", "links"].includes(section) && <button className="primary" onClick={() => { setFormError(""); setName(""); setEmail(""); setNotes(""); setCompanyId(""); setCompanies([]); setCompaniesConfigured(null); setModal("create"); }}>Create {section === "vendors" ? "vendor" : "link"}</button>}</header>
    <div className="table-wrap"><DataTable columns={columns} data={rows} getRowId={r => String(r.id)} isLoading={loading} error={error} onRetry={() => setRevision(n => n + 1)} searchable toolbarFilters={<>{["links", "shipments"].includes(section) && <label>Vendor<select value={vendorId} onChange={e => setVendorId(e.target.value)}><option value="">All vendors</option>{vendors.map(v => <option key={v.id} value={String(v.id)}>{text(v.name)}</option>)}</select></label>}{section === "shipments" && <label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{["draft","rated","label_created","voided","expired"].map(s => <option key={s}>{s}</option>)}</select></label>}</>} emptyMessage={`No ${section} found.`} rowActions={section === "audit" ? undefined : row => section === "shipments" ? <a href={`/admin/shipments/${row.id}`}>View details</a> : <button className="secondary" disabled={Boolean((section === "vendors") ? row.archived_at ?? row.archivedAt : row.revoked_at ?? row.revokedAt)} onClick={() => { setFormError(""); setConfirm(row); }}>{(section === "vendors") ? "Archive" : "Revoke"}</button>} /></div>
    {modal === "create" && <Modal title={section === "vendors" ? "Create vendor" : "Create shipping link"} onClose={() => !busy && setModal(null)}><form onSubmit={create}><fieldset disabled={busy} className="grid gap-5">{section === "vendors" ? <><Field label="Vendor name" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /><Field label="Contact email" type="email" value={email} onChange={e => setEmail(e.target.value)} /><label>Notes<textarea value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)} /></label></> : <><div className="fields"><label>Expires in<select value={days} onChange={e => setDays(e.target.value)}>{[1,7,30].map(d => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}</select></label><Field label="Maximum labels" type="number" min={1} max={1000} step={1} required value={maxUses} onChange={e => setMaxUses(e.target.valueAsNumber)} /></div><label>Company<select value={companyId} onChange={e => setCompanyId(e.target.value)}><option value="">No company (optional)</option>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>{companiesConfigured === false && <p className="text-sm">Business Central is not connected — the company list is unavailable.</p>}</>}{formError && <div role="alert" className="notice error">{formError}</div>}<button type="submit">{busy ? "Creating..." : `Create ${section === "vendors" ? "vendor" : "link"}`}</button></fieldset></form></Modal>}
    {modal === "reveal" && <Modal title="Copy your private shipping link" onClose={() => { setToken(""); setModal(null); }}><div className="notice">This link is shown only once. Copy it now and share it directly with the vendor. Anyone with it can create labels.</div><div className="reveal">{fullLink}</div><button className="primary mt-5" onClick={async () => { try { await navigator.clipboard.writeText(fullLink); setCopied(true); } catch { setFormError("Copy is unavailable. Select the link above and copy it manually."); } }}>{copied ? "Copied" : "Copy private link"}</button>{formError && <p role="alert">{formError}</p>}</Modal>}
    {confirm && <Modal title={section === "vendors" ? "Archive this vendor?" : "Revoke this shipping link?"} onClose={() => !busy && setConfirm(null)}><p>{section === "vendors" ? "This vendor will no longer be available for new links. Existing records stay in your history." : "The vendor will no longer be able to use this link. This cannot be undone."}</p>{formError && <div role="alert" className="notice error">{formError}</div>}<div className="actions"><button className="secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { await request(`/api/admin/${section}/${confirm.id}${section === "links" ? "/revoke" : ""}`, (section === "vendors") ? { archived: true } : {}, (section === "vendors") ? "PATCH" : "POST"); setConfirm(null); setRevision(n => n + 1); } catch(e) { setFormError(message(e)); } finally { setBusy(false); } }}>{busy ? "Saving..." : "Confirm"}</button></div></Modal>}
  </>;
}
export function ShipmentDetail({ id }: { id: string }) {
  type Label = Record<string, unknown>;
  type Detail = { shipment: Row; labels?: Label[]; label?: Label };
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false);
  const [voidError, setVoidError] = useState(""); const inFlight = useRef(false);
  const endpoint = `/api/admin/shipments/${encodeURIComponent(id)}`;
  useEffect(() => {
    let active = true;
    request<Detail & Row>(endpoint).then(d => {
      if (active) { setDetail({ ...d, shipment: d.shipment ?? d }); setError(""); }
    }).catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [endpoint, retry]);
  const data = detail?.shipment;
  const labels = detail?.labels ?? (Array.isArray(data?.labels) ? data.labels as Label[] : []);
  const latest = detail?.label ?? [...labels].sort((a, b) => {
    const date = (label: Label) => Date.parse(String(label.createdAt ?? label.created_at ?? "")) || 0;
    return date(b) - date(a) || Number(b.id ?? 0) - Number(a.id ?? 0);
  })[0];
  const voided = data?.status === "voided" || Boolean(latest?.voidedAt ?? latest?.voided_at);
  const canUseLabel = data?.status === "label_created" && Boolean(latest) && !voided;
  const carrier = latest?.carrier ?? data?.carrier;
  const service = latest?.serviceType ?? latest?.service_type ?? data?.serviceType ?? data?.service_type;
  const tracking = latest?.trackingNumber ?? latest?.tracking_number ?? data?.trackingNumber ?? data?.tracking_number;
  const hasContext = [carrier, service, tracking].every(value => typeof value === "string" && value.trim());
  async function voidLabel() {
    if (inFlight.current || !canUseLabel || !hasContext) return;
    inFlight.current = true; setBusy(true); setVoidError("");
    try {
      const result = await request<Detail>(`${endpoint}/void`, {}, "POST");
      setDetail(previous => ({ ...previous, ...result, shipment: { ...previous?.shipment, ...result.shipment } }));
      setConfirm(false);
    } catch (e) {
      setVoidError(message(e));
      // Reconcile conflicts or a lost response without repeating the mutation.
      setRetry(n => n + 1);
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <><Link href="/admin/shipments">Back to shipments</Link><h1 className="mt-6">Shipment {id}</h1>
    {error ? <div role="alert" className="notice error">{error}<button className="secondary" onClick={() => setRetry(n => n + 1)}>Try again</button></div> : !data ? <p role="status">Loading shipment...</p> : <>
      <section className="panel label-actions" aria-labelledby="label-heading">
        <h2 id="label-heading">Shipping label</h2>
        {voided ? <p role="status">Label voided. The record remains in history. PDF viewing and downloading are disabled.</p> : canUseLabel ? <>
          <p>View or download the carrier label, or void it if it is no longer needed.</p>
          <div className="actions">{busy ? <><button className="secondary" disabled>View PDF</button><button className="secondary" disabled>Download PDF</button></> : <><a className="secondary" href={`${endpoint}/label.pdf?inline=1`} target="_blank" rel="noopener">View PDF</a><a className="secondary" href={`${endpoint}/label.pdf`}>Download PDF</a></>}
            <button className="danger" disabled={busy || !hasContext} onClick={() => { setVoidError(""); setConfirm(true); }}>Void label</button>
          </div>{!hasContext && <p>Carrier, service, and tracking details are required before this label can be voided.</p>}
        </> : <p>No active label is available for this shipment.</p>}
      </section>
      <VendorSnapshot value={data.shipFrom ?? data.ship_from} />
      <section className="panel"><dl className="fields">{Object.entries(data).filter(([key]) => !/token|label_pdf|password|^labels?$/i.test(key)).map(([key,value]) => <div key={key}><dt className="eyebrow">{key.replaceAll("_", " ")}</dt><dd><pre>{typeof value === "object" ? JSON.stringify(value,null,2) : text(value)}</pre></dd></div>)}</dl></section>
    </>}
    {confirm && <Modal title="Void this carrier label?" busy={busy} onClose={() => { if (!inFlight.current) setConfirm(false); }}>
      <p>Voiding the carrier label cannot be undone. The shipment record remains in history. PDF viewing and downloading will be disabled.</p>
      <dl className="label-context"><div><dt>Carrier</dt><dd>{text(carrier)}</dd></div><div><dt>Service</dt><dd>{text(service)}</dd></div><div><dt>Tracking number</dt><dd>{text(tracking)}</dd></div></dl>
      {voidError && <div role="alert" className="notice error">{voidError}</div>}
      {voided && <p role="status">This label is already voided.</p>}
      <div className="actions"><button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button className="danger" disabled={busy || !canUseLabel || !hasContext} onClick={voidLabel}>{busy ? "Voiding label..." : "Void carrier label"}</button></div>
    </Modal>}
  </>;
}
