import handler from "vinext/server/app-router-entry";

interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const LOCATIONS = {
  chennai: { latitude: 13.084346, longitude: 80.227325 },
  calcutta: { latitude: 22.525298, longitude: 88.361538 },
} as const;

const RADIUS_NM = 20;

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const deltaLatitude = toRadians(lat2 - lat1);
  const deltaLongitude = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getFlights(request: Request) {
  const requestUrl = new URL(request.url);
  const requestedCity = requestUrl.searchParams.get("city") ?? "chennai";
  const city = requestedCity in LOCATIONS ? requestedCity as keyof typeof LOCATIONS : "chennai";
  const location = LOCATIONS[city];
  const upstreamUrl = `https://api.airplanes.live/v2/point/${location.latitude}/${location.longitude}/${RADIUS_NM}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      return Response.json(
        { error: "The live aircraft feed is temporarily unavailable." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const payload = await upstream.json() as { ac?: Array<Record<string, unknown>> };
    const now = Date.now();
    const flights = (payload.ac ?? [])
      .filter((aircraft) =>
        typeof aircraft.lat === "number" &&
        typeof aircraft.lon === "number" &&
        aircraft.alt_baro !== "ground" &&
        (typeof aircraft.seen_pos !== "number" || aircraft.seen_pos < 60),
      )
      .map((aircraft) => {
        const latitude = aircraft.lat as number;
        const longitude = aircraft.lon as number;
        const seenSeconds = typeof aircraft.seen_pos === "number" ? aircraft.seen_pos : 0;
        return {
          id: String(aircraft.hex ?? `${latitude}-${longitude}`),
          callsign: String(aircraft.flight ?? aircraft.r ?? aircraft.hex ?? "Aircraft").trim(),
          registration: typeof aircraft.r === "string" ? aircraft.r.trim() : "Live ADS-B",
          aircraftType: typeof aircraft.t === "string" ? aircraft.t.trim() : "Aircraft",
          altitudeFeet: typeof aircraft.alt_baro === "number" ? Math.round(aircraft.alt_baro) : null,
          groundSpeedKnots: typeof aircraft.gs === "number" ? aircraft.gs : 0,
          trackDegrees: typeof aircraft.track === "number" ? aircraft.track : 0,
          latitude,
          longitude,
          positionTime: now - seenSeconds * 1000,
          distanceKm: distanceKm(location.latitude, location.longitude, latitude, longitude),
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 8);

    return Response.json(
      {
        city,
        center: location,
        radiusKm: RADIUS_NM * 1.852,
        updatedAt: now,
        source: "airplanes.live",
        flights,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "The live aircraft feed could not be reached." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

const worker = {
  async fetch(request: Request, env: WorkerEnv, context: WorkerContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/flights") return getFlights(request);
    return handler.fetch(request, env, context);
  },
};

export default worker;
