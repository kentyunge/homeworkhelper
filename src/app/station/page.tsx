import type { Viewport } from "next";
import { StationView } from "./station-view";

export const metadata = { title: "Desk station" };

// The HyperPixel screen is small and touch-only: no zooming, no text selection.
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, themeColor: "#0d1424" };

/** The desk station's screen. Signs in with the station's own token (from the Pi), not a person's login. */
export default function StationPage() {
  return <StationView />;
}
