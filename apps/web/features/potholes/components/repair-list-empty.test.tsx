import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RepairListEmpty } from "./repair-list-empty";

describe("empty repair list", () => {
  it("says nothing is recorded yet when no filter is applied", () => {
    render(<RepairListEmpty filtered={false} />);
    expect(screen.getByText("No potholes recorded yet")).toBeInTheDocument();
    // "Choose All" is wrong advice when All is already chosen.
    expect(screen.queryByText(/choose all/i)).not.toBeInTheDocument();
  });

  it("points at the filter when a severity filter hides everything", () => {
    render(<RepairListEmpty filtered />);
    expect(screen.getByText("No potholes match these filters")).toBeInTheDocument();
    expect(screen.getByText(/choose all/i)).toBeInTheDocument();
  });
});
