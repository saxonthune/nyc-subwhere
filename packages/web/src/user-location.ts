// Browser side of the user-location marker: a geolocation watch plus the
// device compass, both throttled so a live marker costs a repaint every few
// seconds rather than a 60 Hz render loop, and both suspended while the tab
// is hidden (a backgrounded GPS watch is the classic battery drain).

export interface LocationUpdate {
  lngLat: [number, number];
  headingDeg: number | null;
}

const DEG2RAD = Math.PI / 180;
// A position fix applies only after this long AND this far from the last one
// applied; a stationary user needs no repaints at all.
const POSITION_MIN_MS = 3000;
const POSITION_MIN_M = 3;
// Compass events arrive at ~60 Hz; apply one only on a visible turn.
const HEADING_MIN_MS = 200;
const HEADING_MIN_DEG = 3;

export class UserLocationTracker {
  active = false;
  private watchId: number | null = null;
  // Event name resolved at enable(): iOS "deviceorientation" (behind its
  // gesture-gated permission), elsewhere "deviceorientationabsolute"; empty
  // when the platform has no compass (desktop) — the marker stays a bare disc.
  private orientationEvent = "";
  private lastFix: { lng: number; lat: number; at: number } | null = null;
  private headingDeg: number | null = null;
  private lastHeadingAt = 0;

  constructor(
    private readonly onUpdate: (u: LocationUpdate | null) => void,
    private readonly onDenied: () => void,
  ) {
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  // Must be called from a user gesture: iOS only grants the compass
  // permission when requestPermission() runs inside one, so it is asked
  // before any other await could break the gesture chain.
  async enable(): Promise<void> {
    if (this.active) return;
    if (!("geolocation" in navigator)) {
      this.onDenied();
      return;
    }
    this.active = true;
    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof doe.requestPermission === "function") {
      try {
        if ((await doe.requestPermission()) === "granted")
          this.orientationEvent = "deviceorientation";
      } catch {
        // Compass denied or unavailable; position alone still works.
      }
    } else if ("ondeviceorientationabsolute" in window) {
      this.orientationEvent = "deviceorientationabsolute";
    }
    this.startSensors();
  }

  disable(): void {
    if (!this.active) return;
    this.stopSensors();
    this.active = false;
    this.orientationEvent = "";
    this.lastFix = null;
    this.headingDeg = null;
    this.onUpdate(null);
  }

  private startSensors(): void {
    this.watchId = navigator.geolocation.watchPosition(
      this.onFix,
      this.onFixError,
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    if (this.orientationEvent)
      window.addEventListener(
        this.orientationEvent,
        this.onOrientation as EventListener,
      );
  }

  private stopSensors(): void {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    if (this.orientationEvent)
      window.removeEventListener(
        this.orientationEvent,
        this.onOrientation as EventListener,
      );
  }

  // Suspend the sensors while hidden but keep the marker state, so returning
  // to the tab resumes silently where it left off.
  private readonly onVisibility = () => {
    if (!this.active) return;
    if (document.hidden) this.stopSensors();
    else this.startSensors();
  };

  private readonly onFix = (pos: GeolocationPosition) => {
    const { longitude: lng, latitude: lat } = pos.coords;
    const now = performance.now();
    const last = this.lastFix;
    if (last) {
      if (now - last.at < POSITION_MIN_MS) return;
      const dLat = (lat - last.lat) * 111320;
      const dLng = (lng - last.lng) * 111320 * Math.cos(lat * DEG2RAD);
      if (Math.hypot(dLat, dLng) < POSITION_MIN_M) return;
    }
    this.lastFix = { lng, lat, at: now };
    this.emit();
  };

  private readonly onFixError = (err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) {
      this.disable();
      this.onDenied();
    }
  };

  private readonly onOrientation = (e: DeviceOrientationEvent) => {
    // iOS reports true compass heading directly; the absolute-orientation
    // fallback derives it from alpha, corrected for how the screen is turned
    // relative to the device. Approximate when the device is far from flat or
    // upright — good enough to aim an arrowhead.
    const webkit = (e as { webkitCompassHeading?: number })
      .webkitCompassHeading;
    let heading: number | null = null;
    if (typeof webkit === "number") heading = webkit;
    else if (e.alpha != null)
      heading = (360 - e.alpha + (screen.orientation?.angle ?? 0)) % 360;
    if (heading == null) return;
    const now = performance.now();
    if (this.headingDeg != null) {
      if (now - this.lastHeadingAt < HEADING_MIN_MS) return;
      const d = Math.abs(heading - this.headingDeg);
      if (Math.min(d, 360 - d) < HEADING_MIN_DEG) return;
    }
    this.headingDeg = heading;
    this.lastHeadingAt = now;
    this.emit();
  };

  // The marker needs a position before anything shows; heading-only updates
  // wait for the first fix.
  private emit(): void {
    if (!this.lastFix) return;
    this.onUpdate({
      lngLat: [this.lastFix.lng, this.lastFix.lat],
      headingDeg: this.headingDeg,
    });
  }
}
