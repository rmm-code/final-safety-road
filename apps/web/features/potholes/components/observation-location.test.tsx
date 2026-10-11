import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ObservationLocation } from "./observation-location";

describe("observation location", () => {
  it("says a hand-placed sighting was placed by hand, not how accurate it is", () => {
    render(
      <ObservationLocation observation={{ location_source: "manual", location_accuracy_m: 100 }} />,
    );
    expect(screen.getByText("Location placed by hand")).toBeInTheDocument();
    // The pin's radius printed as "±100 m" would read as a measured GPS fix.
    expect(screen.queryByText(/±/)).not.toBeInTheDocument();
    expect(screen.queryByText(/gps/i)).not.toBeInTheDocument();
  });

  it("shows a GPS sighting's own accuracy", () => {
    render(
      <ObservationLocation observation={{ location_source: "gps", location_accuracy_m: 8.4 }} />,
    );
    expect(screen.getByText("GPS ±8 m")).toBeInTheDocument();
    expect(screen.queryByText(/placed by hand/i)).not.toBeInTheDocument();
  });
});
