/**
 * An empty repair list means one of two things, and the advice differs: nothing has been
 * recorded yet, or the severity filter hides everything that has been.
 */
export function RepairListEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-[14px] font-medium text-primary">
        {filtered ? "No potholes match these filters" : "No potholes recorded yet"}
      </p>
      <p className="mt-1 text-[13px] text-muted">
        {filtered ? "Choose All to see every severity." : "Start a live drive and they appear here."}
      </p>
    </div>
  );
}
