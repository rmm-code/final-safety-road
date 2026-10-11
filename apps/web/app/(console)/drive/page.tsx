import type { Metadata } from "next";
import { CrossOriginIsolation } from "@/components/cross-origin-isolation";
import { getAppConfig } from "@/lib/config";
import { DriveView } from "@/features/drive/drive-view";

export const metadata: Metadata = {
  title: "Live drive",
  description: "Detect potholes from a windshield-mounted phone while driving.",
};

export default function DrivePage() {
  return (
    <CrossOriginIsolation>
      <DriveView config={getAppConfig()} />
    </CrossOriginIsolation>
  );
}
