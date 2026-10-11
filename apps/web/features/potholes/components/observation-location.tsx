import { Badge } from "@/components/ui";
import type { PotholeObservation } from "@/lib/api-client";

/**
 * How one sighting was located, in the place its GPS accuracy is shown.
 *
 * A point an operator placed by hand is not a GPS fix. Its accuracy is the radius given to
 * the pin, and printing that as "±100 m" would pass the point off as measured, so a manual
 * sighting says what it is instead.
 */
export function ObservationLocation({
  observation,
}: {
  observation: Pick<PotholeObservation, "location_source" | "location_accuracy_m">;
}) {
  if (observation.location_source === "manual") {
    return <Badge>Location placed by hand</Badge>;
  }
  return (
    <span className="whitespace-nowrap font-mono tabular-nums text-secondary">
      GPS ±{Math.round(observation.location_accuracy_m)} m
    </span>
  );
}
