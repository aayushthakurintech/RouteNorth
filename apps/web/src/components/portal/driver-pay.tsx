"use client";
/** The Pay and Money tabs of a driver. Filled in by the pay module. */
export function DriverPay({ id }: { id: string }) {
  return <p className="text-sm text-muted-foreground" data-driver={id}>Pay details appear here once rate cards are set up.</p>;
}
