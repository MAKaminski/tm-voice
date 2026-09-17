import { type Campaign, type PendingBooking, apiGet } from "@/lib/api";
import { ReviewQueue } from "./ReviewQueue";

export const dynamic = "force-dynamic";

export default async function Review() {
  const [pending, campaigns] = await Promise.all([
    apiGet<{ bookings: PendingBooking[] }>("/bookings?status=pending_review", { internal: true }),
    apiGet<{ campaigns: Campaign[] }>("/campaigns", { internal: true }),
  ]);

  // apiGet swallows failures and returns null, which on this page would look identical to an empty
  // queue — and "nothing to approve" is the one wrong thing to tell a reviewer when the api is down.
  if (!pending || !campaigns) {
    return (
      <>
        <h1>Review queue</h1>
        <div className="empty bad">
          Could not reach the api. This is not an empty queue — do not assume there is nothing to approve.
        </div>
      </>
    );
  }

  return <ReviewQueue pending={pending.bookings} campaigns={campaigns.campaigns} />;
}
