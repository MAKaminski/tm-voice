export default function Review() {
  return (<><h1>Review queue</h1><p className="lede">Approve / reject lands in Phase 4. Pending bookings are listed on the dashboard; approve via <code>POST /bookings/:id/review</code> for now.</p></>);
}
