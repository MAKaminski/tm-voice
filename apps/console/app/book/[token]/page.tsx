import { type BookPage, apiGet } from "@/lib/api";
import { BookingForm } from "./BookingForm";

export const dynamic = "force-dynamic";

export default async function Book({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const page = await apiGet<BookPage>(`/book/${encodeURIComponent(token)}`);
  if (!page) {
    return (<><h1>Link not valid</h1><p className="lede">This scheduling link is invalid or has expired. Reply to the email you received and we will send a fresh one.</p></>);
  }
  const addr = page.addresses[0];
  return (
    <>
      <h1>Schedule your walkthrough{page.contact.first_name ? `, ${page.contact.first_name}` : ""}</h1>
      <p className="lede">{addr ? `${addr.line1}${addr.city ? `, ${addr.city}` : ""}${addr.state ? ` ${addr.state}` : ""}` : "No service address on file"} · Times shown in Eastern.</p>
      {addr && page.slots.length ? <BookingForm token={token} serviceAddressId={addr.id} slots={page.slots} /> : (
        <div className="empty">No openings in the next 14 days. We will reach out to schedule directly.</div>
      )}
    </>
  );
}
